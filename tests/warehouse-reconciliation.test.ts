import { describe, expect, it, vi } from 'vitest';
import {
  fetchReportPriceEvidence,
  resolveWarehousePriceEvidence,
  type PriceRequest,
} from '../src/costco/price-client.js';
import {
  savingsReportPrice,
  parseSavingsForItem,
} from '../src/costco/warehouse-savings.js';
import { isUsableReportPriceEvidence } from '../src/core/price-evidence.js';
import { probeWarehouseCoverage } from '../src/costco/warehouse-coverage-probe.js';
import type { ReportPriceObservation } from '../src/domain/types.js';

const now = () => new Date('2026-10-24T12:00:00Z');
const request = (
  itemNumber = '900001',
  warehouseNumber = '123',
): PriceRequest => ({
  itemNumber,
  warehouseNumber,
  purchaseChannel: 'warehouse',
});
const card = (attributes = '', text = '$17.00 after $3.00 OFF') =>
  `<article data-item-number="900001" data-applicability="warehouse" data-start-date="2026-10-01" data-end-date="2026-10-31" ${attributes}>${text}</article>`;
const booklet = (html = card('data-final-price="17.00"')) =>
  savingsReportPrice(html, '900001', '123', now());
const display = (
  overrides: Partial<
    NonNullable<ReportPriceObservation['warehouseEvidence']>
  > = {},
): ReportPriceObservation => ({
  channel: 'warehouse_display',
  unitPriceCents: 2000,
  unavailableReason: null,
  source: 'warehouse_display_price_api',
  observedAt: now().toISOString(),
  promotionText: null,
  warehouseEvidence: {
    warehouseNumber: '123',
    unitBasis: 'each',
    baseCents: 2000,
    discountCents: 0,
    deliveredCents: 2000,
    quotationCents: 2000,
    promoEnd: null,
    ...overrides,
  },
});
const wh: ReportPriceObservation = {
  channel: 'warehouse',
  unitPriceCents: 1000,
  unavailableReason: null,
  source: 'warehouse-price-api',
  observedAt: now().toISOString(),
  promotionText: null,
};
const reconcile = (
  d: ReportPriceObservation | undefined,
  b?: ReportPriceObservation,
) => resolveWarehousePriceEvidence(request(), d, b, wh);
const discounted = () => ({
  ...display({
    discountCents: 300,
    deliveredCents: 1700,
    promoEnd: '2026-10-29T23:59:59.000Z',
  }),
  unitPriceCents: 1700,
});

