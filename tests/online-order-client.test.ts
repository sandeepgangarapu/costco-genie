import { describe, expect, it } from 'vitest';

import { AuthRequiredError, CostcoApiError } from '../src/costco/errors.js';
import { fetchOnlineOrderPurchases } from '../src/costco/online-order-client.js';

const tokens = {
  clientId: 'sanitized-client-value',
  idToken: 'sanitized-token-value',
};
const startDate = '2026-07-01';
const endDate = '2026-08-27';

interface GraphqlBody {
  readonly operationName: string;
  readonly query: string;
  readonly variables: Record<string, unknown>;
}

function listOrder(index: number) {
  return {
    orderNumber: `TEST-${String(index).padStart(4, '0')}`,
    orderedDate: '2026-08-01T12:00:00.000Z',
    orderStatus: 'Delivered',
  };
}

function line(overrides: Record<string, unknown> = {}) {
  return {
    isFeeItem: false,
    itemDescription: 'Sanitized merchandise',
    itemNumber: '100001',
    lineId: 'line-1',
    lineStatus: 'Delivered',
    merchandiseTotal: '24.68',
    orderedQuantity: 2,
    returnableQuantity: 2,
    shipment: { pickupCompletedDate: null },
    statusQuantities: {
      cancelled: 0,
      delivered: 2,
      returned: 0,
      shipped: 0,
    },
    totalReturnedQuantity: 0,
    unitPrice: '12.34',
    ...overrides,
  };
}

function detailOrder(
  orderNumber: string,
  orderLines: readonly unknown[] = [line()],
  overrides: Record<string, unknown> = {},
) {
  return {
    orderLines,
    orderNumber,
    orderedDate: '2026-08-01T12:00:00.000Z',
    orderStatus: 'Delivered',
    ...overrides,
  };
}

function listResponse(
  orders: readonly unknown[],
  totalNumberOfRecords = orders.length,
  pageNumber = 1,
  pageSize = 10,
): Response {
  return Response.json({
    data: {
      getOnlineOrders: {
        orders,
        pageNumber,
        pageSize,
        totalNumberOfRecords,
      },
    },
  });
}

function detailResponse(orders: readonly unknown[]): Response {
  return Response.json({ data: { getOrderDetails: { orders } } });
}

function bodyOf(init: RequestInit | undefined): GraphqlBody {
  return JSON.parse(String(init?.body)) as GraphqlBody;
}

function compactQuery(query: string): string {
  return query.replace(/\s+/gu, ' ').trim();
}

function successfulFetch(
  orders: readonly ReturnType<typeof listOrder>[],
  details: readonly ReturnType<typeof detailOrder>[],
  bodies: GraphqlBody[] = [],
  initializations: RequestInit[] = [],
): typeof fetch {
  return async (_input, init) => {
    initializations.push(init ?? {});
    const body = bodyOf(init);
    bodies.push(body);
    if (body.operationName === 'GetOnlineOrders') {
      const pageNumber = Number(body.variables.pageNumber);
      const pageSize = Number(body.variables.pageSize);
      const offset = (pageNumber - 1) * pageSize;
      return listResponse(
        orders.slice(offset, offset + pageSize),
        orders.length,
        pageNumber,
        pageSize,
      );
    }

    const orderNumbers = body.variables.orderNumbers as string[];
    return detailResponse(
      details.filter((order) => orderNumbers.includes(order.orderNumber)),
    );
  };
}

