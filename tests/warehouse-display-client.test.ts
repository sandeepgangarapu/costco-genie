import { describe, expect, it, vi } from 'vitest';
import {
  fetchWarehouseDisplayPrices,
  parseWarehouseDisplayPrices,
  warehouseUnitBasis,
} from '../src/costco/warehouse-display-client.js';

const now = () => new Date('2026-10-24T12:00:00Z');
const request = (itemNumber = '900001', warehouseNumber = '123') => ({
  itemNumber,
  warehouseNumber,
});
export const displayPrice = (overrides = {}) => ({
  warehouseNumber: '123',
  currency: 'USD',
  onlinePrice: '20.00',
  aggregatedDiscountAmt: '0.00',
  deliveredPrice: '20.00',
  uom: 'EA',
  factor: null,
  ...overrides,
});
export const promo = (overrides = {}) => ({
  calculatedDiscountAmount: '3.00',
  promotionStartDate: '2026-10-01T00:00:00Z',
  promotionEndDate: '2026-10-31T23:59:59Z',
  ...overrides,
});
export const payload = (
  price = displayPrice(),
  promotions: unknown[] = [],
  id = '900001',
) => ({
  priceData: [
    {
      id,
      displayPrice: [price],
      discounts: [{ warehouseNumber: '123', promotions }],
    },
  ],
});
const parse = (p: unknown) =>
  parseWarehouseDisplayPrices(p, ['900001'], '123', now()).get('900001')!;