describe('warehouse display and booklet reconciliation', () => {
  it('prefers a base=delivered display quotation over WH', () => {
    expect(reconcile(display())).toMatchObject({
      unitPriceCents: 2000,
      source: 'warehouse_display_price_api',
      unavailableReason: null,
    });
  });
  it('takes a validated positive discount once', () => {
    expect(reconcile(discounted())).toMatchObject({
      unitPriceCents: 1700,
      warehouseEvidence: {
        baseCents: 2000,
        discountCents: 300,
        deliveredCents: 1700,
      },
    });
  });
  it('fills a missing API discount only with a corroborated explicit booklet final', () => {
    expect(reconcile(display(), booklet())).toMatchObject({
      unitPriceCents: 1700,
      source: 'warehouse_savings_page',
      warehouseEvidence: {
        deliveredCents: 2000,
        bookletFinalCents: 1700,
        advertisedDiscountCents: 300,
        discountHandling: expect.stringContaining('corroborated'),
      },
    });
    expect(
      reconcile(display(), booklet(card('data-final-price="16.00"'))),
    ).toMatchObject({
      unitPriceCents: null,
      warehouseEvidence: {
        quotationCents: 2000,
        conflictReason: 'warehouse_display_booklet_final_conflict',
      },
    });
  });
  it('uses a matching already-discounted delivered final once, preserving the earlier expiry', () => {
    expect(reconcile(discounted(), booklet())).toMatchObject({
      unitPriceCents: 1700,
      source: 'warehouse_display_price_api',
      warehouseEvidence: {
        bookletFinalCents: 1700,
        promoEnd: '2026-10-29T23:59:59.000Z',
        discountHandling: 'booklet final equals delivered; used once',
      },
    });
  });
  it('quarantines a $3.00 versus $2.80 local coupon conflict without choosing a minimum', () => {
    const result = reconcile(discounted(), booklet(card('', 'Save $2.80')));
    expect(result).toMatchObject({
      unitPriceCents: null,
      unavailableReason: 'warehouse_display_booklet_final_conflict',
      warehouseEvidence: {
        quotationCents: 1700,
        discountCents: 300,
        advertisedDiscountCents: 280,
      },
    });
    expect(isUsableReportPriceEvidence(result, 'warehouse')).toBe(false);
  });
  it('never turns a Save-only discount into a final', () => {
    const result = reconcile(display(), booklet(card('', 'Save $3.00')));
    expect(result.unitPriceCents).toBe(2000);
    expect(
      reconcile(undefined, booklet(card('', 'Save $3.00'))).unitPriceCents,
    ).toBe(1000);
  });
  it('does not apply expired or future booklet promotions', () => {
    for (const day of ['2026-09-01', '2026-12-01']) {
      const b = booklet(
        card('data-final-price="17.00"')
          .replace('2026-10-01', day)
          .replace('2026-10-31', day),
      );
      expect(b.unavailableReason).toBe('promotion_not_current');
      expect(reconcile(display(), b).unitPriceCents).toBe(2000);
    }
  });
  it('quarantines online-only cards and overlapping current cards', () => {
    const online = booklet(
      card('data-final-price="17.00"').replace(
        'data-applicability="warehouse"',
        'data-applicability="online"',
      ),
    );
    expect(reconcile(display(), online)).toMatchObject({
      unitPriceCents: null,
      unavailableReason: 'warehouse_online_only_promotion',
    });
    expect(
      reconcile(
        display(),
        booklet(
          card('data-final-price="17.00"') + card('data-final-price="18.00"'),
        ),
      ),
    ).toMatchObject({
      unitPriceCents: null,
      unavailableReason: 'ambiguous_warehouse_promotions',
    });
  });
  it('preserves the savings-final then WH fallback when there is no display record', () => {
    expect(reconcile(undefined, booklet())).toMatchObject({
      unitPriceCents: 1700,
      source: 'warehouse_savings_page',
    });
    expect(reconcile(undefined, booklet('<p>No items</p>'))).toMatchObject({
      unitPriceCents: 1000,
      source: 'warehouse-price-api',
    });
  });
  it.each(['lb', 'unknown'] as const)(
    'blocks %s units against receipt packages even with a cheaper WH fallback',
    (unitBasis) => {
      expect(reconcile(display({ unitBasis }), booklet())).toMatchObject({
        unitPriceCents: null,
        warehouseEvidence: {
          unitBasis,
          unitReason: expect.stringContaining('not_comparable'),
        },
      });
    },
  );
  it('rejects a mismatched display warehouse and online scope', () => {
    expect(reconcile(display({ warehouseNumber: '456' })).unitPriceCents).toBe(
      1000,
    );
    expect(
      resolveWarehousePriceEvidence(
        request('900001', '847'),
        display(),
        booklet(),
        wh,
      ),
    ).toMatchObject({
      unitPriceCents: null,
      unavailableReason: 'invalid_physical_warehouse_scope',
    });
  });
  it('does not promote estimates or receipt history via an injected WH fallback', () => {
    for (const source of ['same_day_guest_storefront', 'receipt_history']) {
      expect(
        resolveWarehousePriceEvidence(request(), undefined, undefined, {
          ...wh,
          source,
        }).unitPriceCents,
      ).toBeNull();
    }
  });
});

describe('multi-item coupon expansion', () => {
  const hydration = (
    value = '17.00',
    prepend = '',
    append = 'After 3.00 OFF',
  ) =>
    `<p>Valid 10/1/26 - 10/31/26</p><script>{"itemNumber":"900001, 900002","applicability":"warehouse_online","pricesOffCSObject":[{"value":["${value}"],"prepend_text":"${prepend}","append_text":"${append}"}]}</script>`;
  it('expands exact comma-separated variants in hydration and article cards', () => {
    for (const item of ['900001', '900002']) {
      expect(parseSavingsForItem(hydration(), item, now())).toMatchObject({
        cents: 1700,
        advertisedDiscountCents: 300,
        scope: 'warehouse',
      });
      expect(
        parseSavingsForItem(
          card('data-final-price="17.00"').replace('900001', '900001, 900002'),
          item,
          now(),
        ).cents,
      ).toBe(1700);
    }
    expect(parseSavingsForItem(hydration(), '90000', now()).cents).toBeNull();
    expect(
      parseSavingsForItem(hydration('3.00', 'Save', ''), '900001', now()),
    ).toMatchObject({
      cents: null,
      reason: 'final_price_not_listed',
      advertisedDiscountCents: 300,
    });
  });
  it('does not spread one variant amount over a multi-price card', () => {
    const html = hydration().replace(
      '"value":["17.00"]',
      '"value":["17.00"],"value":["19.00"]',
    );
    expect(parseSavingsForItem(html, '900002', now()).reason).toBe(
      'ambiguous_warehouse_promotions',
    );
  });
});

