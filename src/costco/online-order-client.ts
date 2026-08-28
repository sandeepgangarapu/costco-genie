import { createHash } from 'node:crypto';

import { z } from 'zod';

import type { Purchase, ReportSourceDiagnostic } from '../domain/types.js';
import { parseMoneyToCents } from '../lib/money.js';
import type { CostcoTokens } from './browser-session.js';
import { AuthRequiredError, CostcoApiError } from './errors.js';

const ONLINE_ORDER_ENDPOINT =
  'https://ecom-api.costco.com/ebusiness/order/v1/orders/graphql';
const CLIENT_IDENTIFIER = '481b1aec-aa3b-454b-b81b-48187e28f205';
const ONLINE_WAREHOUSE_NUMBER = '847';
const DEFAULT_PAGE_SIZE = 10;
const DEFAULT_DETAIL_BATCH_SIZE = 10;
const MAX_SAFE_BATCH_SIZE = 10;
const DEFAULT_TIMEOUT_MILLISECONDS = 30_000;
const SOURCE = 'costco_online_orders';

const GET_ONLINE_ORDERS_QUERY = `
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
`;

const GET_ORDER_DETAILS_QUERY = `
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
`;

const wireScalarSchema = z.union([z.string(), z.number()]);
const nonemptyTextSchema = z.string().trim().min(1);
const listOrderSchema = z
  .object({
    orderNumber: nonemptyTextSchema,
    orderedDate: nonemptyTextSchema,
    orderStatus: z.string(),
  })
  .strict();
const listPageSchema = z
  .object({
    orders: z.array(listOrderSchema),
    pageNumber: z.number().int().positive(),
    pageSize: z.number().int().positive(),
    totalNumberOfRecords: z.number().int().nonnegative(),
  })
  .strict();
const listResponseSchema = z
  .object({
    data: z
      .object({
        getOnlineOrders: listPageSchema,
      })
      .strict(),
    errors: z.array(z.unknown()).optional(),
  })
  .strict();

const statusQuantitiesSchema = z
  .object({
    cancelled: wireScalarSchema,
    delivered: wireScalarSchema,
    returned: wireScalarSchema,
    shipped: wireScalarSchema,
  })
  .strict();
const shipmentSchema = z
  .object({
    pickupCompletedDate: z.string().trim().min(1).nullable(),
  })
  .strict();
const orderLineSchema = z
  .object({
    isFeeItem: z.boolean(),
    itemDescription: z.string().nullish(),
    itemNumber: wireScalarSchema,
    lineId: wireScalarSchema,
    lineStatus: z.string(),
    merchandiseTotal: wireScalarSchema,
    orderedQuantity: wireScalarSchema,
    returnableQuantity: wireScalarSchema,
    shipment: shipmentSchema.nullish(),
    statusQuantities: statusQuantitiesSchema,
    totalReturnedQuantity: wireScalarSchema,
    unitPrice: wireScalarSchema,
  })
  .strict();
const detailOrderSchema = z
  .object({
    orderLines: z.array(orderLineSchema),
    orderNumber: nonemptyTextSchema,
    orderedDate: nonemptyTextSchema,
    orderStatus: z.string(),
  })
  .strict();
const detailResponseSchema = z
  .object({
    data: z
      .object({
        getOrderDetails: z
          .object({ orders: z.array(detailOrderSchema) })
          .strict(),
      })
      .strict(),
    errors: z.array(z.unknown()).optional(),
  })
  .strict();

export interface OnlineOrderFetchOptions {
  readonly createTimeoutSignal?: (timeoutMilliseconds: number) => AbortSignal;
  readonly fetchFn?: typeof fetch;
  readonly pageSize?: number;
  readonly detailBatchSize?: number;
  readonly timeoutMilliseconds?: number;
}

export interface OnlineOrderFetchResult {
  readonly purchases: readonly Purchase[];
  readonly diagnostic: ReportSourceDiagnostic;
  readonly failedDetailBatches: number;
}

