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
const DEFAULT_DETAIL_BATCH_SIZE = 1;
const MAX_SAFE_BATCH_SIZE = 10;
const DEFAULT_TIMEOUT_MILLISECONDS = 30_000;
const SOURCE = 'costco_online_orders';

const GET_ONLINE_ORDERS_QUERY = `
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
`;

const GET_ORDER_DETAILS_QUERY = `
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
`;

const wireScalarSchema = z.union([z.string(), z.number()]);
const nonemptyTextSchema = z.string().trim().min(1);
const listOrderSchema = z
  .object({
    orderHeaderId: wireScalarSchema,
    orderNumber: nonemptyTextSchema,
    orderPlacedDate: nonemptyTextSchema,
    status: z.string(),
  })
  .strict();
const listPageSchema = z
  .object({
    bcOrders: z.array(listOrderSchema),
    pageNumber: z.number().int().positive(),
    pageSize: z.number().int().positive(),
    totalNumberOfRecords: z.number().int().nonnegative(),
  })
  .strict();
const listResponseSchema = z
  .object({
    data: z
      .object({
        getOnlineOrders: z.array(listPageSchema).min(1),
      })
      .strict(),
    errors: z.array(z.unknown()).optional(),
  })
  .strict();

const itemStatusQuantitySchema = z
  .object({
    quantity: wireScalarSchema,
  })
  .strict();
const itemStatusSchema = z
  .object({
    cancellationRequested: z.array(itemStatusQuantitySchema),
    cancelled: z.array(itemStatusQuantitySchema),
    delivered: z.array(itemStatusQuantitySchema),
    returned: z.array(itemStatusQuantitySchema),
    shipped: z.array(itemStatusQuantitySchema),
  })
  .strict();
const shipmentEntrySchema = z
  .object({
    pickUpCompletedDate: z.string().trim().min(1).nullable(),
  })
  .strict();
const orderLineSchema = z
  .object({
    isFeeItem: z.boolean(),
    itemDescription: z.string().nullish(),
    itemNumber: wireScalarSchema,
    itemStatus: itemStatusSchema,
    lineItemId: wireScalarSchema,
    merchandiseTotalAmount: wireScalarSchema,
    orderStatus: z.string(),
    price: wireScalarSchema,
    quantity: wireScalarSchema,
    returnStatus: z.string().nullish(),
    returnableQuantity: wireScalarSchema,
    shipment: z.array(shipmentEntrySchema),
    totalReturnedQuantity: wireScalarSchema,
  })
  .strict();
const shipToSchema = z
  .object({
    orderLineItems: z.array(orderLineSchema),
  })
  .strict();
const detailOrderSchema = z
  .object({
    orderNumber: nonemptyTextSchema,
    orderPlacedDate: nonemptyTextSchema,
    shipToAddress: z.array(shipToSchema),
    status: z.string(),
  })
  .strict();