describe('fetchReportPriceEvidence source precedence (offline integration)', () => {
  function network(savings = '<p>No offers</p>', whItems: string[] = []) {
    let savingsCalls = 0;
    const fetchFn: typeof fetch = async (input) => {
      if (String(input).includes('/warehouse-savings')) {
        savingsCalls++;
        return new Response(savings);
      }
      return Response.json({
        data: {
          products: {
            catalogData: whItems.map((itemNumber) => ({
              itemNumber,
              programTypes: 'WH',
              priceData: { price: '10.00' },
            })),
          },
        },
      });
    };
    return { fetchFn, savingsCalls: () => savingsCalls };
  }
  const location = {
    sameDayPostalCode: '10001',
    sameDayRepresentativeAddress: '123 Example Street, Sample City, NY 10001',
    sameDayMarkupPercent: 13.5,
  };
  it('always fetches savings and skips Same-Day when every physical warehouse line is verified', async () => {
    const n = network(card('data-final-price="17.00"'));
    const sameDayPriceFetcher = vi.fn(async () => []);
    const result = await fetchReportPriceEvidence([request()], {
      ...location,
      fetchFn: n.fetchFn,
      now,
      sameDayPriceFetcher,
      warehouseDisplayPriceFetcher: async (requests) =>
        requests.map((r) => ({ ...r, ...display() })),
    });
    expect(n.savingsCalls()).toBe(1);
    expect(sameDayPriceFetcher).not.toHaveBeenCalled();
    expect(result.items[0].prices.warehouse.unitPriceCents).toBe(1700);
    expect(result.items[0].prices.sameDay.unavailableReason).toBe(
      'verified_warehouse_price_available',
    );
  });
  it('runs Same-Day only for unresolved/conflicting or unit-incompatible lines', async () => {
    const n = network(card('', 'Save $2.80'), ['900001', '900002', '900003']);
    const sameDayPriceFetcher = vi.fn(async () => []);
    const result = await fetchReportPriceEvidence(
      [request(), request('900002'), request('900003'), request('900004')],
      {
        ...location,
        fetchFn: n.fetchFn,
        now,
        sameDayPriceFetcher,
        warehouseDisplayPriceFetcher: async (requests) =>
          requests
            .filter((r) => r.itemNumber !== '900004')
            .map((r) => ({
              ...r,
              ...(r.itemNumber === '900001'
                ? discounted()
                : display({
                    unitBasis: r.itemNumber === '900002' ? 'unknown' : 'each',
                  })),
            })),
      },
    );
    expect(sameDayPriceFetcher).toHaveBeenCalledTimes(1);
    expect(
      sameDayPriceFetcher.mock.calls[0][0].map(
        (r: PriceRequest) => r.itemNumber,
      ),
    ).toEqual(['900001', '900002', '900004']);
    expect(n.savingsCalls()).toBe(1);
    expect(result.items[2].prices.warehouse.unitPriceCents).toBe(2000);
    expect(result.items[0].prices.warehouseDisplay?.unitPriceCents).toBe(1700);
    expect(result.items[0].prices.warehouseGraphql?.unitPriceCents).toBe(1000);
  });
  it('retains WH and savings fallbacks without display and keeps estimates separate', async () => {
    const n = network(card('data-final-price="17.00"'), ['900001', '900002']);
    const result = await fetchReportPriceEvidence(
      [request(), request('900002'), request('900003')],
      {
        ...location,
        fetchFn: n.fetchFn,
        now,
        warehouseDisplayPriceFetcher: async () => [],
        sameDayPriceFetcher: async (requests) =>
          requests.map((r) => ({
            ...r,
            channel: 'same_day',
            unitPriceCents: 999,
            source: 'same_day_guest_storefront',
            observedAt: now().toISOString(),
            unavailableReason: null,
            promotionText: null,
          })),
      },
    );
    expect(result.items.map((i) => i.prices.warehouse.unitPriceCents)).toEqual([
      1700,
      1000,
      null,
    ]);
    expect(result.items[2].prices.sameDay.unitPriceCents).toBe(999);
    expect(n.savingsCalls()).toBe(1);
  });
  it('never routes online scope to warehouse or to Same-Day', async () => {
    const n = network('', ['900001']);
    const sameDayPriceFetcher = vi.fn(async () => []);
    const fetchDisplay = vi.fn(async () => []);
    const result = await fetchReportPriceEvidence(
      [
        request('900001', '847'),
        { ...request('900001', '847'), purchaseChannel: 'costco_com' },
      ],
      {
        ...location,
        fetchFn: n.fetchFn,
        warehouseDisplayPriceFetcher: fetchDisplay,
        sameDayPriceFetcher,
        now,
      },
    );
    expect(result.items[0].prices.warehouse.unitPriceCents).toBeNull();
    expect(result.items[1].prices.warehouse.unavailableReason).toBe(
      'not_applicable',
    );
    expect(sameDayPriceFetcher).not.toHaveBeenCalled();
  });
  it('the unexecuted live-probe entry point reports only aggregate coverage over injected HTTP', async () => {
    const n = network(card('data-final-price="17.00"'));
    const result = await probeWarehouseCoverage(['900001', '900002'], '123', {
      fetchFn: n.fetchFn,
      now,
      warehouseDisplayPriceFetcher: async () => [
        { ...request(), ...display() },
      ],
    });
    expect(result).toMatchObject({
      requested: 2,
      display: 1,
      savings: 1,
      strictWH: 0,
      verifiedComparable: 1,
      sameDayWouldBeNeeded: 1,
    });
    expect(JSON.stringify(result)).not.toMatch(/900001|900002|2000|1700|123/);
  });
});