describe('fetchOnlineOrderPurchases', () => {
  it('paginates 11 orders and batches detail requests at the safe maximum', async () => {
    const orders = Array.from({ length: 11 }, (_, index) =>
      listOrder(index + 1),
    );
    const details = orders.map((order) => detailOrder(order.orderNumber));
    const bodies: GraphqlBody[] = [];

    const result = await fetchOnlineOrderPurchases(tokens, startDate, endDate, {
      fetchFn: successfulFetch(orders, details, bodies),
    });

    const listBodies = bodies.filter(
      ({ operationName }) => operationName === 'GetOnlineOrders',
    );
    const detailBodies = bodies.filter(
      ({ operationName }) => operationName === 'GetOrderDetails',
    );
    expect(listBodies.map(({ variables }) => variables)).toEqual([
      {
        endDate,
        pageNumber: 1,
        pageSize: 10,
        startDate,
        warehouseNumber: '847',
      },
      {
        endDate,
        pageNumber: 2,
        pageSize: 10,
        startDate,
        warehouseNumber: '847',
      },
    ]);
    expect(
      detailBodies.map(
        ({ variables }) => (variables.orderNumbers as string[]).length,
      ),
    ).toEqual([10, 1]);
    expect(result.purchases).toHaveLength(11);
  });

  it('owns minimal list and detail operations without sensitive fields', async () => {
    const bodies: GraphqlBody[] = [];
    const order = listOrder(1);

    await fetchOnlineOrderPurchases(tokens, startDate, endDate, {
      fetchFn: successfulFetch(
        [order],
        [detailOrder(order.orderNumber)],
        bodies,
      ),
    });

    const listQuery = compactQuery(bodies[0]?.query ?? '');
    const detailQuery = compactQuery(bodies[1]?.query ?? '');
    expect(listQuery).toBe(
      compactQuery(`
        query GetOnlineOrders(
          $startDate: String!
          $endDate: String!
          $pageNumber: Int!
          $pageSize: Int!
          $warehouseNumber: String!
        ) {
          getOnlineOrders(
            startDate: $startDate
            endDate: $endDate
            pageNumber: $pageNumber
            pageSize: $pageSize
            warehouseNumber: $warehouseNumber
          ) {
            orders { orderNumber orderedDate orderStatus }
            pageNumber
            pageSize
            totalNumberOfRecords
          }
        }
      `),
    );
    expect(detailQuery).toBe(
      compactQuery(`
        query GetOrderDetails($orderNumbers: [String!]!) {
          getOrderDetails(orderNumbers: $orderNumbers) {
            orders {
              orderNumber
              orderedDate
              orderStatus
              orderLines {
                lineId
                itemNumber
                itemDescription
                unitPrice
                orderedQuantity
                merchandiseTotal
                isFeeItem
                lineStatus
                totalReturnedQuantity
                returnableQuantity
                statusQuantities { cancelled returned shipped delivered }
                shipment { pickupCompletedDate }
              }
            }
          }
        }
      `),
    );
    const serialized = bodies
      .map(({ query }) => query)
      .join('\n')
      .toLowerCase();
    for (const forbidden of [
      'address',
      'email',
      'phone',
      'membership',
      'payment',
      'card',
      'tracking',
    ]) {
      expect(serialized.includes(forbidden)).toBe(false);
    }
  });

  it('passes the captured authenticated headers and creates a fresh timeout for each request', async () => {
    const order = listOrder(1);
    const initializations: RequestInit[] = [];
    const requestedTimeouts: number[] = [];
    const signals: AbortSignal[] = [];

    await fetchOnlineOrderPurchases(tokens, startDate, endDate, {
      createTimeoutSignal(milliseconds) {
        requestedTimeouts.push(milliseconds);
        const signal = new AbortController().signal;
        signals.push(signal);
        return signal;
      },
      fetchFn: successfulFetch(
        [order],
        [detailOrder(order.orderNumber)],
        [],
        initializations,
      ),
    });

    expect(requestedTimeouts).toEqual([30_000, 30_000]);
    expect(initializations.map(({ signal }) => signal)).toEqual(signals);
    expect(
      initializations.every((init) => {
        const headers = init.headers as Record<string, string>;
        return (
          headers['Costco-X-Authorization'] === `Bearer ${tokens.idToken}` &&
          headers['Costco-X-Wcs-Clientid'] === tokens.clientId
        );
      }),
    ).toBe(true);
  });

  it('normalizes fulfilled and pickup-completed merchandise lines', async () => {
    const order = listOrder(1);
    const details = [
      detailOrder(order.orderNumber, [
        line(),
        line({
          itemNumber: '100002',
          lineId: 'line-2',
          lineStatus: 'Ready for pickup',
          shipment: { pickupCompletedDate: '2026-08-02T10:00:00.000Z' },
          statusQuantities: {
            cancelled: 0,
            delivered: 0,
            returned: 0,
            shipped: 0,
          },
        }),
      ]),
    ];

    const result = await fetchOnlineOrderPurchases(tokens, startDate, endDate, {
      fetchFn: successfulFetch([order], details),
    });

    expect(result.purchases).toMatchObject([
      {
        couponCents: 0,
        grossUnitCents: 1234,
        itemNumber: '100001',
        paidUnitCents: 1234,
        purchaseChannel: 'costco_com',
        quantity: 2,
        receiptId: 'costco.com:TEST-0001',
        warehouseNumber: '847',
      },
      {
        itemNumber: '100002',
        purchaseChannel: 'costco_com',
        quantity: 2,
      },
    ]);
    expect(result.diagnostic).toMatchObject({
      channel: null,
      source: 'costco_online_orders',
      status: 'ok',
    });
    expect(result.diagnostic.message).toBe(
      'Costco.com order import completed with 2 purchases.',
    );
  });

  it('filters fees and wholly cancelled or returned lines while retaining partial quantities', async () => {
    const order = listOrder(1);
    const lines = [
      line({ isFeeItem: true, itemNumber: '100010', lineId: 'fee' }),
      line({
        itemNumber: '100011',
        lineId: 'cancelled',
        statusQuantities: {
          cancelled: 2,
          delivered: 0,
          returned: 0,
          shipped: 0,
        },
      }),
      line({
        itemNumber: '100012',
        lineId: 'partial-cancel',
        lineStatus: 'Partially cancelled',
        orderedQuantity: 3,
        statusQuantities: {
          cancelled: 1,
          delivered: 2,
          returned: 0,
          shipped: 0,
        },
      }),
      line({
        itemNumber: '100013',
        lineId: 'returned',
        totalReturnedQuantity: 2,
      }),
      line({
        itemNumber: '100014',
        lineId: 'partial-return',
        lineStatus: 'Partially returned',
        orderedQuantity: 3,
        statusQuantities: {
          cancelled: 0,
          delivered: 3,
          returned: 1,
          shipped: 0,
        },
        totalReturnedQuantity: 1,
      }),
    ];

    const result = await fetchOnlineOrderPurchases(tokens, startDate, endDate, {
      fetchFn: successfulFetch(
        [order],
        [detailOrder(order.orderNumber, lines)],
      ),
    });

    expect(
      result.purchases.map(({ itemNumber, quantity }) => ({
        itemNumber,
        quantity,
      })),
    ).toEqual([
      { itemNumber: '100012', quantity: 2 },
      { itemNumber: '100014', quantity: 2 },
    ]);
  });

  it('uses the greater returned count and clamps active quantity at zero', async () => {
    const order = listOrder(1);
    const result = await fetchOnlineOrderPurchases(tokens, startDate, endDate, {
      fetchFn: successfulFetch(
        [order],
        [
          detailOrder(order.orderNumber, [
            line({
              itemNumber: '100020',
              lineId: 'greater-total',
              orderedQuantity: 5,
              statusQuantities: {
                cancelled: 0,
                delivered: 5,
                returned: 1,
                shipped: 0,
              },
              totalReturnedQuantity: 3,
            }),
            line({
              itemNumber: '100021',
              lineId: 'greater-status',
              orderedQuantity: 5,
              statusQuantities: {
                cancelled: 0,
                delivered: 5,
                returned: 4,
                shipped: 0,
              },
              totalReturnedQuantity: 2,
            }),
            line({
              itemNumber: '100022',
              lineId: 'below-zero',
              orderedQuantity: 2,
              statusQuantities: {
                cancelled: 2,
                delivered: 2,
                returned: 4,
                shipped: 0,
              },
              totalReturnedQuantity: 3,
            }),
          ]),
        ],
      ),
    });

    expect(
      result.purchases.map(({ itemNumber, quantity }) => ({
        itemNumber,
        quantity,
      })),
    ).toEqual([
      { itemNumber: '100020', quantity: 2 },
      { itemNumber: '100021', quantity: 1 },
    ]);
  });

  it('filters invalid item, price, quantity, and unfulfilled lines', async () => {
    const order = listOrder(1);
    const result = await fetchOnlineOrderPurchases(tokens, startDate, endDate, {
      fetchFn: successfulFetch(
        [order],
        [
          detailOrder(order.orderNumber, [
            line({ itemNumber: 'not-an-item', lineId: 'bad-item' }),
            line({ itemNumber: '100031', lineId: 'bad-price', unitPrice: '0' }),
            line({
              itemNumber: '100032',
              lineId: 'bad-quantity',
              orderedQuantity: 1.5,
            }),
            line({
              itemNumber: '100033',
              lineId: 'unfulfilled',
              lineStatus: 'Processing',
              shipment: { pickupCompletedDate: null },
              statusQuantities: {
                cancelled: 0,
                delivered: 0,
                returned: 0,
                shipped: 0,
              },
            }),
          ]),
        ],
      ),
    });

    expect(result.purchases).toEqual([]);
  });

  it('keeps merchandise-total mismatches without inferring a discount', async () => {
    const order = listOrder(1);
    const result = await fetchOnlineOrderPurchases(tokens, startDate, endDate, {
      fetchFn: successfulFetch(
        [order],
        [detailOrder(order.orderNumber, [line({ merchandiseTotal: '10.00' })])],
      ),
    });

    expect(result.purchases[0]).toMatchObject({
      couponCents: 0,
      grossUnitCents: 1234,
      paidUnitCents: 1234,
      quantity: 2,
    });
  });

  it('derives a stable SHA-256 purchase ID from channel, order, and line', async () => {
    const order = listOrder(1);
    const fetchFn = successfulFetch([order], [detailOrder(order.orderNumber)]);

    const first = await fetchOnlineOrderPurchases(tokens, startDate, endDate, {
      fetchFn,
    });
    const second = await fetchOnlineOrderPurchases(tokens, startDate, endDate, {
      fetchFn,
    });

    expect(first.purchases[0]?.id).toBe(
      'a0f874c63730e0e7ee261d26442a02e0c7c92aefe9cbdb9201f8857ed3d737e1',
    );
    expect(second.purchases[0]?.id).toBe(first.purchases[0]?.id);
  });

  it.each([401, 403])('maps HTTP %i to AuthRequiredError', async (status) => {
    const fetchFn: typeof fetch = async () => new Response('', { status });

    await expect(
      fetchOnlineOrderPurchases(tokens, startDate, endDate, { fetchFn }),
    ).rejects.toBeInstanceOf(AuthRequiredError);
  });

  it('maps authentication GraphQL errors to AuthRequiredError', async () => {
    const fetchFn: typeof fetch = async () =>
      Response.json({ errors: [{ message: 'Unauthorized session' }] });

    await expect(
      fetchOnlineOrderPurchases(tokens, startDate, endDate, { fetchFn }),
    ).rejects.toBeInstanceOf(AuthRequiredError);
  });

  it.each([
    {
      name: 'timeout',
      response: () => {
        throw new DOMException('sanitized deadline', 'TimeoutError');
      },
    },
    {
      name: 'non-2xx response',
      response: () => new Response('', { status: 503 }),
    },
    {
      name: 'malformed payload',
      response: () => Response.json({ data: { getOnlineOrders: {} } }),
    },
  ])('throws a sanitized API error for a list $name', async ({ response }) => {
    const fetchFn: typeof fetch = async () => response();

    let error: unknown;
    try {
      await fetchOnlineOrderPurchases(tokens, startDate, endDate, { fetchFn });
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(CostcoApiError);
    const message = error instanceof Error ? error.message : '';
    expect(message.includes(tokens.idToken)).toBe(false);
    expect(message.includes(tokens.clientId)).toBe(false);
    expect(message.includes('TEST-0001')).toBe(false);
  });

  it('rejects repeated or non-advancing pagination without exposing order numbers', async () => {
    const firstPage = Array.from({ length: 10 }, (_, index) =>
      listOrder(index + 1),
    );
    const fetchFn: typeof fetch = async (_input, init) => {
      const body = bodyOf(init);
      const page = Number(body.variables.pageNumber);
      return listResponse(firstPage, 11, page, 10);
    };

    let error: unknown;
    try {
      await fetchOnlineOrderPurchases(tokens, startDate, endDate, { fetchFn });
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(CostcoApiError);
    const message = error instanceof Error ? error.message : '';
    expect(message.includes(firstPage[0]?.orderNumber ?? '')).toBe(false);
  });

  it('rejects missing order numbers as a sanitized pagination error', async () => {
    const fetchFn: typeof fetch = async () =>
      listResponse(
        [
          {
            orderedDate: '2026-08-01T12:00:00.000Z',
            orderStatus: 'Delivered',
          },
        ],
        1,
      );

    await expect(
      fetchOnlineOrderPurchases(tokens, startDate, endDate, { fetchFn }),
    ).rejects.toBeInstanceOf(CostcoApiError);
  });

  it('continues later detail batches after one sanitized batch failure', async () => {
    const orders = Array.from({ length: 11 }, (_, index) =>
      listOrder(index + 1),
    );
    let detailCalls = 0;
    const fetchFn: typeof fetch = async (_input, init) => {
      const body = bodyOf(init);
      if (body.operationName === 'GetOnlineOrders') {
        const pageNumber = Number(body.variables.pageNumber);
        const offset = (pageNumber - 1) * 10;
        return listResponse(
          orders.slice(offset, offset + 10),
          orders.length,
          pageNumber,
          10,
        );
      }
      detailCalls += 1;
      if (detailCalls === 1) return new Response('', { status: 503 });
      const laterOrder = orders[10];
      return detailResponse(
        laterOrder ? [detailOrder(laterOrder.orderNumber)] : [],
      );
    };

    const result = await fetchOnlineOrderPurchases(tokens, startDate, endDate, {
      fetchFn,
    });

    expect(detailCalls).toBe(2);
    expect(result.failedDetailBatches).toBe(1);
    expect(result.purchases).toHaveLength(1);
    expect(result.diagnostic).toMatchObject({
      channel: null,
      source: 'costco_online_orders',
      status: 'error',
    });
    expect(result.diagnostic.message).toBe(
      'Costco.com order import completed with 1 purchase and 1 failed detail batch.',
    );
  });

  it.each([
    { detailBatchSize: 0 },
    { detailBatchSize: 11 },
    { detailBatchSize: 1.5 },
    { pageSize: 0 },
    { pageSize: 11 },
    { pageSize: 1.5 },
  ])('rejects unsafe batch overrides %#', async (options) => {
    await expect(
      fetchOnlineOrderPurchases(tokens, startDate, endDate, options),
    ).rejects.toBeInstanceOf(RangeError);
  });
});