describe('warehouse display client (synthetic public-wire fixtures)', () => {
  it.each([0, 1, 8, 9, 25])(
    'batches %i inputs at eight and reconstructs request order',
    async (size) => {
      const batches: string[][] = [];
      const fetchFn: typeof fetch = vi.fn(async (input, init) => {
        const url = new URL(String(input));
        const items = url.searchParams.get('item')!.split(',');
        batches.push(items);
        expect(url.searchParams.get('whsNumber')).toBe('123');
        expect(url.searchParams.get('clientId')).toBe(
          '4900eb1f-0c10-4bd9-99c3-c59e6c1ecebf',
        );
        expect(url.searchParams.get('locale')).toBe('en-us');
        expect(init).toMatchObject({
          method: 'GET',
          credentials: 'omit',
          signal: expect.any(AbortSignal),
          headers: {
            'client-identifier': '6b262714-2ed4-4dcb-a39d-39a4b0357309',
          },
        });
        expect(new Headers(init?.headers).has('cookie')).toBe(false);
        return Response.json({
          extra: true,
          priceData: items.toReversed().map((id) => ({
            id,
            displayPrice: [displayPrice()],
            extra: 'tolerated',
          })),
        });
      });
      const requests = Array.from({ length: size }, (_, i) =>
        request(String(900001 + i)),
      );
      const results = await fetchWarehouseDisplayPrices(requests, {
        fetchFn,
        now,
      });
      expect(batches.map((b) => b.length)).toEqual(
        Array.from({ length: Math.ceil(size / 8) }, (_, i) =>
          Math.min(8, size - i * 8),
        ),
      );
      expect(results.map((p) => p.itemNumber)).toEqual(
        requests.map((p) => p.itemNumber),
      );
      expect(results.every((p) => p.unitPriceCents === 2000)).toBe(true);
    },
  );

  it('deduplicates within one physical warehouse while retaining duplicate output and other warehouses', async () => {
    const scopes: string[] = [];
    const results = await fetchWarehouseDisplayPrices(
      [
        request(),
        request(),
        request('900002', '456'),
        request('900001', '456'),
      ],
      {
        now,
        fetchFn: async (input) => {
          const url = new URL(String(input));
          const scope = url.searchParams.get('whsNumber')!;
          scopes.push(scope);
          const items = url.searchParams.get('item')!.split(',');
          expect(new Set(items).size).toBe(items.length);
          return Response.json(
            {
              priceData: items.toReversed().map((id) => ({
                id,
                displayPrice: [
                  displayPrice({
                    warehouseNumber: '847',
                    deliveredPrice: '1.00',
                  }),
                  displayPrice({ warehouseNumber: scope }),
                ],
              })),
            },
            { status: 206 },
          );
        },
      },
    );
    expect(scopes).toEqual(['123', '456']);
    expect(results).toHaveLength(4);
    expect(results.map((p) => p.unitPriceCents)).toEqual([
      2000, 2000, 2000, 2000,
    ]);
  });

  it('maps partial 206 and all-missing 404 individually', async () => {
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json(payload(), { status: 206 }))
      .mockResolvedValueOnce(new Response(null, { status: 404 }));
    const results = await fetchWarehouseDisplayPrices(
      [request(), request('900002'), request('900003', '456')],
      { fetchFn, now },
    );
    expect(results.map((p) => p.unitPriceCents)).toEqual([2000, null, null]);
    expect(results[1].unavailableReason).toBe('warehouse_display_not_found');
    expect(results[2].unavailableReason).toBe('warehouse_display_not_found');
  });

  it('stops later batches and warehouses on configuration 400', async () => {
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(null, { status: 400 }));
    const results = await fetchWarehouseDisplayPrices(
      [
        ...Array.from({ length: 9 }, (_, i) => request(String(900001 + i))),
        request('900001', '456'),
      ],
      { fetchFn, now },
    );
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(
      results.every(
        (p) =>
          p.unavailableReason ===
          'warehouse_display_configuration_error_http_400',
      ),
    ).toBe(true);
  });

  it.each([403, 429])(
    'backs off once on %i with capped Retry-After and stops after repeated throttling',
    async (status) => {
      const fetchFn = vi
        .fn<typeof fetch>()
        .mockResolvedValue(
          new Response(null, { status, headers: { 'Retry-After': '120' } }),
        );
      const sleep = vi.fn(async () => {});
      const result = await fetchWarehouseDisplayPrices(
        Array.from({ length: 9 }, (_, i) => request(String(900001 + i))),
        { fetchFn, now, sleep },
      );
      expect(sleep).toHaveBeenCalledWith(10_000, expect.any(AbortSignal));
      expect(fetchFn).toHaveBeenCalledTimes(2);
      expect(
        result.every(
          (p) =>
            p.unavailableReason === `warehouse_display_backoff_http_${status}`,
        ),
      ).toBe(true);
    },
  );
  it('honors HTTP-date Retry-After and retains recovered 200 results', async () => {
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(null, {
          status: 429,
          headers: { 'retry-after': 'Sat, 24 Oct 2026 12:00:02 GMT' },
        }),
      )
      .mockResolvedValueOnce(Response.json(payload()));
    const sleep = vi.fn(async () => {});
    const result = await fetchWarehouseDisplayPrices([request()], {
      fetchFn,
      now,
      sleep,
    });
    expect(sleep).toHaveBeenCalledWith(2000, expect.any(AbortSignal));
    expect(result[0].unitPriceCents).toBe(2000);
  });

  it.each([
    ['malformed', async () => Response.json({})],
    [
      'transport',
      async () => {
        throw new Error('offline');
      },
    ],
    [
      'timeout',
      async () => {
        throw new DOMException('deadline', 'TimeoutError');
      },
    ],
  ] as const)(
    'returns structured %s failures within a capped timeout',
    async (kind, fetchFn) => {
      const createTimeoutSignal = vi.fn(() => new AbortController().signal);
      const result = await fetchWarehouseDisplayPrices([request()], {
        fetchFn,
        now,
        timeoutMs: 90_000,
        createTimeoutSignal,
      });
      expect(createTimeoutSignal).toHaveBeenCalledWith(30_000);
      expect(result[0]).toMatchObject({
        unitPriceCents: null,
        unavailableReason:
          kind === 'timeout'
            ? 'warehouse_display_timeout'
            : 'warehouse_display_price_failed',
      });
    },
  );

  it('does not issue requests for invalid item IDs or online/zero scopes', async () => {
    const fetchFn = vi.fn<typeof fetch>();
    const result = await fetchWarehouseDisplayPrices(
      [
        request('bad'),
        request('900001', '847'),
        request('900001', '0847'),
        request('900001', '0'),
      ],
      { fetchFn, now },
    );
    expect(fetchFn).not.toHaveBeenCalled();
    expect(result.every((p) => p.unitPriceCents === null)).toBe(true);
  });

  it('uses delivered once with exact cent arithmetic and retains promotion dates', () => {
    expect(
      parse(
        payload(
          displayPrice({ aggregatedDiscountAmt: '3.0000', deliveredPrice: 17 }),
          [promo()],
        ),
      ),
    ).toMatchObject({
      cents: 1700,
      baseCents: 2000,
      discountCents: 300,
      deliveredCents: 1700,
      promoEnd: '2026-10-31T23:59:59.000Z',
      reason: null,
    });
  });
  it.each(['0', '-1', '1.001', '90071992547409.92', null])(
    'rejects unsafe/nonpositive money %j',
    (value) => {
      expect(
        parse(
          payload(displayPrice({ onlinePrice: value, deliveredPrice: value })),
        ).cents,
      ).toBeNull();
    },
  );
  it.each([
    [{ currency: 'CAD' }, 'non_usd'],
    [
      { aggregatedDiscountAmt: '3.00', deliveredPrice: '18.00' },
      'arithmetic_mismatch',
    ],
    [{ aggregatedDiscountAmt: '-1' }, 'invalid_money'],
    [{ aggregatedDiscountAmt: '30', deliveredPrice: '-10' }, 'invalid_money'],
  ])('rejects price validation edge %j', (overrides, reason) => {
    expect(parse(payload(displayPrice(overrides))).reason).toBe(
      `warehouse_display_${reason}`,
    );
  });
  it.each(['2026-09-01T00:00:00Z', '2026-12-01T00:00:00Z'])(
    'rejects expired/future paid promotions ending %s',
    (end) => {
      const p = promo({ promotionStartDate: end, promotionEndDate: end });
      expect(
        parse(
          payload(
            displayPrice({ aggregatedDiscountAmt: '3', deliveredPrice: '17' }),
            [p],
          ),
        ).reason,
      ).toBe('warehouse_display_promotion_not_current');
    },
  );
  it('rejects invalid or inconsistent promotion amounts and overlapping scope records', () => {
    expect(
      parse(
        payload(
          displayPrice({ aggregatedDiscountAmt: '3', deliveredPrice: '17' }),
          [promo({ calculatedDiscountAmount: '2.80' })],
        ),
      ).reason,
    ).toBe('warehouse_display_promotion_amount_mismatch');
    expect(
      parse(payload(displayPrice(), [promo({ promotionStartDate: 'invalid' })]))
        .reason,
    ).toBe('warehouse_display_invalid_promotion');
    expect(
      parse(
        payload(
          displayPrice({ aggregatedDiscountAmt: '6', deliveredPrice: '14' }),
          [promo(), promo()],
        ),
      ).reason,
    ).toBe('warehouse_display_ambiguous_promotions');
    const p = payload();
    p.priceData[0].discounts.push({ warehouseNumber: '123', promotions: [] });
    expect(parse(p).reason).toBe('warehouse_display_ambiguous_promotions');
  });
  it('rejects duplicate identities and ignores wrong item/warehouse and extra fields', () => {
    const p = payload();
    p.priceData.push(p.priceData[0]);
    expect(parse(p).reason).toBe('warehouse_display_ambiguous_item');
    const q = payload();
    q.priceData[0].displayPrice.push(displayPrice());
    expect(parse(q).reason).toBe('warehouse_display_ambiguous_warehouse');
    expect(parse(payload(displayPrice(), [], '900002')).cents).toBeNull();
    expect(
      parse(payload(displayPrice({ warehouseNumber: '847' }))).cents,
    ).toBeNull();
  });
  it('identifies a per-lb zero-dollar disclaimer with null UOM and refuses to infer each from absence', () => {
    const p = promo({
      calculatedDiscountAmount: 0,
      promotionStartDate: null,
      promotionEndDate: null,
      text: { disclaimerText: { 'en-US': { text: '<p>Price per pound</p>' } } },
    });
    expect(parse(payload(displayPrice({ uom: null }), [p]))).toMatchObject({
      cents: 2000,
      unitBasis: 'lb',
      promoEnd: null,
      reason: null,
    });
    expect(parse(payload(displayPrice({ uom: null }), [])).unitBasis).toBe(
      'unknown',
    );
    expect(warehouseUnitBasis('EA', 2, '')).toBe('unknown');
    expect(warehouseUnitBasis(null, null, '$3 off each item')).toBe('unknown');
    expect(
      warehouseUnitBasis(null, null, 'random weight, 8 lb average package'),
    ).toBe('unknown');
  });
});

it('stops all remaining batches when throttling backoff is interrupted by its deadline', async () => {
  const fetchFn = vi
    .fn<typeof fetch>()
    .mockResolvedValue(new Response(null, { status: 429 }));
  const result = await fetchWarehouseDisplayPrices(
    Array.from({ length: 9 }, (_, i) => request(String(900001 + i))),
    {
      fetchFn,
      now,
      sleep: async () => {
        throw new DOMException('deadline', 'TimeoutError');
      },
    },
  );
  expect(fetchFn).toHaveBeenCalledTimes(1);
  expect(
    result.every(
      (p) => p.unavailableReason === 'warehouse_display_backoff_http_429',
    ),
  ).toBe(true);
});
