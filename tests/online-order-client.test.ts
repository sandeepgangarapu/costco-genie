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
    orderHeaderId: `HEADER-${String(index).padStart(4, '0')}`,
    orderNumber: `TEST-${String(index).padStart(4, '0')}`,
    orderPlacedDate: '2026-08-01T12:00:00.000Z',
    status: 'Delivered',
  };
}

function itemStatus(
  overrides: Partial<
    Record<
      | 'cancellationRequested'
      | 'cancelled'
      | 'delivered'
      | 'returned'
      | 'shipped',
      number
    >
  > = {},
) {
  return {
    cancellationRequested: {
      quantity: overrides.cancellationRequested ?? 0,
    },
    cancelled: { quantity: overrides.cancelled ?? 0 },
    delivered: { quantity: overrides.delivered ?? 2 },
    returned: { quantity: overrides.returned ?? 0 },
    shipped: { quantity: overrides.shipped ?? 0 },
  };
}

function line(overrides: Record<string, unknown> = {}) {
  return {
    isFeeItem: false,
    itemDescription: 'Sanitized merchandise',
    itemNumber: '100001',
    itemStatus: itemStatus(),
    lineItemId: 'line-1',
    merchandiseTotalAmount: '24.68',
    orderStatus: 'Delivered',
    price: '12.34',
    quantity: 2,
    returnStatus: 'Returnable',
    returnableQuantity: 2,
    shipment: { pickUpCompletedDate: null },
    totalReturnedQuantity: 0,
    ...overrides,
  };
}

function detailOrder(
  orderNumber: string,
  orderLineItems: readonly unknown[] = [line()],
  overrides: Record<string, unknown> = {},
) {
  return {
    orderNumber,
    orderPlacedDate: '2026-08-01T12:00:00.000Z',
    shipToAddress: [{ orderLineItems }],
    status: 'Delivered',
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
      getOnlineOrders: [
        {
          bcOrders: orders,
          pageNumber,
          pageSize,
          totalNumberOfRecords,
        },
      ],
    },
  });
}

function detailResponse(order: unknown): Response {
  return Response.json({ data: { getOrderDetails: order } });
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
    const matches = details.filter((order) =>
      orderNumbers.includes(order.orderNumber),
    );
    return detailResponse(matches.length === 1 ? matches[0] : null);
  };
}

