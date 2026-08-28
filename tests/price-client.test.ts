import { describe, expect, it } from 'vitest';

import {
  fetchReportPriceEvidence,
  fetchWarehousePrices,
  type WarehousePriceRequest,
} from '../src/costco/price-client.js';
import type { PurchaseChannel } from '../src/domain/types.js';

const observedAt = '2026-08-18T21:00:00.000Z';

function product(
  itemNumber: string,
  price: unknown = '9.99',
  programTypes = 'WH',
) {
  return { itemNumber, priceData: { price }, programTypes };
}

function productResponse(catalogData: unknown[]): Response {
  return Response.json({
    data: { products: { catalogData, fulfillmentData: [] } },
  });
}

function request(
  itemNumber: string,
  warehouseNumber = '123',
  purchaseChannel: PurchaseChannel = 'warehouse',
) {
  return { itemNumber, purchaseChannel, warehouseNumber };
}

function onlineRequest(itemNumber: string) {
  return request(itemNumber, '847', 'costco_com');
}

describe('fetchWarehousePrices', () => {
  it('groups by warehouse and executes capped batches sequentially', async () => {
    const requests: WarehousePriceRequest[] = [
      ...Array.from({ length: 26 }, (_, index) =>
        request(String(100000 + index), '123'),
      ),
      request('200000', '456'),
    ];
    const batches: Array<{ itemNumbers: string[]; warehouseNumber: string }> =
      [];
    const endpoints: Array<RequestInfo | URL> = [];
    const initializations: RequestInit[] = [];
    let activeRequests = 0;
    let maximumActiveRequests = 0;
    const fetchFn: typeof fetch = async (input, init) => {
      endpoints.push(input);
      initializations.push(init ?? {});
      activeRequests += 1;
      maximumActiveRequests = Math.max(maximumActiveRequests, activeRequests);
      await Promise.resolve();
      const body = JSON.parse(String(init?.body)) as { query: string };
      expect(body.query).toContain(
        'clientId: "4900eb1f-0c10-4bd9-99c3-c59e6c1ecebf"',
      );
      const itemList = /itemNumbers: \[([^\]]+)\]/.exec(body.query)?.[1] ?? '';
      const itemNumbers = [...itemList.matchAll(/"(\d+)"/g)]
        .map((match) => match[1])
        .filter((value): value is string => value !== undefined);
      const warehouseNumber =
        /warehouseNumber: "(\d+)"/.exec(body.query)?.[1] ?? '';
      batches.push({ itemNumbers, warehouseNumber });
      activeRequests -= 1;
      return productResponse(itemNumbers.map((item) => product(item)));
    };

    const observations = await fetchWarehousePrices(requests, {
      batchSize: 100,
      fetchFn,
      now: () => new Date(observedAt),
    });

    expect(batches).toEqual([
      {
        itemNumbers: Array.from({ length: 25 }, (_, index) =>
          String(100000 + index),
        ),
        warehouseNumber: '123',
      },
      { itemNumbers: ['100025'], warehouseNumber: '123' },
      { itemNumbers: ['200000'], warehouseNumber: '456' },
    ]);
    expect(maximumActiveRequests).toBe(1);
    expect(observations).toHaveLength(27);
    expect(endpoints).toEqual([
      'https://ecom-api.costco.com/ebusiness/product/v1/products/graphql',
      'https://ecom-api.costco.com/ebusiness/product/v1/products/graphql',
      'https://ecom-api.costco.com/ebusiness/product/v1/products/graphql',
    ]);
    expect(initializations[0]).toMatchObject({
      credentials: 'omit',
      headers: {
        'Content-Type': 'application/json',
        'client-identifier': '4900eb1f-0c10-4bd9-99c3-c59e6c1ecebf',
        'costco.env': 'ecom',
        'costco.service': 'restProduct',
      },
      method: 'POST',
    });
  });

  it('creates a fresh 30-second application timeout signal for every price batch', async () => {
    const signals: AbortSignal[] = [];
    const requestedTimeouts: number[] = [];
    const fetchSignals: Array<AbortSignal | null | undefined> = [];
    const fetchFn: typeof fetch = async (_input, init) => {
      fetchSignals.push(init?.signal);
      const query = (JSON.parse(String(init?.body)) as { query: string }).query;
      const itemNumber = /itemNumbers: \["(\d+)"\]/.exec(query)?.[1] ?? '';
      return productResponse([product(itemNumber)]);
    };

    await fetchWarehousePrices([request('100'), request('101')], {
      batchSize: 1,
      createTimeoutSignal(timeoutMilliseconds) {
        requestedTimeouts.push(timeoutMilliseconds);
        const signal = new AbortController().signal;
        signals.push(signal);
        return signal;
      },
      fetchFn,
      now: () => new Date(observedAt),
    });

    expect(requestedTimeouts).toEqual([30_000, 30_000]);
    expect(fetchSignals).toEqual(signals);
    expect(signals[0]).not.toBe(signals[1]);
  });

  it('maps a timed-out price batch to batch_failed and continues', async () => {
    let calls = 0;
    const fetchFn: typeof fetch = async (_input, init) => {
      calls += 1;
      if (calls === 1) {
        expect(init?.signal).toBeInstanceOf(AbortSignal);
        throw new DOMException('deadline reached', 'TimeoutError');
      }
      const query = (JSON.parse(String(init?.body)) as { query: string }).query;
      const itemNumber = /itemNumbers: \["(\d+)"\]/.exec(query)?.[1] ?? '';
      return productResponse([product(itemNumber)]);
    };

    const observations = await fetchWarehousePrices(
      [request('100'), request('101')],
      { batchSize: 1, fetchFn, now: () => new Date(observedAt) },
    );

    expect(observations.map((item) => item.unresolvedReason)).toEqual([
      'batch_failed',
      null,
    ]);
  });

  it('does not send non-digit item or warehouse identifiers', async () => {
    let calls = 0;
    const fetchFn: typeof fetch = async () => {
      calls += 1;
      return productResponse([]);
    };

    const observations = await fetchWarehousePrices(
      [request('12A3'), request('123', '4-56')],
      { fetchFn, now: () => new Date(observedAt) },
    );

    expect(calls).toBe(0);
    expect(observations).toEqual([
      {
        itemNumber: '12A3',
        observedAt,
        source: 'warehouse-price-api',
        unitPriceCents: null,
        unresolvedReason: 'invalid_item_number',
        warehouseNumber: '123',
      },
      {
        itemNumber: '123',
        observedAt,
        source: 'warehouse-price-api',
        unitPriceCents: null,
        unresolvedReason: 'invalid_warehouse_number',
        warehouseNumber: '4-56',
      },
    ]);
  });

  it('maps only an exact requested item with a positive WH price', async () => {
    const fetchFn: typeof fetch = async () =>
      productResponse([
        product('1000', '1.00', 'WH'),
        product('101', '8.75', 'BD,WH'),
        product('100', '9.99', 'WH'),
        product('102', '0.00', 'WH'),
        product('103', '7.50', 'ONLINE'),
        { itemNumber: '104', priceData: {}, programTypes: 'WH' },
      ]);

    const observations = await fetchWarehousePrices(
      ['100', '101', '102', '103', '104', '105'].map((item) => request(item)),
      { fetchFn, now: () => new Date(observedAt) },
    );

    expect(observations).toEqual([
      {
        itemNumber: '100',
        observedAt,
        source: 'warehouse-price-api',
        unitPriceCents: 999,
        unresolvedReason: null,
        warehouseNumber: '123',
      },
      {
        itemNumber: '101',
        observedAt,
        source: 'warehouse-price-api',
        unitPriceCents: 875,
        unresolvedReason: null,
        warehouseNumber: '123',
      },
      {
        itemNumber: '102',
        observedAt,
        source: 'warehouse-price-api',
        unitPriceCents: null,
        unresolvedReason: 'invalid_price',
        warehouseNumber: '123',
      },
      {
        itemNumber: '103',
        observedAt,
        source: 'warehouse-price-api',
        unitPriceCents: null,
        unresolvedReason: 'not_warehouse_price',
        warehouseNumber: '123',
      },
      {
        itemNumber: '104',
        observedAt,
        source: 'warehouse-price-api',
        unitPriceCents: null,
        unresolvedReason: 'invalid_price',
        warehouseNumber: '123',
      },
      {
        itemNumber: '105',
        observedAt,
        source: 'warehouse-price-api',
        unitPriceCents: null,
        unresolvedReason: 'product_not_found',
        warehouseNumber: '123',
      },
    ]);
  });

  it('accepts finite numeric wire prices without rounding malformed values', async () => {
    const fetchFn: typeof fetch = async () =>
      productResponse([
        product('200', 9.99),
        product('201', 0),
        product('202', 9.999),
        product('203', Number.NaN),
      ]);

    const observations = await fetchWarehousePrices(
      ['200', '201', '202', '203'].map((item) => request(item)),
      { fetchFn, now: () => new Date(observedAt) },
    );

    expect(
      observations.map((observation) => observation.unitPriceCents),
    ).toEqual([999, null, null, null]);
    expect(
      observations.map((observation) => observation.unresolvedReason),
    ).toEqual([null, 'invalid_price', 'invalid_price', 'invalid_price']);
  });

  it('emits unresolved observations for a failed batch and continues later batches', async () => {
    let call = 0;
    const fetchFn: typeof fetch = async (_input, init) => {
      call += 1;
      if (call === 2) {
        throw new Error('temporary network failure');
      }
      const query = (JSON.parse(String(init?.body)) as { query: string }).query;
      const itemNumber = /itemNumbers: \["(\d+)"\]/.exec(query)?.[1] ?? '';
      return productResponse([product(itemNumber)]);
    };

    const observations = await fetchWarehousePrices(
      [request('100'), request('101'), request('102')],
      {
        batchSize: 1,
        fetchFn,
        now: () => new Date(observedAt),
      },
    );

    expect(call).toBe(3);
    expect(
      observations.map(({ itemNumber, unresolvedReason }) => ({
        itemNumber,
        unresolvedReason,
      })),
    ).toEqual([
      { itemNumber: '100', unresolvedReason: null },
      { itemNumber: '101', unresolvedReason: 'batch_failed' },
      { itemNumber: '102', unresolvedReason: null },
    ]);
  });

  it.each([
    Response.json({ errors: [{ message: 'upstream failure' }] }),
    Response.json({ data: { products: null } }),
    Response.json({}, { status: 503 }),
  ])(
    'isolates GraphQL, malformed, and HTTP batch failures',
    async (response) => {
      const fetchFn: typeof fetch = async () => response.clone();

      const observations = await fetchWarehousePrices([request('100')], {
        fetchFn,
        now: () => new Date(observedAt),
      });

      expect(observations).toMatchObject([
        { unitPriceCents: null, unresolvedReason: 'batch_failed' },
      ]);
    },
  );
});