it('does not reinterpret exact or average package weight as a per-pound receipt unit', async () => {
  const { normalizeReceipts } =
    await import('../src/core/normalize-receipts.js');
  for (const weight of [{ actualWeight: 4.25 }, { averageWeight: 4.25 }]) {
    const purchases = normalizeReceipts(
      {
        transactions: [
          {
            receiptId: '0000000000000000000009',
            transactionType: 'Purchase',
            warehouseNumber: '123',
            purchasedAt: '2026-10-20T12:00:00Z',
            items: [
              {
                itemNumber: '900001',
                quantity: 1,
                unitPrice: '20.00',
                ...weight,
              },
            ],
            coupons: [],
          },
        ],
      },
      now(),
    );
    expect(purchases[0]).toMatchObject({ paidUnitCents: 2000, quantity: 1 });
    const resolved = resolveWarehousePriceEvidence(
      purchases[0],
      display({ unitBasis: 'lb' }),
      undefined,
      wh,
    );
    expect(isUsableReportPriceEvidence(resolved, 'warehouse')).toBe(false);
    expect(resolved.warehouseEvidence?.unitReason).toContain('not_comparable');
  }
});

it('retains an expired booklet final as evidence without applying it', () => {
  const expired = booklet(
    card('data-final-price="17.00"')
      .replace('2026-10-01', '2026-09-01')
      .replace('2026-10-31', '2026-09-30'),
  );
  expect(expired).toMatchObject({
    unitPriceCents: null,
    unavailableReason: 'promotion_not_current',
    warehouseEvidence: { bookletFinalCents: 1700, promoEnd: '2026-09-30' },
  });
});

it('rejects malformed coupon date overrides instead of using the global period', () => {
  const html =
    '<p>Valid 10/1/26 - 10/31/26</p><script>{"itemNumber":"900001","applicability":"warehouse","validDatesOverride":"unconfirmed","pricesOffCSObject":[{"value":["17.00"]}]}</script>';
  expect(booklet(html)).toMatchObject({
    unitPriceCents: null,
    unavailableReason: 'promotion_not_current',
    warehouseEvidence: { bookletFinalCents: 1700, promoEnd: null },
  });
});