interface GraphqlRequest {
  readonly operationName: 'GetOnlineOrders' | 'GetOrderDetails';
  readonly query: string;
  readonly variables: Readonly<Record<string, unknown>>;
}

interface RequestContext {
  readonly createTimeoutSignal: (timeoutMilliseconds: number) => AbortSignal;
  readonly fetchFn: typeof fetch;
  readonly timeoutMilliseconds: number;
  readonly tokens: CostcoTokens;
}

export async function fetchOnlineOrderPurchases(
  tokens: CostcoTokens,
  startDate: string,
  endDate: string,
  options: OnlineOrderFetchOptions = {},
): Promise<OnlineOrderFetchResult> {
  const pageSize = safeBatchSize(
    options.pageSize ?? DEFAULT_PAGE_SIZE,
    'Online-order page size',
  );
  const detailBatchSize = safeBatchSize(
    options.detailBatchSize ?? DEFAULT_DETAIL_BATCH_SIZE,
    'Online-order detail batch size',
  );
  const context: RequestContext = {
    createTimeoutSignal:
      options.createTimeoutSignal ??
      ((milliseconds) => AbortSignal.timeout(milliseconds)),
    fetchFn: options.fetchFn ?? fetch,
    timeoutMilliseconds:
      options.timeoutMilliseconds ?? DEFAULT_TIMEOUT_MILLISECONDS,
    tokens,
  };
  const orderNumbers = await fetchOrderNumbers(
    startDate,
    endDate,
    pageSize,
    context,
  );
  const purchases: Purchase[] = [];
  let failedDetailBatches = 0;

  for (
    let offset = 0;
    offset < orderNumbers.length;
    offset += detailBatchSize
  ) {
    const batch = orderNumbers.slice(offset, offset + detailBatchSize);
    try {
      const payload = await postGraphql(
        {
          operationName: 'GetOrderDetails',
          query: GET_ORDER_DETAILS_QUERY,
          variables: { orderNumbers: batch },
        },
        context,
      );
      const parsed = detailResponseSchema.safeParse(payload);
      if (!parsed.success || (parsed.data.errors?.length ?? 0) > 0) {
        throw new CostcoApiError(
          'Costco online-order detail response was malformed or errored',
        );
      }
      const requested = new Set(batch);
      for (const order of parsed.data.data.getOrderDetails.orders) {
        if (!requested.has(order.orderNumber)) continue;
        purchases.push(...normalizeOrder(order));
      }
    } catch (error) {
      if (error instanceof AuthRequiredError) throw error;
      failedDetailBatches += 1;
    }
  }

  const observedAt = new Date().toISOString();
  return {
    diagnostic: {
      channel: null,
      message: diagnosticMessage(purchases.length, failedDetailBatches),
      observedAt,
      source: SOURCE,
      status: failedDetailBatches > 0 ? 'error' : 'ok',
    },
    failedDetailBatches,
    purchases,
  };
}

async function fetchOrderNumbers(
  startDate: string,
  endDate: string,
  pageSize: number,
  context: RequestContext,
): Promise<string[]> {
  const orderNumbers: string[] = [];
  const seenOrderNumbers = new Set<string>();
  const seenPages = new Set<string>();
  let expectedTotal: number | null = null;
  let pageNumber = 1;
  let recordsRead = 0;

  while (true) {
    const payload = await postGraphql(
      {
        operationName: 'GetOnlineOrders',
        query: GET_ONLINE_ORDERS_QUERY,
        variables: {
          endDate,
          pageNumber,
          pageSize,
          startDate,
          warehouseNumber: ONLINE_WAREHOUSE_NUMBER,
        },
      },
      context,
    );
    const parsed = listResponseSchema.safeParse(payload);
    if (!parsed.success || (parsed.data.errors?.length ?? 0) > 0) {
      throw new CostcoApiError(
        'Costco online-order list response was malformed or errored',
      );
    }

    const page = parsed.data.data.getOnlineOrders;
    if (
      page.pageNumber !== pageNumber ||
      page.pageSize !== pageSize ||
      page.orders.length > pageSize ||
      (expectedTotal !== null && page.totalNumberOfRecords !== expectedTotal)
    ) {
      throw paginationError();
    }
    expectedTotal ??= page.totalNumberOfRecords;

    const pageKey = JSON.stringify(
      page.orders.map(({ orderNumber }) => orderNumber),
    );
    if (page.orders.length > 0 && seenPages.has(pageKey)) {
      throw paginationError();
    }
    seenPages.add(pageKey);

    const previousRecordsRead = recordsRead;
    recordsRead += page.orders.length;
    if (recordsRead > page.totalNumberOfRecords) throw paginationError();
    if (
      recordsRead === previousRecordsRead &&
      recordsRead < page.totalNumberOfRecords
    ) {
      throw paginationError();
    }

    for (const order of page.orders) {
      if (seenOrderNumbers.has(order.orderNumber)) continue;
      seenOrderNumbers.add(order.orderNumber);
      orderNumbers.push(order.orderNumber);
    }

    if (
      recordsRead >= page.totalNumberOfRecords ||
      page.orders.length < pageSize
    ) {
      return orderNumbers;
    }
    pageNumber += 1;
  }
}