describe('Same-Day report evidence', () => {
  it('uses exact-item guest storefront pricing localized to the configured ZIP', async () => {
    const sameDayCalls: unknown[] = [];
    const fetchFn: typeof fetch = async (input) =>
      String(input).includes('/warehouse-savings')
        ? new Response('<p>No current advertised items</p>')
        : productResponse([]);

    const result = await fetchReportPriceEvidence([request('1753490', '110')], {
      fetchFn,
      now: () => new Date(observedAt),
      sameDayMarkupPercent: 13.5,
      sameDayPostalCode: '98029',
      sameDayRepresentativeAddress: '2520 NE Park Dr, Issaquah, WA 98029',
      sameDayPriceFetcher: async (requests, options) => {
        sameDayCalls.push({ requests, options });
        return [
          {
            channel: 'same_day',
            itemNumber: '1753490',
            warehouseNumber: '110',
            observedAt,
            promotionText: null,
            source: 'same_day_guest_storefront_zip_98029',
            unavailableReason: null,
            unitPriceCents: 1531,
          },
        ];
      },
    });

    expect(sameDayCalls).toEqual([
      {
        requests: [
          {
            itemNumber: '1753490',
            purchaseChannel: 'warehouse',
            warehouseNumber: '110',
          },
        ],
        options: expect.objectContaining({
          postalCode: '98029',
          deliveryAddress: '2520 NE Park Dr, Issaquah, WA 98029',
          timeout: 180_000,
        }),
      },
    ]);
    expect(result.items[0]?.prices.sameDay).toMatchObject({
      unitPriceCents: 1531,
      source: 'same_day_guest_storefront_zip_98029',
    });
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        channel: 'same_day',
        source: 'same_day_guest_storefront_zip_98029',
        status: 'ok',
      }),
    );
  });

  it('keeps other evidence when the Same-Day source unexpectedly rejects', async () => {
    const fetchFn: typeof fetch = async (input) =>
      String(input).includes('/warehouse-savings')
        ? new Response('<p>No current advertised items</p>')
        : productResponse([product('1753490', '17.99', 'ONLINE')]);

    const result = await fetchReportPriceEvidence([request('1753490', '110')], {
      fetchFn,
      now: () => new Date(observedAt),
      sameDayMarkupPercent: 13.5,
      sameDayPostalCode: '98029',
      sameDayRepresentativeAddress: '2520 NE Park Dr, Issaquah, WA 98029',
      sameDayPriceFetcher: async () => {
        throw new Error('storefront crashed');
      },
    });

    expect(result.items[0]?.prices.costcoCom.unitPriceCents).toBe(1799);
    expect(result.items[0]?.prices.sameDay).toMatchObject({
      unitPriceCents: null,
      unavailableReason: 'source_failed',
    });
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ channel: 'same_day', status: 'error' }),
    );
  });

  it('marks a Same-Day overall deadline as a source error', async () => {
    const fetchFn: typeof fetch = async (input) =>
      String(input).includes('/warehouse-savings')
        ? new Response('<p>No current advertised items</p>')
        : productResponse([]);
    const result = await fetchReportPriceEvidence([request('1753490', '110')], {
      fetchFn,
      now: () => new Date(observedAt),
      sameDayMarkupPercent: 13.5,
      sameDayPostalCode: '98029',
      sameDayRepresentativeAddress: '2520 NE Park Dr, Issaquah, WA 98029',
      sameDayPriceFetcher: async () => [
        {
          channel: 'same_day',
          itemNumber: '1753490',
          warehouseNumber: '110',
          observedAt,
          promotionText: null,
          source: 'same_day_guest_storefront_zip_98029',
          unavailableReason: 'deadline_exceeded',
          unitPriceCents: null,
        },
      ],
    });

    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ channel: 'same_day', status: 'error' }),
    );
  });
});