const detailResponseSchema = z
  .object({
    data: z
      .object({
        getOrderDetails: detailOrderSchema,
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
  safeDetailBatchSize(options.detailBatchSize ?? DEFAULT_DETAIL_BATCH_SIZE);
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

  for (const orderNumber of orderNumbers) {
    try {
      const payload = await postGraphql(
        {
          operationName: 'GetOrderDetails',
          query: GET_ORDER_DETAILS_QUERY,
          variables: { orderNumbers: [orderNumber] },
        },
        context,
      );
      const parsed = detailResponseSchema.safeParse(payload);
      if (!parsed.success || (parsed.data.errors?.length ?? 0) > 0) {
        throw new CostcoApiError(
          'Costco online-order detail response was malformed or errored',
        );
      }
      const returnedOrder = parsed.data.data.getOrderDetails;
      if (returnedOrder.orderNumber !== orderNumber) {
        throw new CostcoApiError(
          'Costco online-order detail response coverage was inconsistent',
        );
      }
      purchases.push(...normalizeOrder(returnedOrder));
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

    const page = parsed.data.data.getOnlineOrders[0];
    if (page === undefined) {
      throw new CostcoApiError(
        'Costco online-order list response was malformed or errored',
      );
    }
    if (
      page.pageNumber !== pageNumber ||
      page.pageSize !== pageSize ||
      page.bcOrders.length > pageSize ||
      (expectedTotal !== null && page.totalNumberOfRecords !== expectedTotal)
    ) {
      throw paginationError();
    }
    expectedTotal ??= page.totalNumberOfRecords;

    const pageKey = JSON.stringify(
      [...new Set(page.bcOrders.map(({ orderNumber }) => orderNumber))].sort(),
    );
    if (page.bcOrders.length > 0 && seenPages.has(pageKey)) {
      throw paginationError();
    }
    seenPages.add(pageKey);

    const previousUniqueRecords = seenOrderNumbers.size;
    for (const order of page.bcOrders) {
      if (seenOrderNumbers.has(order.orderNumber)) continue;
      seenOrderNumbers.add(order.orderNumber);
      orderNumbers.push(order.orderNumber);
    }
    const uniqueRecordsRead = seenOrderNumbers.size;
    if (
      uniqueRecordsRead > page.totalNumberOfRecords ||
      (uniqueRecordsRead === previousUniqueRecords &&
        uniqueRecordsRead < page.totalNumberOfRecords)
    ) {
      throw paginationError();
    }

    if (
      uniqueRecordsRead >= page.totalNumberOfRecords ||
      page.bcOrders.length < pageSize
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
  if (isWhollyInactiveStatus(order.status)) return [];
  return order.shipToAddress
    .flatMap(({ orderLineItems }) => orderLineItems)
    .flatMap((orderLine) => {
      if (
        orderLine.isFeeItem ||
        isWhollyInactiveStatus(orderLine.orderStatus)
      ) {
        return [];
      }

      const itemNumber = numericIdentifier(orderLine.itemNumber);
      const lineId = stableIdentifier(orderLine.lineItemId);
      const paidUnitCents = positiveMoneyCents(orderLine.price);
      const orderedQuantity = positiveInteger(orderLine.quantity);
      const cancellationRequestedQuantity = summedStatusQuantity(
        orderLine.itemStatus.cancellationRequested,
      );
      const cancelledQuantity = summedStatusQuantity(
        orderLine.itemStatus.cancelled,
      );
      const returnedStatusQuantity = summedStatusQuantity(
        orderLine.itemStatus.returned,
      );
      const totalReturnedQuantity = nonnegativeInteger(
        orderLine.totalReturnedQuantity,
      );
      const shippedQuantity = summedStatusQuantity(
        orderLine.itemStatus.shipped,
      );
      const deliveredQuantity = summedStatusQuantity(
        orderLine.itemStatus.delivered,
      );
      if (
        itemNumber === null ||
        lineId === null ||
        paidUnitCents === null ||
        orderedQuantity === null ||
        cancellationRequestedQuantity === null ||
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
        orderLine.shipment.some(({ pickUpCompletedDate }) =>
          hasPickupCompletion(pickUpCompletedDate),
        ) ||
        isFulfilledStatus(orderLine.orderStatus);
      if (!fulfilled) return [];

      const returned = Math.max(totalReturnedQuantity, returnedStatusQuantity);
      const activeQuantity = Math.max(
        0,
        Math.min(
          orderedQuantity,
          orderedQuantity - cancelledQuantity - returned,
        ),
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
          purchasedAt: order.orderPlacedDate,
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

function summedStatusQuantity(
  entries: readonly { readonly quantity: string | number }[],
): number | null {
  let total = 0;
  for (const { quantity } of entries) {
    const parsed = nonnegativeInteger(quantity);
    if (parsed === null || !Number.isSafeInteger(total + parsed)) return null;
    total += parsed;
  }
  return total;
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

function safeDetailBatchSize(value: number): number {
  if (value !== 1) {
    throw new RangeError('Online-order detail batch size must be 1');
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
  const normalized = status
    .trim()
    .toLowerCase()
    .replace(/[-_]+/gu, ' ')
    .replace(/\s+/gu, ' ');
  return new Set([
    'delivered',
    'partially delivered',
    'partially shipped',
    'picked up',
    'pickup completed',
    'shipped',
  ]).has(normalized);
}

function hasPickupCompletion(value: string | null | undefined): boolean {
  if (value === null || value === undefined) return false;
  const match =
    /^(\d{4})-(\d{2})-(\d{2})(?:T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})?)?$/u.exec(
      value,
    );
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const calendarDate = new Date(Date.UTC(year, month - 1, day));
  return (
    calendarDate.getUTCFullYear() === year &&
    calendarDate.getUTCMonth() === month - 1 &&
    calendarDate.getUTCDate() === day &&
    !Number.isNaN(Date.parse(value))
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
    if (hasStructuredAuthenticationStatus(error)) return true;
    try {
      return /auth|unauthori[sz]ed|forbidden|token|session|jwt/iu.test(
        JSON.stringify(error) ?? '',
      );
    } catch {
      return false;
    }
  });
}

function hasStructuredAuthenticationStatus(
  value: unknown,
  seen = new WeakSet<object>(),
): boolean {
  if (typeof value !== 'object' || value === null || seen.has(value)) {
    return false;
  }
  seen.add(value);
  if (Array.isArray(value)) {
    return value.some((entry) =>
      hasStructuredAuthenticationStatus(entry, seen),
    );
  }
  return Object.entries(value).some(([key, entry]) => {
    if (
      /^(?:code|status|statuscode)$/iu.test(key) &&
      (entry === 401 || entry === 403 || entry === '401' || entry === '403')
    ) {
      return true;
    }
    return hasStructuredAuthenticationStatus(entry, seen);
  });
}