async function postGraphql(
  request: GraphqlRequest,
  context: RequestContext,
): Promise<unknown> {
  let response: Response;
  try {
    response = await context.fetchFn(ONLINE_ORDER_ENDPOINT, {
      body: JSON.stringify(request),
      headers: {
        'Client-Identifier': CLIENT_IDENTIFIER,
        'Content-Type': 'application/json-patch+json',
        'Costco.Env': 'ecom',
        'Costco.Service': 'restOrders',
        'Costco-X-Authorization': `Bearer ${context.tokens.idToken}`,
        'Costco-X-Wcs-Clientid': context.tokens.clientId,
      },
      method: 'POST',
      signal: context.createTimeoutSignal(context.timeoutMilliseconds),
    });
  } catch (error) {
    throw new CostcoApiError(
      isTimeoutError(error)
        ? 'Costco online-order request timed out'
        : 'Costco online-order request failed',
    );
  }

  if (response.status === 401 || response.status === 403) {
    throw new AuthRequiredError();
  }
  if (!response.ok) {
    throw new CostcoApiError('Costco online-order request failed');
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new CostcoApiError('Costco online-order response was not valid JSON');
  }
  if (hasAuthenticationError(payload)) throw new AuthRequiredError();
  return payload;
}

function normalizeOrder(order: z.infer<typeof detailOrderSchema>): Purchase[] {
  if (isWhollyInactiveStatus(order.orderStatus)) return [];
  return order.orderLines.flatMap((orderLine) => {
    if (orderLine.isFeeItem || isWhollyInactiveStatus(orderLine.lineStatus)) {
      return [];
    }

    const itemNumber = numericIdentifier(orderLine.itemNumber);
    const lineId = stableIdentifier(orderLine.lineId);
    const paidUnitCents = positiveMoneyCents(orderLine.unitPrice);
    const orderedQuantity = positiveInteger(orderLine.orderedQuantity);
    const cancelledQuantity = nonnegativeInteger(
      orderLine.statusQuantities.cancelled,
    );
    const returnedStatusQuantity = nonnegativeInteger(
      orderLine.statusQuantities.returned,
    );
    const totalReturnedQuantity = nonnegativeInteger(
      orderLine.totalReturnedQuantity,
    );
    const shippedQuantity = nonnegativeInteger(
      orderLine.statusQuantities.shipped,
    );
    const deliveredQuantity = nonnegativeInteger(
      orderLine.statusQuantities.delivered,
    );
    if (
      itemNumber === null ||
      lineId === null ||
      paidUnitCents === null ||
      orderedQuantity === null ||
      cancelledQuantity === null ||
      returnedStatusQuantity === null ||
      totalReturnedQuantity === null ||
      shippedQuantity === null ||
      deliveredQuantity === null
    ) {
      return [];
    }

    const fulfilled =
      shippedQuantity > 0 ||
      deliveredQuantity > 0 ||
      (orderLine.shipment?.pickupCompletedDate !== null &&
        orderLine.shipment?.pickupCompletedDate !== undefined) ||
      isFulfilledStatus(orderLine.lineStatus);
    if (!fulfilled) return [];

    const returned = Math.max(totalReturnedQuantity, returnedStatusQuantity);
    const activeQuantity = Math.max(
      0,
      Math.min(orderedQuantity, orderedQuantity - cancelledQuantity - returned),
    );
    if (activeQuantity <= 0) return [];

    const description = orderLine.itemDescription?.trim();
    return [
      {
        ...(description ? { description } : {}),
        couponCents: 0,
        grossUnitCents: paidUnitCents,
        id: purchaseId(order.orderNumber, lineId),
        itemNumber,
        paidUnitCents,
        purchaseChannel: 'costco_com',
        purchasedAt: order.orderedDate,
        quantity: activeQuantity,
        receiptId: `costco.com:${order.orderNumber}`,
        warehouseNumber: ONLINE_WAREHOUSE_NUMBER,
      },
    ];
  });
}

