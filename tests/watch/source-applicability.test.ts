import { displayReportPrice } from '../../src/costco/warehouse-display-client.js';
import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_CONFIG } from '../../src/config/config.js';
import { makeSources, type SourceOptions } from '../../src/watch/sources.js';
import { parseDisplayedPrice } from '../../src/costco/online-page.js';
import { item } from './helpers.js';

const price = {
  cents: 1749,
  reason: null,
  memberOnly: false,
  name: 'TEST-Item',
  url: null,
};
const signedIn = () =>
  vi.fn(async () => ({ prices: new Map(), diagnostic: null }));
const offline = (options: SourceOptions = {}): SourceOptions => ({
  now: () => new Date('2026-10-24T16:00:00Z'),
  api: async () => new Map([[item.itemNumber, price]]),
  publicPage: async () => null,
  savings: async () => null,
  warehousePrice: async () => new Map(),
  warehouseGraphql: async () => new Map(),
  fetchFn: vi.fn(async () => {
    throw new Error('TEST-Unexpected fetch');
  }) as typeof fetch,
  ...options,
});

describe('source applicability and profile isolation', () => {
  it.each([true, false])(
    'fills names from already-fetched pages only for matching item identity (%s)',
    async (matches) => {
      const publicPage = vi.fn(async () => ({
        html: `<title>TEST-Page butter | Costco</title><div>Item ${matches ? item.itemNumber : '777777'}</div>`,
        url: item.url,
      }));
      const source = await makeSources(
        DEFAULT_CONFIG,
        offline({
          api: async () => new Map(),
          publicPage,
        }),
      )([item]);
      expect(source.productNames?.get(item.id)).toBe(
        matches ? 'TEST-Page butter' : undefined,
      );
      expect(publicPage).toHaveBeenCalledOnce();
    },
  );
  it.each([false, true])(
    'ignores all prices for warehouse-only products (API metadata: %s)',
    async (apiOnly) => {
      const signed = signedIn();
      const source = makeSources(
        DEFAULT_CONFIG,
        offline({
          api: async () =>
            new Map([[item.itemNumber, { ...price, warehouseOnly: apiOnly }]]),
          publicPage: async () =>
            apiOnly
              ? null
              : {
                  html: `<div>Warehouse Only</div><h1>TEST-Butter</h1><p>Item ${item.itemNumber}</p><div>Warehouse Price</div><div>$14.99</div><p>How To Get It</p><div>TEST-Other warehouse</div><div>Warehouse Price</div><div>$</div><div>14.99</div>`,
                  url: item.url,
                },
          signedIn: signed,
        }),
      );
      const result = await source([item]);
      expect(result.observations[0]).toMatchObject({
        cents: null,
        reason: 'warehouse_only',
        evidence: { apiCents: null, displayedCents: null },
      });
      expect(result.session).toBe('not_required');
      expect(signed).not.toHaveBeenCalled();
    },
  );

  it.each([1749, null])(
    'never opens the profile for missing ungated public display data (API cents: %s)',
    async (cents) => {
      const signed = signedIn();
      const source = makeSources(
        DEFAULT_CONFIG,
        offline({
          api: async () => new Map([[item.itemNumber, { ...price, cents }]]),
          signedIn: signed,
        }),
      );
      const result = await source([item]);
      expect(result.observations[0].cents).toBe(cents);
      expect(result.session).toBe('not_required');
      expect(signed).not.toHaveBeenCalled();
    },
  );

  it('accepts a public member price despite generic navigation and avoids profile fallback', async () => {
    const signed = signedIn();
    const result = await makeSources(
      DEFAULT_CONFIG,
      offline({
        api: async () =>
          new Map([[item.itemNumber, { ...price, memberOnly: true }]]),
        publicPage: async () => ({
          html: `Sign In / Register\nItem ${item.itemNumber}\nMember Price $14.99`,
          url: item.url,
        }),
        signedIn: signed,
      }),
    )([item]);
    expect(result.observations[0]).toMatchObject({
      cents: 1499,
      source: 'costco_public_product_page',
    });
    expect(result.session).toBe('not_required');
    expect(signed).not.toHaveBeenCalled();
  });

  it.each([
    ['Sign In / Register\nYour Price $14.99', 'not_required', 1499],
    ['Sign Out\nYour Price $14.99', 'authenticated', 1499],
    ['Sign in to see price', 'signed_out', null],
    ['Sign In / Register', 'not_required', 1749],
  ] as const)(
    'only opens the profile for a price gate, then classifies %s',
    async (text, session, cents) => {
      const signed = vi.fn(async () => ({
        prices: new Map([
          [
            item.itemNumber,
            parseDisplayedPrice(
              `Item ${item.itemNumber}\n${text}`,
              item.itemNumber,
            ),
          ],
        ]),
        diagnostic: null,
      }));
      const result = await makeSources(
        DEFAULT_CONFIG,
        offline({
          publicPage: async () => ({
            html: `Item ${item.itemNumber}\nSign in to see price`,
            url: item.url,
          }),
          signedIn: signed,
        }),
      )([item]);
      expect(signed).toHaveBeenCalledWith([item]);
      expect(result.session).toBe(session);
      expect(result.observations[0].cents).toBe(cents);
    },
  );

  it('does not claim session expiry when a gated browser lookup fails', async () => {
    const result = await makeSources(
      DEFAULT_CONFIG,
      offline({
        publicPage: async () => ({
          html: `Item ${item.itemNumber}\nSign in to see price`,
          url: item.url,
        }),
        signedIn: signedIn(),
      }),
    )([item]);
    expect(result.session).toBe('unknown');
    expect(result.observations[0].cents).toBeNull();
  });
  it('does not accept a reference price still visible next to an unresolved public price gate', async () => {
    const result = await makeSources(
      DEFAULT_CONFIG,
      offline({
        publicPage: async () => ({
          html: `Item ${item.itemNumber}\nOnline Price $17.49\nSign in to see price`,
          url: item.url,
        }),
        signedIn: signedIn(),
      }),
    )([item]);
    expect(result.observations[0].cents).toBeNull();
    expect(result.session).toBe('unknown');
  });

  it.each([null, 1499])(
    'prefers scoped warehouse display prices and retains explicit net savings (%s)',
    async (final) => {
      const warehousePrice = vi.fn(
        async () =>
          new Map([
            [
              item.itemNumber,
              displayReportPrice(
                {
                  cents: 1999,
                  reason: null,
                  warehouseNumber: '222',
                  baseCents: 1999,
                  deliveredCents: 1999,
                  discountCents: 0,
                  currency: 'USD',
                  unitBasis: 'unknown' as const,
                  promotions: [],
                  promoEnd: null,
                },
                '2026-10-24T16:00:00Z',
              ),
            ],
          ]),
      );
      const result = await makeSources(
        { ...DEFAULT_CONFIG, watchWarehouseNumber: '222' },
        offline({
          warehousePrice,
          savings: async () =>
            final === null
              ? null
              : `<article data-item-number="${item.itemNumber}" data-applicability="warehouse" data-start-date="2026-10-20" data-end-date="2026-11-15" data-final-price="14.99">$14.99 After $5 OFF</article>`,
        }),
      )([{ ...item, channel: 'warehouse' }]);
      expect(warehousePrice).toHaveBeenCalledWith([item.itemNumber], '222');
      expect(result.observations[0]).toMatchObject({
        kind: 'warehouse',
        cents: final ?? 1999,
        source:
          final === null
            ? 'warehouse_display_price_api'
            : 'warehouse_savings_page',
        promoEnd: final === null ? null : '2026-11-15',
        evidence: {
          warehouseNumber: '222',
          deliveredCents: 1999,
          bookletFinalCents: final,
        },
      });
      expect(result.observations[1].cents).toBeNull();
    },
  );
});