describe('fetchReportPriceEvidence', () => {
  it('partitions mixed requests while retaining Costco.com evidence for both purchase channels', async () => {
    const productQueries: string[] = [];
    const sameDayRequests: unknown[] = [];
    let savingsRequests = 0;
    const fetchFn: typeof fetch = async (input, init) => {
      if (String(input).includes('/warehouse-savings')) {
        savingsRequests += 1;
        return new Response('<p>No current advertised items</p>');
      }
      const query = (JSON.parse(String(init?.body)) as { query: string }).query;
      productQueries.push(query);
      const itemNumbers = [...query.matchAll(/"(\d+)"/gu)]
        .map((match) => match[1])
        .filter((value): value is string => value !== undefined);
      return productResponse(
        itemNumbers.map((itemNumber) => product(itemNumber, '12.34', 'WH')),
      );
    };

    const result = await fetchReportPriceEvidence(
      [request('111111', '123'), onlineRequest('222222')],
      {
        fetchFn,
        now: () => new Date(observedAt),
        sameDayMarkupPercent: 13.5,
        sameDayPostalCode: '98029',
        sameDayPriceFetcher: async (requests) => {
          sameDayRequests.push(requests);
          return [];
        },
      },
    );

    expect(productQueries).toHaveLength(3);
    expect(productQueries[0]).toContain('itemNumbers: ["111111"]');
    expect(productQueries[0]).not.toContain('"222222"');
    expect(productQueries.slice(1).join('\n')).toContain('"111111"');
    expect(productQueries.slice(1).join('\n')).toContain('"222222"');
    expect(savingsRequests).toBe(1);
    expect(sameDayRequests).toEqual([
      [
        {
          itemNumber: '111111',
          purchaseChannel: 'warehouse',
          warehouseNumber: '123',
        },
      ],
    ]);
    expect(result.items).toMatchObject([
      { purchaseChannel: 'warehouse', itemNumber: '111111' },
      {
        purchaseChannel: 'costco_com',
        itemNumber: '222222',
        prices: {
          warehouse: {
            source: null,
            unavailableReason: 'not_applicable',
            unitPriceCents: null,
          },
          warehouseSavings: {
            source: null,
            unavailableReason: 'not_applicable',
            unitPriceCents: null,
          },
          costcoCom: { unitPriceCents: 1234 },
          sameDay: {
            source: null,
            unavailableReason: 'not_applicable',
            unitPriceCents: null,
          },
        },
      },
    ]);
  });

  it('keeps the same item number separate across warehouse and Costco.com scopes', async () => {
    const fetchFn: typeof fetch = async (input) =>
      String(input).includes('/warehouse-savings')
        ? new Response('<p>No current advertised items</p>')
        : productResponse([product('111111', '12.34', 'WH')]);

    const result = await fetchReportPriceEvidence(
      [request('111111', '847'), onlineRequest('111111')],
      { fetchFn, now: () => new Date(observedAt) },
    );

    expect(result.items).toHaveLength(2);
    expect(result.items).toMatchObject([
      {
        purchaseChannel: 'warehouse',
        itemNumber: '111111',
        warehouseNumber: '847',
        prices: { warehouse: { unitPriceCents: 1234 } },
      },
      {
        purchaseChannel: 'costco_com',
        itemNumber: '111111',
        warehouseNumber: '847',
        prices: {
          warehouse: { unavailableReason: 'not_applicable' },
          costcoCom: { unitPriceCents: 1234 },
        },
      },
    ]);
  });

  it('does not invoke warehouse-only sources for an online-only request', async () => {
    let productCalls = 0;
    let savingsCalls = 0;
    let sameDayCalls = 0;
    const fetchFn: typeof fetch = async (input) => {
      if (String(input).includes('/warehouse-savings')) {
        savingsCalls += 1;
        throw new Error('warehouse savings must be skipped');
      }
      productCalls += 1;
      return productResponse([product('222222', '10.00', 'ONLINE')]);
    };

    const result = await fetchReportPriceEvidence([onlineRequest('222222')], {
      fetchFn,
      now: () => new Date(observedAt),
      sameDayMarkupPercent: 13.5,
      sameDayPostalCode: '98029',
      sameDayPriceFetcher: async () => {
        sameDayCalls += 1;
        throw new Error('Same-Day must be skipped');
      },
    });

    expect(productCalls).toBe(1);
    expect(savingsCalls).toBe(0);
    expect(sameDayCalls).toBe(0);
    expect(
      result.diagnostics.filter(
        ({ channel }) =>
          channel === 'warehouse' ||
          channel === 'warehouse_savings' ||
          channel === 'same_day',
      ),
    ).not.toContainEqual(expect.objectContaining({ status: 'error' }));
  });

  it('rejects an invalid batch size before an online-only catalog lookup', async () => {
    let calls = 0;

    await expect(
      fetchReportPriceEvidence([onlineRequest('222222')], {
        batchSize: Number.NaN,
        fetchFn: async () => {
          calls += 1;
          return productResponse([]);
        },
        now: () => new Date(observedAt),
      }),
    ).rejects.toThrow(/batch size.*positive integer/iu);
    expect(calls).toBe(0);
  });

  it.each([
    ['an item-number mismatch', [product('999999', '10.00', 'ONLINE')]],
    [
      'ambiguous exact-item matches',
      [
        product('222222', '10.00', 'ONLINE'),
        product('222222', '9.00', 'ONLINE'),
      ],
    ],
    ['a zero price', [product('222222', '0.00', 'ONLINE')]],
    ['a malformed price', [product('222222', 'ten dollars', 'ONLINE')]],
  ])('keeps Costco.com evidence unavailable for %s', async (_, catalogData) => {
    const fetchFn: typeof fetch = async () => productResponse(catalogData);

    const result = await fetchReportPriceEvidence([onlineRequest('222222')], {
      fetchFn,
      now: () => new Date(observedAt),
    });

    expect(result.items[0]?.prices.costcoCom).toMatchObject({
      unitPriceCents: null,
      unavailableReason: expect.any(String),
    });
  });

  it('separates online prices and accepts only current exact-item Warehouse Savings final prices', async () => {
    // Sanitized from the live 2026-08-21 page: global validity copy plus the
    // escaped Next.js hydration fields used by a real coupon card.
    const savingsHtml = `
      <p>Pricing shown is warehouse pricing</p>
      <p>Pricing may vary by location and online | Valid 7/27/26 - 8/23/26</p>
      <script>self.__next_f.push("{\\"cardDescription\\":\\"Aveeno Daily Moisturizing Body Lotion\\",\\"itemNumber\\":\\"1753490\\",\\"applicability\\":\\"warehouse_online\\",\\"pricesOffCSObject\\":[{\\"value\\":[\\"13.49\\"],\\"append_text\\":\\"After 4.50 OFF\\"}]}")</script>
      <div>Huggies Diapers — Item numbers vary — Save $10</div>
      <script>self.__next_f.push("{\\"itemNumber\\":\\"999999\\",\\"applicability\\":\\"warehouse\\",\\"pricesOffCSObject\\":[{\\"value\\":[\\"1.00\\"],\\"append_text\\":\\"After 1.00 OFF\\"}],\\"validDatesOverride\\":\\"Valid 8/1/26 - 8/10/26\\"}")</script>`;
    const fetchFn: typeof fetch = async (input) => {
      if (String(input).includes('/warehouse-savings')) {
        return new Response(savingsHtml, {
          headers: { 'content-type': 'text/html' },
        });
      }
      return productResponse([
        product('1753490', '17.99', 'ONLINE'),
        product('1914460', '49.99', 'ONLINE'),
        product('999999', '2.00', 'ONLINE'),
      ]);
    };

    const result = await fetchReportPriceEvidence(
      [request('1753490'), request('1914460'), request('999999')],
      { fetchFn, now: () => new Date('2026-08-21T16:00:00.000Z') },
    );

    expect(result.items[0]).toMatchObject({
      itemNumber: '1753490',
      prices: {
        warehouse: {
          channel: 'warehouse',
          unitPriceCents: 1349,
          source: 'warehouse_savings_page',
        },
        warehouseSavings: {
          channel: 'warehouse_savings',
          unitPriceCents: 1349,
          promotionText: '$13.49 After 4.50 OFF',
        },
        costcoCom: { channel: 'costco_com', unitPriceCents: 1799 },
        sameDay: {
          channel: 'same_day',
          unitPriceCents: null,
          unavailableReason: 'source_not_configured',
        },
      },
    });
    expect(Object.keys(result.items[0]?.prices.warehouseSavings ?? {})).toEqual(
      [
        'channel',
        'observedAt',
        'promotionText',
        'source',
        'unavailableReason',
        'unitPriceCents',
      ],
    );
    expect(result.items[1]?.prices.warehouseSavings).toMatchObject({
      unitPriceCents: null,
      unavailableReason: 'item_not_advertised',
    });
    expect(result.items[1]?.prices.warehouse.unitPriceCents).toBeNull();
    expect(result.items[2]?.prices.warehouseSavings).toMatchObject({
      unitPriceCents: null,
      unavailableReason: 'promotion_not_current',
    });
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          channel: 'warehouse_savings',
          source: 'warehouse_savings_page',
          status: 'ok',
        }),
      ]),
    );
  });

  it('batches Costco.com per warehouse with fresh deadlines and keeps successful batches', async () => {
    const requests = [
      ...Array.from({ length: 26 }, (_, index) =>
        request(String(300000 + index), '123'),
      ),
      request('400000', '456'),
    ];
    const requestedTimeouts: number[] = [];
    const signals: AbortSignal[] = [];
    let productCalls = 0;
    const fetchFn: typeof fetch = async (input, init) => {
      if (String(input).includes('/warehouse-savings')) {
        return new Response(
          '<p>Pricing shown is warehouse pricing | Valid 8/1/26 - 8/31/26</p>',
        );
      }
      productCalls += 1;
      const query = (JSON.parse(String(init?.body)) as { query: string }).query;
      const itemNumbers = [...query.matchAll(/"(\d+)"/gu)]
        .map((match) => match[1])
        .filter((value): value is string => value !== undefined);
      // Calls 1-3 are warehouse lookup batches. Call 5 is only the second
      // Costco.com batch; its failure must not erase calls 4 or 6.
      if (productCalls === 5) return new Response('', { status: 503 });
      return productResponse(
        itemNumbers.map((itemNumber) => product(itemNumber, '12.34', 'WH')),
      );
    };

    const result = await fetchReportPriceEvidence(requests, {
      batchSize: 100,
      createTimeoutSignal(milliseconds) {
        requestedTimeouts.push(milliseconds);
        const signal = new AbortController().signal;
        signals.push(signal);
        return signal;
      },
      fetchFn,
      now: () => new Date(observedAt),
    });

    expect(productCalls).toBe(6);
    expect(requestedTimeouts).toEqual(Array(7).fill(30_000));
    expect(new Set(signals).size).toBe(7);
    expect(result.items[0]?.prices.costcoCom).toMatchObject({
      unitPriceCents: 1234,
      unavailableReason: null,
    });
    expect(result.items[25]?.prices.costcoCom).toMatchObject({
      unitPriceCents: null,
      unavailableReason: 'batch_failed',
    });
    expect(result.items[26]?.prices.costcoCom).toMatchObject({
      unitPriceCents: 1234,
      unavailableReason: null,
    });
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          channel: 'costco_com',
          status: 'error',
          message: expect.stringContaining('one or more batches failed'),
        }),
      ]),
    );
  });
});