describe('fetchOnlineOrderPurchases', () => {
  it('paginates the live list array and requests each order detail separately', async () => {
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
    ).toEqual(Array(11).fill(1));
    expect(result.purchases).toHaveLength(11);
  });

  it('uses the live minimal list and detail operations without PII fields', async () => {
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
          $pageNumber: Int
          $pageSize: Int
          $warehouseNumber: String!
        ) {
          getOnlineOrders(
            startDate: $startDate
            endDate: $endDate
            pageNumber: $pageNumber
            pageSize: $pageSize
            warehouseNumber: $warehouseNumber
          ) {
            pageNumber
            pageSize
            totalNumberOfRecords
            bcOrders {
              orderHeaderId
              orderPlacedDate: orderedDate
              orderNumber: sourceOrderNumber
              status
            }
          }
        }
      `),
    );
    expect(detailQuery).toBe(
      compactQuery(`
        query GetOrderDetails($orderNumbers: [String]) {
          getOrderDetails(orderNumbers: $orderNumbers) {
            orderNumber: sourceOrderNumber
            orderPlacedDate: orderedDate
            status
            shipToAddress: orderShipTos {
              orderLineItems {
                orderStatus
                isFeeItem
                itemNumber
                itemDescription: sourceItemDescription
                price: unitPrice
                quantity: orderedTotalQuantity
                merchandiseTotalAmount
                lineItemId
                returnStatus
                totalReturnedQuantity
                returnableQuantity
                itemStatus {
                  cancelled { quantity }
                  returned { quantity }
                  shipped { quantity }
                  delivered { quantity }
                  cancellationRequested { quantity }
                }
                shipment { pickUpCompletedDate }
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
      'addressline',
      'city',
      'email',
      'phone',
      'membership',
      'payment',
      'card',
      'postalcode',
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
          itemStatus: itemStatus({ delivered: 0 }),
          lineItemId: 'line-2',
          orderStatus: 'Ready for pickup',
          shipment: { pickUpCompletedDate: '2026-08-02T10:00:00.000Z' },
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

  it('requires exact affirmative fulfillment or a real pickup-completion date', async () => {
    const order = listOrder(1);
    const noFulfillment = itemStatus({ delivered: 0 });
    const result = await fetchOnlineOrderPurchases(tokens, startDate, endDate, {
      fetchFn: successfulFetch(
        [order],
        [
          detailOrder(order.orderNumber, [
            line({
              itemNumber: '100101',
              itemStatus: noFulfillment,
              lineItemId: 'not-shipped',
              orderStatus: 'Not shipped',
              shipment: { pickUpCompletedDate: null },
            }),
            line({
              itemNumber: '100102',
              itemStatus: noFulfillment,
              lineItemId: 'not-picked-up',
              orderStatus: 'Not picked up',
              shipment: { pickUpCompletedDate: null },
            }),
            line({
              itemNumber: '100103',
              itemStatus: noFulfillment,
              lineItemId: 'invalid-pickup-text',
              orderStatus: 'Processing',
              shipment: { pickUpCompletedDate: 'pending' },
            }),
            line({
              itemNumber: '100104',
              itemStatus: noFulfillment,
              lineItemId: 'invalid-pickup-date',
              orderStatus: 'Processing',
              shipment: { pickUpCompletedDate: '2026-99-99' },
            }),
            line({
              itemNumber: '100105',
              itemStatus: noFulfillment,
              lineItemId: 'exact-shipped',
              orderStatus: '  SHIPPED  ',
              shipment: { pickUpCompletedDate: null },
            }),
            line({
              itemNumber: '100106',
              itemStatus: noFulfillment,
              lineItemId: 'exact-delivered',
              orderStatus: 'Delivered',
              shipment: { pickUpCompletedDate: null },
            }),
            line({
              itemNumber: '100107',
              itemStatus: noFulfillment,
              lineItemId: 'exact-pickup-completed',
              orderStatus: 'Pickup completed',
              shipment: { pickUpCompletedDate: null },
            }),
            line({
              itemNumber: '100108',
              itemStatus: noFulfillment,
              lineItemId: 'valid-pickup-date',
              orderStatus: 'Processing',
              shipment: { pickUpCompletedDate: '2026-08-02' },
            }),
            line({
              itemNumber: '100109',
              itemStatus: noFulfillment,
              lineItemId: 'valid-pickup-timestamp',
              orderStatus: 'Processing',
              shipment: {
                pickUpCompletedDate: '2026-08-02T10:00:00.000Z',
              },
            }),
          ]),
        ],
      ),
    });

    expect(result.purchases.map(({ itemNumber }) => itemNumber)).toEqual([
      '100105',
      '100106',
      '100107',
      '100108',
      '100109',
    ]);
  });

  it('filters fees and wholly cancelled or returned lines while retaining partial quantities', async () => {
    const order = listOrder(1);
    const lines = [
      line({ isFeeItem: true, itemNumber: '100010', lineItemId: 'fee' }),
      line({
        itemNumber: '100011',
        itemStatus: itemStatus({ cancelled: 2, delivered: 0 }),
        lineItemId: 'cancelled',
      }),
      line({
        itemNumber: '100012',
        itemStatus: itemStatus({ cancelled: 1 }),
        lineItemId: 'partial-cancel',
        orderStatus: 'Partially cancelled',
        quantity: 3,
      }),
      line({
        itemNumber: '100013',
        lineItemId: 'returned',
        totalReturnedQuantity: 2,
      }),
      line({
        itemNumber: '100014',
        itemStatus: itemStatus({ delivered: 3, returned: 1 }),
        lineItemId: 'partial-return',
        orderStatus: 'Partially returned',
        quantity: 3,
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
              itemStatus: itemStatus({ delivered: 5, returned: 1 }),
              lineItemId: 'greater-total',
              quantity: 5,
              totalReturnedQuantity: 3,
            }),
            line({
              itemNumber: '100021',
              itemStatus: itemStatus({ delivered: 5, returned: 4 }),
              lineItemId: 'greater-status',
              quantity: 5,
              totalReturnedQuantity: 2,
            }),
            line({
              itemNumber: '100022',
              itemStatus: itemStatus({ cancelled: 2, returned: 4 }),
              lineItemId: 'below-zero',
              quantity: 2,
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
            line({ itemNumber: 'not-an-item', lineItemId: 'bad-item' }),
            line({ itemNumber: '100031', lineItemId: 'bad-price', price: '0' }),
            line({
              itemNumber: '100032',
              lineItemId: 'bad-quantity',
              quantity: 1.5,
            }),
            line({
              itemNumber: '100033',
              itemStatus: itemStatus({ delivered: 0 }),
              lineItemId: 'unfulfilled',
              orderStatus: 'Processing',
              shipment: { pickUpCompletedDate: null },
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
        [
          detailOrder(order.orderNumber, [
            line({ merchandiseTotalAmount: '10.00' }),
          ]),
        ],
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

  it('maps a structured list error status to AuthRequiredError', async () => {
    const fetchFn: typeof fetch = async () =>
      Response.json({
        errors: [
          {
            extensions: { status: 401 },
            message: 'Request could not be completed',
          },
        ],
      });

    await expect(
      fetchOnlineOrderPurchases(tokens, startDate, endDate, { fetchFn }),
    ).rejects.toBeInstanceOf(AuthRequiredError);
  });

  it('maps a structured detail error code to AuthRequiredError', async () => {
    const order = listOrder(1);
    const fetchFn: typeof fetch = async (_input, init) => {
      const body = bodyOf(init);
      if (body.operationName === 'GetOnlineOrders') {
        return listResponse([order]);
      }
      return Response.json({
        errors: [
          {
            extensions: { code: '403' },
            message: 'Request could not be completed',
          },
        ],
      });
    };

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
      response: () => Response.json({ data: { getOnlineOrders: [] } }),
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

  it('rejects a reordered duplicate page before total coverage is reached', async () => {
    const repeated = [listOrder(1), listOrder(2), listOrder(3)];
    const fetchFn: typeof fetch = async (_input, init) => {
      const body = bodyOf(init);
      const pageNumber = Number(body.variables.pageNumber);
      return listResponse(
        pageNumber === 1 ? repeated : [...repeated].reverse(),
        6,
        pageNumber,
        3,
      );
    };

    await expect(
      fetchOnlineOrderPurchases(tokens, startDate, endDate, {
        fetchFn,
        pageSize: 3,
      }),
    ).rejects.toBeInstanceOf(CostcoApiError);
  });

  it('uses verified unique coverage when adjacent pages overlap but advance', async () => {
    const orders = Array.from({ length: 5 }, (_, index) =>
      listOrder(index + 1),
    );
    const bodies: GraphqlBody[] = [];
    const fetchFn: typeof fetch = async (_input, init) => {
      const body = bodyOf(init);
      bodies.push(body);
      if (body.operationName === 'GetOnlineOrders') {
        const pageNumber = Number(body.variables.pageNumber);
        return listResponse(
          pageNumber === 1
            ? orders.slice(0, 3)
            : [orders[2], orders[3], orders[4]],
          5,
          pageNumber,
          3,
        );
      }
      const requestedOrderNumbers = body.variables.orderNumbers as string[];
      return detailResponse(detailOrder(requestedOrderNumbers[0]!));
    };

    const result = await fetchOnlineOrderPurchases(tokens, startDate, endDate, {
      fetchFn,
      pageSize: 3,
    });

    expect(result.purchases).toHaveLength(5);
    expect(
      bodies.filter(({ operationName }) => operationName === 'GetOnlineOrders'),
    ).toHaveLength(2);
  });

  it('rejects missing order numbers as a sanitized pagination error', async () => {
    const fetchFn: typeof fetch = async () =>
      listResponse(
        [
          {
            orderHeaderId: 'HEADER-MISSING-NUMBER',
            orderPlacedDate: '2026-08-01T12:00:00.000Z',
            status: 'Delivered',
          },
        ],
        1,
      );

    await expect(
      fetchOnlineOrderPurchases(tokens, startDate, endDate, { fetchFn }),
    ).rejects.toBeInstanceOf(CostcoApiError);
  });

  it('continues later one-order detail requests after a sanitized failure', async () => {
    const orders = [listOrder(1), listOrder(2)];
    let detailCalls = 0;
    const fetchFn: typeof fetch = async (_input, init) => {
      const body = bodyOf(init);
      if (body.operationName === 'GetOnlineOrders') {
        return listResponse(orders);
      }
      detailCalls += 1;
      if (detailCalls === 1) return new Response('', { status: 503 });
      return detailResponse(detailOrder(orders[1]!.orderNumber));
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

  it.each(['missing', 'wrong-order', 'array', 'legacy-wrapper'] as const)(
    'rejects a malformed %s detail response and continues later requests',
    async (malformation) => {
      const orders = [listOrder(1), listOrder(2)];
      let detailCalls = 0;
      const fetchFn: typeof fetch = async (_input, init) => {
        const body = bodyOf(init);
        if (body.operationName === 'GetOnlineOrders') {
          return listResponse(orders);
        }
        detailCalls += 1;
        if (detailCalls === 2) {
          return detailResponse(detailOrder(orders[1]!.orderNumber));
        }
        if (malformation === 'missing') return detailResponse(null);
        if (malformation === 'wrong-order') {
          return detailResponse(detailOrder('UNREQUESTED-ORDER'));
        }
        const requested = detailOrder(orders[0]!.orderNumber);
        return detailResponse(
          malformation === 'array' ? [requested] : { orders: [requested] },
        );
      };

      const result = await fetchOnlineOrderPurchases(
        tokens,
        startDate,
        endDate,
        { fetchFn },
      );

      expect(detailCalls).toBe(2);
      expect(result.failedDetailBatches).toBe(1);
      expect(result.purchases.map(({ receiptId }) => receiptId)).toEqual([
        'costco.com:TEST-0002',
      ]);
      expect(result.diagnostic.status).toBe('error');
    },
  );

  it.each([
    { detailBatchSize: 0 },
    { detailBatchSize: 2 },
    { detailBatchSize: 10 },
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