function purchaseId(orderNumber: string, lineId: string): string {
  return createHash('sha256')
    .update(JSON.stringify(['costco_com', orderNumber, lineId]))
    .digest('hex');
}

function positiveMoneyCents(value: string | number): number | null {
  const cents = parseMoneyToCents(String(value));
  return cents !== null && cents > 0 ? cents : null;
}

function positiveInteger(value: string | number): number | null {
  const parsed = integer(value);
  return parsed !== null && parsed > 0 ? parsed : null;
}

function nonnegativeInteger(value: string | number): number | null {
  const parsed = integer(value);
  return parsed !== null && parsed >= 0 ? parsed : null;
}

function integer(value: string | number): number | null {
  if (typeof value === 'string' && !/^\d+$/u.test(value)) return null;
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function numericIdentifier(value: string | number): string | null {
  const text = String(value).trim();
  return /^\d+$/u.test(text) ? text : null;
}

function stableIdentifier(value: string | number): string | null {
  const text = String(value).trim();
  return text.length > 0 ? text : null;
}

function safeBatchSize(value: number, label: string): number {
  if (!Number.isInteger(value) || value < 1 || value > MAX_SAFE_BATCH_SIZE) {
    throw new RangeError(`${label} must be an integer from 1 through 10`);
  }
  return value;
}

function diagnosticMessage(
  purchaseCount: number,
  failedDetailBatches: number,
): string {
  const purchases = `${String(purchaseCount)} ${purchaseCount === 1 ? 'purchase' : 'purchases'}`;
  if (failedDetailBatches === 0) {
    return `Costco.com order import completed with ${purchases}.`;
  }
  const batches = `${String(failedDetailBatches)} failed detail ${failedDetailBatches === 1 ? 'batch' : 'batches'}`;
  return `Costco.com order import completed with ${purchases} and ${batches}.`;
}

function paginationError(): CostcoApiError {
  return new CostcoApiError('Costco online-order pagination was inconsistent');
}

function isWhollyInactiveStatus(status: string): boolean {
  return (
    !/\bpartial(?:ly)?\b/iu.test(status) &&
    /\b(?:cancelled|canceled|returned)\b/iu.test(status)
  );
}

function isFulfilledStatus(status: string): boolean {
  return /\b(?:shipped|delivered|picked[ -]?up|pickup completed)\b/iu.test(
    status,
  );
}

function isTimeoutError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === 'AbortError' || error.name === 'TimeoutError')
  );
}

function hasAuthenticationError(payload: unknown): boolean {
  if (
    typeof payload !== 'object' ||
    payload === null ||
    !('errors' in payload) ||
    !Array.isArray(payload.errors)
  ) {
    return false;
  }
  return payload.errors.some((error) => {
    try {
      return /auth|unauthori[sz]ed|forbidden|token|session|jwt/iu.test(
        JSON.stringify(error) ?? '',
      );
    } catch {
      return false;
    }
  });
}
