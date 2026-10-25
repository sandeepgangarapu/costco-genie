import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { normalizeReceipts } from '../src/core/normalize-receipts.js';
import {
  adaptCostcoReceipts,
  fetchReceipts,
} from '../src/costco/receipt-client.js';
import { AuthRequiredError, CostcoApiError } from '../src/costco/errors.js';

const liveReceiptFixture = JSON.parse(
  readFileSync(
    fileURLToPath(new URL('./fixtures/live-receipts.json', import.meta.url)),
    'utf8',
  ),
) as unknown[];

const numericLiveReceiptFixture = JSON.parse(
  readFileSync(
    fileURLToPath(
      new URL('./fixtures/live-receipts-numeric.json', import.meta.url),
    ),
    'utf8',
  ),
) as unknown[];

describe('fetchReceipts', () => {
  it('accepts numeric receipt identifiers, item numbers, quantities, and amounts while preserving local time', () => {
    const adapted = adaptCostcoReceipts(numericLiveReceiptFixture);

    expect(adapted.transactions[0]).toMatchObject({
      purchasedAt: '2023-10-25T14:30:00',
      receiptId: '0000000000000000000001',
      warehouseNumber: '1',
    });
    expect(adapted.transactions[0]?.items[0]).toEqual({
      description: 'GYRO KIT',
      itemNumber: '17120',
      quantity: 1,
      unitPrice: '13.49',
    });
  });

  it('converts an in-order TPD line into an exact coupon for its referenced earlier item', () => {
    const purchases = normalizeReceipts(
      adaptCostcoReceipts(numericLiveReceiptFixture),
      new Date('2026-08-18T00:00:00.000Z'),
    );

    expect(
      purchases.find(({ itemNumber }) => itemNumber === '17120'),
    ).toMatchObject({
      couponCents: 300,
      paidUnitCents: 1049,
    });
    expect(purchases.some(({ itemNumber }) => itemNumber === '1715281')).toBe(
      false,
    );
  });

  it('marks every normalized receipt line as a warehouse purchase', () => {
    const purchases = normalizeReceipts(
      adaptCostcoReceipts(numericLiveReceiptFixture),
      new Date('2026-08-18T00:00:00.000Z'),
    );

    expect(purchases).not.toHaveLength(0);
    expect(
      purchases.every((purchase) => purchase.purchaseChannel === 'warehouse'),
    ).toBe(true);
  });

  it('converts a negative item-array discount with a spaced item reference into a coupon', () => {
    const adapted = adaptCostcoReceipts([
      {
        couponArray: [],
        itemArray: [
          {
            amount: '99.98',
            itemDescription01: 'PURCHASED ITEM',
            itemNumber: '980015',
            itemUnitPriceAmount: '49.99',
            unit: '2',
          },
          {
            amount: '-20.00',
            itemDescription01: '/ 980015',
            itemNumber: '385320',
            itemUnitPriceAmount: '0.00',
            unit: '-2',
          },
          {
            amount: '-1.00',
            itemDescription01: '/ not-an-item-number',
            itemNumber: '900002',
            itemUnitPriceAmount: '0.00',
            unit: '-1',
          },
          {
            amount: '-1.00',
            itemDescription01: '/ 999999',
            itemNumber: '900003',
            itemUnitPriceAmount: '0.00',
            unit: '-1',
          },
        ],
        registerNumber: '1',
        transactionDateTime: '2026-08-18T09:00:00',
        transactionNumber: '1',
        transactionType: 'Purchase',
        warehouseNumber: '129',
      },
    ]);

    expect(adapted.transactions[0]).toMatchObject({
      coupons: [{ amount: '-20.00', itemNumber: '980015' }],
      items: [
        {
          description: 'PURCHASED ITEM',
          itemNumber: '980015',
          quantity: 2,
          unitPrice: '49.99',
        },
      ],
    });
  });

  it('applies a text-only slash discount only to the immediately preceding purchase', () => {
    const purchases = normalizeReceipts(
      adaptCostcoReceipts([
        {
          couponArray: [],
          itemArray: [
            {
              amount: '-1.00',
              itemDescription01: '/ ORPHAN',
              itemNumber: '384939',
              itemUnitPriceAmount: '0.00',
              unit: '-1',
            },
            {
              amount: '15.99',
              itemDescription01: 'FLNA CAMI4PK',
              itemNumber: '1864962',
              itemUnitPriceAmount: '15.99',
              unit: '1',
            },
            {
              amount: '-3.00',
              itemDescription01: '/ CAMISOLE',
              itemNumber: '384940',
              itemUnitPriceAmount: '0.00',
              unit: '-1',
            },
            {
              amount: '3.00',
              itemDescription01: '/ CAMISOLE',
              itemNumber: '384941',
              itemUnitPriceAmount: '3.00',
              unit: '1',
            },
            {
              amount: '5.00',
              itemDescription01: 'OTHER PURCHASE',
              itemNumber: '1864963',
              itemUnitPriceAmount: '5.00',
              unit: '1',
            },
            {
              amount: '-1.00',
              itemDescription01: '/',
              itemNumber: '384942',
              itemUnitPriceAmount: '0.00',
              unit: '-1',
            },
            {
              amount: '-1.00',
              itemDescription01: '/ OTHER PURCHASE',
              itemNumber: '384943',
              itemUnitPriceAmount: '0.00',
              unit: '-1',
            },
          ],
          registerNumber: '1',
          transactionDateTime: '2026-08-18T09:00:00',
          transactionNumber: '2',
          transactionType: 'Purchase',
          warehouseNumber: '129',
        },
      ]),
      new Date('2026-08-18T12:00:00.000Z'),
    );

    expect(purchases).toMatchObject([
      {
        couponCents: 300,
        grossUnitCents: 1599,
        itemNumber: '1864962',
        paidUnitCents: 1299,
        quantity: 1,
      },
      {
        couponCents: 0,
        itemNumber: '1864963',
        paidUnitCents: 500,
        quantity: 1,
      },
    ]);
    expect(purchases).toHaveLength(2);
    expect(
      purchases.reduce((total, purchase) => total + purchase.couponCents, 0),
    ).toBe(300);
  });

  it('does not treat a long coupon UPC as a Costco item number', () => {
    const adapted = adaptCostcoReceipts(numericLiveReceiptFixture);

    expect(adapted.transactions[0]?.coupons).not.toContainEqual(
      expect.objectContaining({ itemNumber: '123456789012' }),
    );
  });

  it('associates a coupon through an explicit nonzero associated item number', () => {
    const purchases = normalizeReceipts(
      adaptCostcoReceipts(numericLiveReceiptFixture),
      new Date('2026-08-18T00:00:00.000Z'),
    );

    expect(
      purchases.find(({ itemNumber }) => itemNumber === '1661969'),
    ).toMatchObject({ couponCents: 200, paidUnitCents: 1499 });
  });

  it('leaves an in-order discount unresolved when its referenced item number is absent', () => {
    const purchases = normalizeReceipts(
      adaptCostcoReceipts(numericLiveReceiptFixture),
      new Date('2026-08-18T00:00:00.000Z'),
    );

    expect(
      purchases.find(({ itemNumber }) => itemNumber === '300003'),
    ).toMatchObject({ couponCents: 0, paidUnitCents: 1000 });
    expect(purchases.some(({ itemNumber }) => itemNumber === '399999')).toBe(
      false,
    );
  });

  it('never emits a discount-description ledger line as a purchase', () => {
    const purchases = normalizeReceipts(
      adaptCostcoReceipts(numericLiveReceiptFixture),
      new Date('2026-08-18T00:00:00.000Z'),
    );

    expect(purchases.some(({ itemNumber }) => itemNumber === '377777')).toBe(
      false,
    );
  });

  it('skips voided or refunded items and coupons and skips return receipts', () => {
    const adapted = adaptCostcoReceipts(numericLiveReceiptFixture);
    const purchases = normalizeReceipts(
      adapted,
      new Date('2026-08-18T00:00:00.000Z'),
    );

    expect(purchases.map(({ itemNumber }) => itemNumber)).toEqual([
      '17120',
      '1661969',
      '300003',
      '200002',
    ]);
    expect(
      adapted.transactions[0]?.coupons.reduce(
        (total, coupon) =>
          total + Math.abs(Number((coupon as { amount: string }).amount)),
        0,
      ),
    ).toBe(5);
    expect(adapted.transactions).toHaveLength(2);
  });

  it.each([false, 0, 'false', '0', 'N', 'n', 'no', 'NO'])(
    'accepts %j as an explicit false wire flag',
    (flag) => {
      const adapted = adaptCostcoReceipts([
        {
          couponArray: [],
          itemArray: [
            {
              amount: '10.00',
              itemNumber: '100001',
              itemUnitPriceAmount: '10.00',
              refundFlag: flag,
              unit: '1',
              voidFlag: flag,
            },
          ],
          registerNumber: '1',
          transactionDateTime: '2026-08-18T09:00:00',
          transactionNumber: '1',
          transactionType: 'Purchase',
          warehouseNumber: '129',
        },
      ]);

      expect(adapted.transactions[0]?.items).toHaveLength(1);
    },
  );

  it.each([true, 1, 'true', '1', 'Y', 'y', 'yes', 'YES'])(
    'accepts %j as an explicit true wire flag',
    (flag) => {
      const adapted = adaptCostcoReceipts([
        {
          couponArray: [],
          itemArray: [
            {
              amount: '10.00',
              itemNumber: '100001',
              itemUnitPriceAmount: '10.00',
              unit: '1',
              voidFlag: flag,
            },
          ],
          registerNumber: '1',
          transactionDateTime: '2026-08-18T09:00:00',
          transactionNumber: '1',
          transactionType: 'Purchase',
          warehouseNumber: '129',
        },
      ]);

      expect(adapted.transactions[0]?.items).toEqual([]);
    },
  );

  it('conservatively rejects unknown item flags and parses coupon flags explicitly', () => {
    const base = {
      amount: '10.00',
      itemNumber: '100001',
      itemUnitPriceAmount: '10.00',
      unit: '1',
    };
    const adapted = adaptCostcoReceipts([
      {
        couponArray: [
          {
            amountCoupon: '-1.00',
            associatedItemNumber: '100001',
            voidflagCoupon: 'false',
          },
          {
            amountCoupon: '-2.00',
            associatedItemNumber: '100001',
            refundflagCoupon: 'true',
          },
          {
            amountCoupon: '-3.00',
            associatedItemNumber: '100001',
            voidflagCoupon: 'unexpected',
          },
        ],
        itemArray: [
          { ...base },
          { ...base, itemNumber: '200002', voidFlag: 'unexpected' },
        ],
        registerNumber: '1',
        transactionDateTime: '2026-08-18T09:00:00',
        transactionNumber: '1',
        transactionType: 'Purchase',
        warehouseNumber: '129',
      },
    ]);

    expect(
      adapted.transactions[0]?.items.map((item) => item.itemNumber),
    ).toEqual(['100001']);
    expect(adapted.transactions[0]?.coupons).toEqual([
      { amount: '-1.00', itemNumber: '100001' },
    ]);
  });

  it('builds a deterministic fallback receipt identity from numeric transaction fields and local timestamp', () => {
    const first = adaptCostcoReceipts(numericLiveReceiptFixture);
    const second = adaptCostcoReceipts(numericLiveReceiptFixture);

    expect(first.transactions[1]?.receiptId).toBe(
      '129:4:88:2026-08-12T09:15:00',
    );
    expect(first.transactions[1]?.purchasedAt).toBe('2026-08-12T09:15:00');
    expect(second).toEqual(first);
  });

  it('adapts validated live receipt fields into coupon-adjusted normalized purchases', async () => {
    const fetchFn: typeof fetch = async () =>
      Response.json({ data: { receipts: liveReceiptFixture } });
    const rawReceipts = await fetchReceipts(
      { clientId: 'client', idToken: 'token' },
      '2026-07-14',
      '2026-08-18',
      fetchFn,
    );

    const adapted = adaptCostcoReceipts(rawReceipts);
    const purchases = normalizeReceipts(
      adapted,
      new Date('2026-08-18T00:00:00.000Z'),
    );

    expect(adapted).toEqual({
      transactions: [
        {
          coupons: [{ amount: '-2.00', itemNumber: '100978861' }],
          items: [
            {
              description: 'Kirkland Trail Mix',
              itemNumber: '100978861',
              quantity: 2,
              unitPrice: '9.99',
            },
          ],
          purchasedAt: '2026-08-10T18:30:00.000Z',
          receiptId: '0000000000000000000002',
          transactionType: 'Purchase',
          warehouseNumber: '129',
        },
      ],
    });
    expect(purchases).toEqual([
      {
        couponCents: 200,
        description: 'Kirkland Trail Mix',
        grossUnitCents: 999,
        id: '0d99e59fdbfa0aa72f4479e8ba8e89ab6bcbc4714eb602060b8c95e9bbce66f8',
        itemNumber: '100978861',
        paidUnitCents: 899,
        purchaseChannel: 'warehouse',
        purchasedAt: '2026-08-10T18:30:00.000Z',
        quantity: 2,
        receiptId: '0000000000000000000002',
        warehouseNumber: '129',
      },
    ]);
    expect(
      normalizeReceipts(adaptCostcoReceipts(rawReceipts), new Date()),
    ).toEqual(purchases);
  });

  it('posts the authenticated receipt query for the requested 35-day window', async () => {
    const calls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
    const receipts = [{ transactionNumber: 'sanitized-transaction' }];
    const fetchFn: typeof fetch = async (input, init) => {
      calls.push({ input, init });
      return Response.json({ data: { receipts } });
    };

    const result = await fetchReceipts(
      { clientId: 'member-session-client', idToken: 'member-id-token' },
      '2026-07-14',
      '2026-08-18',
      fetchFn,
    );

    expect(result).toEqual(receipts);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.input).toBe(
      'https://ecom-api.costco.com/ebusiness/order/v1/orders/graphql',
    );
    expect(calls[0]?.init).toMatchObject({
      method: 'POST',
      headers: {
        'Client-Identifier': '481b1aec-aa3b-454b-b81b-48187e28f205',
        'Content-Type': 'application/json-patch+json',
        'Costco.Env': 'ecom',
        'Costco.Service': 'restOrders',
        'Costco-X-Authorization': 'Bearer member-id-token',
        'Costco-X-Wcs-Clientid': 'member-session-client',
      },
    });

    const body = JSON.parse(String(calls[0]?.init?.body)) as {
      query: string;
      variables: unknown;
    };
    expect(body.variables).toEqual({
      endDate: '2026-08-18',
      startDate: '2026-07-14',
    });
    expect(body.query).toMatch(/query receipts\(\$startDate: String!/);
    expect(body.query).toContain('itemArray { itemNumber');
    expect(body.query).toContain(
      'itemUnitPriceAmount unit amount taxFlag refundFlag resaleFlag voidFlag',
    );
    expect(body.query).toContain(
      'couponArray { couponNumber upcnumberCoupon associatedItemNumber unitCoupon',
    );
  });

  it('passes the application timeout signal to the receipt request', async () => {
    const controller = new AbortController();
    let receivedSignal: AbortSignal | null | undefined;
    const fetchFn: typeof fetch = async (_input, init) => {
      receivedSignal = init?.signal;
      return Response.json({ data: { receipts: [] } });
    };

    await fetchReceipts(
      { clientId: 'client', idToken: 'token' },
      '2026-07-14',
      '2026-08-18',
      fetchFn,
      controller.signal,
    );

    expect(receivedSignal).toBe(controller.signal);
  });

  it('maps an aborted receipt request to an actionable timeout error', async () => {
    const fetchFn: typeof fetch = async () => {
      throw new DOMException('deadline reached', 'TimeoutError');
    };

    await expect(
      fetchReceipts(
        { clientId: 'client', idToken: 'token' },
        '2026-07-14',
        '2026-08-18',
        fetchFn,
        new AbortController().signal,
      ),
    ).rejects.toThrow(/receipt request timed out/i);
  });

  it.each([401, 403])(
    'translates HTTP %s into an authentication-required error',
    async (status) => {
      const fetchFn: typeof fetch = async () =>
        Response.json({ errors: [{ message: 'denied' }] }, { status });

      await expect(
        fetchReceipts(
          { clientId: 'client', idToken: 'token' },
          '2026-07-14',
          '2026-08-18',
          fetchFn,
        ),
      ).rejects.toBeInstanceOf(AuthRequiredError);
    },
  );

  it.each([
    { errors: [{ message: 'session expired' }] },
    {
      data: { receipts: [] },
      errors: [{ extensions: { code: 'UNAUTHENTICATED' }, message: 'denied' }],
    },
  ])(
    'translates GraphQL authentication failures into login recovery',
    async (payload) => {
      const fetchFn: typeof fetch = async () => Response.json(payload);

      await expect(
        fetchReceipts(
          { clientId: 'client', idToken: 'token' },
          '2026-07-14',
          '2026-08-18',
          fetchFn,
        ),
      ).rejects.toBeInstanceOf(AuthRequiredError);
    },
  );

  it('rejects a non-authentication GraphQL error as an API failure', async () => {
    const fetchFn: typeof fetch = async () =>
      Response.json({
        data: { receipts: [] },
        errors: [{ message: 'upstream unavailable' }],
      });

    await expect(
      fetchReceipts(
        { clientId: 'client', idToken: 'token' },
        '2026-07-14',
        '2026-08-18',
        fetchFn,
      ),
    ).rejects.toBeInstanceOf(CostcoApiError);
  });

  it.each([
    {},
    { data: null },
    { data: {} },
    { data: { receipts: null } },
    { data: { receipts: {} } },
  ])('rejects malformed receipt response data: %j', async (payload) => {
    const fetchFn: typeof fetch = async () => Response.json(payload);

    await expect(
      fetchReceipts(
        { clientId: 'client', idToken: 'token' },
        '2026-07-14',
        '2026-08-18',
        fetchFn,
      ),
    ).rejects.toBeInstanceOf(CostcoApiError);
  });

  it('rejects a non-successful HTTP response before accepting data', async () => {
    const fetchFn: typeof fetch = async () =>
      Response.json({ data: { receipts: [] } }, { status: 503 });

    await expect(
      fetchReceipts(
        { clientId: 'client', idToken: 'token' },
        '2026-07-14',
        '2026-08-18',
        fetchFn,
      ),
    ).rejects.toThrow(/503/);
  });
});
