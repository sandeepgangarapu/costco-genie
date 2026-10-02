import { z } from 'zod';

import type {
  PriceObservation,
  PurchaseChannel,
  ReportPriceChannels,
  ReportPriceObservation,
  ReportSourceDiagnostic,
} from '../domain/types.js';
import { parseMoneyToCents } from '../lib/money.js';
import {
  fetchSameDayPrices,
  type SameDayPriceOptions,
  type SameDayPriceObservation,
} from './same-day-client.js';

const PRODUCT_ENDPOINT =
  'https://ecom-api.costco.com/ebusiness/product/v1/products/graphql';
const PRODUCT_CLIENT_ID = '4900eb1f-0c10-4bd9-99c3-c59e6c1ecebf';
const MAX_BATCH_SIZE = 25;
// Each unofficial HTTP batch is bounded so the parent-held run lock releases.
const EXTERNAL_REQUEST_TIMEOUT_MILLISECONDS = 30_000;
const SAME_DAY_REQUEST_TIMEOUT_MILLISECONDS = 180_000;
const SOURCE = 'warehouse-price-api';
const CATALOG_SOURCE = 'costco_product_api';
const SAVINGS_SOURCE = 'warehouse_savings_page';
const WAREHOUSE_SAVINGS_URL = 'https://www.costco.com/o/-/warehouse-savings';
const DIGITS = /^\d+$/;

const productResponseSchema = z.object({
  data: z.object({
    products: z.object({
      catalogData: z.array(z.unknown()),
      fulfillmentData: z.array(z.unknown()).optional(),
    }),
  }),
  errors: z.array(z.unknown()).optional(),
});

const catalogProductSchema = z.object({
  itemNumber: z.string(),
  priceData: z.object({ price: z.unknown().optional() }).optional(),
  programTypes: z.union([z.string(), z.array(z.string())]).optional(),
});

const catalogItemSchema = z.object({ itemNumber: z.string() });

export interface WarehousePriceRequest {
  readonly description?: string;
  readonly itemNumber: string;
  readonly warehouseNumber: string;
}

export interface PriceRequest extends WarehousePriceRequest {
  readonly purchaseChannel: PurchaseChannel;
}

export interface WarehousePriceOptions {
  readonly batchSize?: number;
  readonly createTimeoutSignal?: (timeoutMilliseconds: number) => AbortSignal;
  readonly fetchFn?: typeof fetch;
  readonly now?: () => Date;
  readonly timeoutMilliseconds?: number;
  readonly sameDayMarkupPercent?: number;
  readonly sameDayPostalCode?: string;
  readonly sameDayRepresentativeAddress?: string;
  readonly sameDayPriceFetcher?: (
    requests: readonly PriceRequest[],
    options: SameDayPriceOptions,
  ) => Promise<SameDayPriceObservation[]>;
}

export interface ReportPriceEvidenceItem {
  readonly purchaseChannel: PurchaseChannel;
  readonly itemNumber: string;
  readonly warehouseNumber: string;
  readonly prices: Omit<ReportPriceChannels, 'receiptHistory'>;
}

export interface ReportPriceEvidenceResult {
  readonly diagnostics: readonly ReportSourceDiagnostic[];
  readonly items: readonly ReportPriceEvidenceItem[];
}

interface IndexedRequest {
  readonly index: number;
  readonly request: WarehousePriceRequest;
}

function unresolved(
  request: WarehousePriceRequest,
  observedAt: string,
  reason: string,
): PriceObservation {
  return {
    itemNumber: request.itemNumber,
    observedAt,
    source: SOURCE,
    unitPriceCents: null,
    unresolvedReason: reason,
    warehouseNumber: request.warehouseNumber,
  };
}

function productQuery(
  itemNumbers: readonly string[],
  warehouseNumber: string,
): string {
  const items = itemNumbers.map((itemNumber) => `"${itemNumber}"`).join(',');
  return `query {
    products(
      itemNumbers: [${items}],
      clientId: "${PRODUCT_CLIENT_ID}",
      locale: "en-us",
      warehouseNumber: "${warehouseNumber}"
    ) {
      catalogData {
        itemNumber
        programTypes
        priceData { price }
      }
      fulfillmentData { itemNumber warehouseNumber }
    }
  }`;
}

function hasWarehouseProgram(programTypes: string | string[] | undefined) {
  const programs = Array.isArray(programTypes)
    ? programTypes
    : (programTypes?.split(/[,|\s]+/) ?? []);
  return programs.includes('WH');
}

function mapProduct(
  indexed: IndexedRequest,
  catalogData: readonly unknown[],
  observedAt: string,
): PriceObservation {
  const rawProduct = catalogData.find((value) => {
    const parsed = catalogProductSchema.safeParse(value);
    return (
      parsed.success && parsed.data.itemNumber === indexed.request.itemNumber
    );
  });

  if (rawProduct === undefined) {
    return unresolved(indexed.request, observedAt, 'product_not_found');
  }

  const product = catalogProductSchema.parse(rawProduct);
  if (!hasWarehouseProgram(product.programTypes)) {
    return unresolved(indexed.request, observedAt, 'not_warehouse_price');
  }

  const cents = parseWirePriceToCents(product.priceData?.price);
  if (cents === null || cents <= 0) {
    return unresolved(indexed.request, observedAt, 'invalid_price');
  }

  return {
    itemNumber: indexed.request.itemNumber,
    observedAt,
    source: SOURCE,
    unitPriceCents: cents,
    unresolvedReason: null,
    warehouseNumber: indexed.request.warehouseNumber,
  };
}

function parseWirePriceToCents(value: unknown): number | null {
  if (typeof value === 'string') {
    // Costco's product API can serialize cent prices with extra trailing zeros
    // (for example, "29.99000"). Keep rejecting nonzero sub-cent precision.
    return parseMoneyToCents(value.replace(/(\.\d{2})0+$/u, '$1'));
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return parseMoneyToCents(String(value));
  }
  return null;
}

function validatedBatchSize(configuredBatchSize: number): number {
  if (!Number.isInteger(configuredBatchSize) || configuredBatchSize <= 0) {
    throw new RangeError('Price batch size must be a positive integer');
  }
  return Math.min(configuredBatchSize, MAX_BATCH_SIZE);
}

async function fetchBatch(
  batch: readonly IndexedRequest[],
  warehouseNumber: string,
  fetchFn: typeof fetch,
  observedAt: string,
  signal: AbortSignal,
): Promise<Array<{ index: number; observation: PriceObservation }>> {
  try {
    const response = await fetchFn(PRODUCT_ENDPOINT, {
      body: JSON.stringify({
        query: productQuery(
          batch.map(({ request }) => request.itemNumber),
          warehouseNumber,
        ),
        variables: {},
      }),
      credentials: 'omit',
      headers: {
        'Content-Type': 'application/json',
        'client-identifier': PRODUCT_CLIENT_ID,
        'costco.env': 'ecom',
        'costco.service': 'restProduct',
      },
      method: 'POST',
      signal,
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const payload: unknown = await response.json();
    const parsed = productResponseSchema.safeParse(payload);
    if (!parsed.success || (parsed.data.errors?.length ?? 0) > 0) {
      throw new Error('Malformed or errored GraphQL response');
    }

    return batch.map((indexed) => ({
      index: indexed.index,
      observation: mapProduct(
        indexed,
        parsed.data.data.products.catalogData,
        observedAt,
      ),
    }));
  } catch {
    return batch.map((indexed) => ({
      index: indexed.index,
      observation: unresolved(indexed.request, observedAt, 'batch_failed'),
    }));
  }
}

export async function fetchWarehousePrices(
  requests: readonly WarehousePriceRequest[],
  options: WarehousePriceOptions = {},
): Promise<PriceObservation[]> {
  const batchSize = validatedBatchSize(options.batchSize ?? MAX_BATCH_SIZE);
  const fetchFn = options.fetchFn ?? fetch;
  const createTimeoutSignal =
    options.createTimeoutSignal ??
    ((milliseconds) => AbortSignal.timeout(milliseconds));
  const timeoutMilliseconds =
    options.timeoutMilliseconds ?? EXTERNAL_REQUEST_TIMEOUT_MILLISECONDS;
  const observedAt = (options.now ?? (() => new Date()))().toISOString();
  const observations: Array<PriceObservation | undefined> = Array.from({
    length: requests.length,
  });
  const groups = new Map<string, IndexedRequest[]>();

  requests.forEach((request, index) => {
    if (!DIGITS.test(request.itemNumber)) {
      observations[index] = unresolved(
        request,
        observedAt,
        'invalid_item_number',
      );
      return;
    }
    if (!DIGITS.test(request.warehouseNumber)) {
      observations[index] = unresolved(
        request,
        observedAt,
        'invalid_warehouse_number',
      );
      return;
    }

    const group = groups.get(request.warehouseNumber) ?? [];
    group.push({ index, request });
    groups.set(request.warehouseNumber, group);
  });

  for (const [warehouseNumber, group] of groups) {
    for (let offset = 0; offset < group.length; offset += batchSize) {
      const results = await fetchBatch(
        group.slice(offset, offset + batchSize),
        warehouseNumber,
        fetchFn,
        observedAt,
        createTimeoutSignal(timeoutMilliseconds),
      );
      for (const result of results) {
        observations[result.index] = result.observation;
      }
    }
  }

  return observations.filter(
    (observation): observation is PriceObservation => observation !== undefined,
  );
}

export async function fetchReportPriceEvidence(
  requests: readonly PriceRequest[],
  options: WarehousePriceOptions = {},
): Promise<ReportPriceEvidenceResult> {
  validatedBatchSize(options.batchSize ?? MAX_BATCH_SIZE);
  const now = options.now ?? (() => new Date());
  const observed = now();
  const observedAt = observed.toISOString();
  const fetchFn = options.fetchFn ?? fetch;
  const uniqueRequests = deduplicatePriceRequests(requests);
  const warehouseRequests = uniqueRequests.filter(
    (request) => request.purchaseChannel === 'warehouse',
  );
  const warehouseObservations =
    warehouseRequests.length === 0
      ? []
      : await fetchWarehousePrices(warehouseRequests, {
          ...options,
          fetchFn,
          now: () => observed,
        });
  const online = await fetchOnlinePrices(uniqueRequests, {
    ...options,
    fetchFn,
    now: () => observed,
  });
  const sameDay =
    warehouseRequests.length === 0
      ? {
          items: [],
          diagnostic: notApplicableDiagnostic(
            'same_day',
            'same_day',
            observedAt,
          ),
        }
      : await fetchSameDayEvidence(warehouseRequests, options, observed);
  const sameDayByKey = new Map(
    sameDay.items.map((value) => [sourcePriceKey(value), value]),
  );
  const savingsRequests = warehouseRequests.filter((request) => {
    const price = sameDayByKey.get(sourcePriceKey(request));
    return price === undefined || !usableReportPrice(price);
  });
  const savings =
    savingsRequests.length === 0
      ? {
          items: [],
          diagnostic: notApplicableDiagnostic(
            'warehouse_savings',
            SAVINGS_SOURCE,
            observedAt,
          ),
        }
      : await fetchSavingsPrices(
          savingsRequests,
          observed,
          fetchFn,
          (
            options.createTimeoutSignal ??
            ((milliseconds) => AbortSignal.timeout(milliseconds))
          )(
            options.timeoutMilliseconds ??
              EXTERNAL_REQUEST_TIMEOUT_MILLISECONDS,
          ),
        );
  const warehouseByKey = new Map(
    warehouseObservations.map((value) => [sourcePriceKey(value), value]),
  );
  const onlineByKey = new Map(
    online.items.map((value) => [evidenceKey(value), value]),
  );
  const savingsByKey = new Map(
    savings.items.map((value) => [sourcePriceKey(value), value]),
  );
  const items = uniqueRequests.map((request) => {
    const sourceKey = sourcePriceKey(request);
    const onlineRecord = onlineByKey.get(evidenceKey(request));
    if (request.purchaseChannel === 'costco_com') {
      return {
        purchaseChannel: request.purchaseChannel,
        itemNumber: request.itemNumber,
        warehouseNumber: request.warehouseNumber,
        prices: {
          warehouse: unavailable('warehouse', 'not_applicable'),
          warehouseSavings: unavailable('warehouse_savings', 'not_applicable'),
          costcoCom: onlineRecord
            ? reportPriceOnly(onlineRecord)
            : unavailable('costco_com', 'product_not_found'),
          sameDay: unavailable('same_day', 'not_applicable'),
        },
      };
    }

    const warehouse = warehouseByKey.get(sourceKey);
    const savingsRecord = savingsByKey.get(sourceKey);
    const savingsPrice = savingsRecord
      ? reportPriceOnly(savingsRecord)
      : unavailable('warehouse_savings', 'item_not_advertised');
    const apiWarehouse = warehouse
      ? reportPriceFromWarehouse(warehouse)
      : unavailable('warehouse', 'warehouse_price_missing');
    const currentWarehouse = usableReportPrice(apiWarehouse)
      ? apiWarehouse
      : usableReportPrice(savingsPrice)
        ? {
            ...savingsPrice,
            channel: 'warehouse' as const,
          }
        : apiWarehouse;
    return {
      purchaseChannel: request.purchaseChannel,
      itemNumber: request.itemNumber,
      warehouseNumber: request.warehouseNumber,
      prices: {
        warehouse: currentWarehouse,
        warehouseSavings: savingsPrice,
        costcoCom: onlineRecord
          ? reportPriceOnly(onlineRecord)
          : unavailable('costco_com', 'product_not_found'),
        sameDay: sameDayByKey.get(sourceKey)
          ? reportPriceOnly(sameDayByKey.get(sourceKey)!)
          : unavailable('same_day', 'source_not_configured'),
      },
    };
  });

  return {
    items,
    diagnostics: [
      diagnostic(
        'warehouse',
        SOURCE,
        warehouseRequests.length === 0
          ? 'unavailable'
          : warehouseObservations.some(
                (value) => value.unresolvedReason === 'batch_failed',
              )
            ? 'error'
            : 'ok',
        observedAt,
        warehouseRequests.length === 0
          ? 'Current warehouse product lookup is not applicable.'
          : 'Current warehouse product lookup completed.',
      ),
      online.diagnostic,
      savings.diagnostic,
      sameDay.diagnostic,
    ],
  };
}

async function fetchSameDayEvidence(
  requests: readonly PriceRequest[],
  options: WarehousePriceOptions,
  observed: Date,
): Promise<{
  items: SameDayPriceObservation[];
  diagnostic: ReportSourceDiagnostic;
}> {
  const observedAt = observed.toISOString();
  const postalCode = options.sameDayPostalCode;
  if (postalCode === undefined || options.sameDayMarkupPercent === undefined) {
    return {
      items: [],
      diagnostic: diagnostic(
        'same_day',
        'same_day',
        'unavailable',
        observedAt,
        'Same-Day source is not configured.',
      ),
    };
  }

  const sameDayPriceFetcher = options.sameDayPriceFetcher ?? fetchSameDayPrices;
  let items: SameDayPriceObservation[];
  try {
    items = await sameDayPriceFetcher(requests, {
      now: () => observed,
      postalCode,
      deliveryAddress: options.sameDayRepresentativeAddress,
      timeout: SAME_DAY_REQUEST_TIMEOUT_MILLISECONDS,
    });
  } catch {
    const source = `same_day_guest_storefront_zip_${postalCode}`;
    return {
      items: requests.map((request) => ({
        ...request,
        ...unavailable('same_day', 'source_failed'),
      })),
      diagnostic: diagnostic(
        'same_day',
        source,
        'error',
        observedAt,
        `Same-Day guest storefront lookup for ZIP ${postalCode} failed.`,
      ),
    };
  }
  const failed = items.some((item) =>
    [
      'browser_launch_failed',
      'deadline_exceeded',
      'postal_code_not_confirmed',
      'search_failed',
    ].includes(item.unavailableReason ?? ''),
  );
  const source = `same_day_guest_storefront_zip_${postalCode}`;
  return {
    items,
    diagnostic: diagnostic(
      'same_day',
      source,
      failed ? 'error' : 'ok',
      observedAt,
      failed
        ? `Same-Day guest storefront lookup for ZIP ${postalCode} completed with one or more failures.`
        : `Same-Day guest storefront lookup for ZIP ${postalCode} completed.`,
    ),
  };
}

async function fetchOnlinePrices(
  requests: readonly PriceRequest[],
  options: WarehousePriceOptions,
): Promise<{
  items: Array<ReportPriceObservation & PriceRequest>;
  diagnostic: ReportSourceDiagnostic;
}> {
  const fetchFn = options.fetchFn ?? fetch;
  const observedAt = (options.now ?? (() => new Date()))().toISOString();
  const batchSize = validatedBatchSize(options.batchSize ?? MAX_BATCH_SIZE);
  const createTimeoutSignal =
    options.createTimeoutSignal ??
    ((milliseconds: number) => AbortSignal.timeout(milliseconds));
  const timeoutMilliseconds =
    options.timeoutMilliseconds ?? EXTERNAL_REQUEST_TIMEOUT_MILLISECONDS;
  const groups = new Map<string, PriceRequest[]>();
  const items: Array<ReportPriceObservation & PriceRequest> = [];
  let executableRequests = 0;
  for (const request of requests) {
    if (!DIGITS.test(request.itemNumber)) {
      items.push({
        ...request,
        ...unavailable('costco_com', 'invalid_item_number'),
      });
      continue;
    }
    if (!DIGITS.test(request.warehouseNumber)) {
      items.push({
        ...request,
        ...unavailable('costco_com', 'invalid_scope'),
      });
      continue;
    }
    executableRequests += 1;
    const values = groups.get(request.warehouseNumber) ?? [];
    values.push(request);
    groups.set(request.warehouseNumber, values);
  }
  let failedBatches = 0;
  for (const [warehouseNumber, group] of groups) {
    for (let offset = 0; offset < group.length; offset += batchSize) {
      const batch = group.slice(offset, offset + batchSize);
      try {
        const response = await fetchFn(PRODUCT_ENDPOINT, {
          body: JSON.stringify({
            query: productQuery(
              [...new Set(batch.map((value) => value.itemNumber))],
              warehouseNumber,
            ),
            variables: {},
          }),
          credentials: 'omit',
          headers: {
            'Content-Type': 'application/json',
            'client-identifier': PRODUCT_CLIENT_ID,
            'costco.env': 'ecom',
            'costco.service': 'restProduct',
          },
          method: 'POST',
          signal: createTimeoutSignal(timeoutMilliseconds),
        });
        if (!response.ok) throw new Error(`HTTP ${String(response.status)}`);
        const parsed = productResponseSchema.safeParse(await response.json());
        if (!parsed.success || (parsed.data.errors?.length ?? 0) > 0) {
          throw new Error('Malformed or errored GraphQL response');
        }
        for (const request of batch) {
          const exactEntries = parsed.data.data.products.catalogData.filter(
            (value) => {
              const item = catalogItemSchema.safeParse(value);
              return (
                item.success && item.data.itemNumber === request.itemNumber
              );
            },
          );
          const parsedProduct =
            exactEntries.length === 1
              ? catalogProductSchema.safeParse(exactEntries[0])
              : null;
          const product = parsedProduct?.success ? parsedProduct.data : null;
          const cents = parseWirePriceToCents(product?.priceData?.price);
          items.push({
            ...request,
            ...(cents !== null && cents > 0
              ? available('costco_com', cents, CATALOG_SOURCE, observedAt)
              : unavailable(
                  'costco_com',
                  exactEntries.length === 0
                    ? 'product_not_found'
                    : exactEntries.length > 1
                      ? 'ambiguous_price'
                      : 'invalid_price',
                )),
          });
        }
      } catch {
        failedBatches += 1;
        items.push(
          ...batch.map((request) => ({
            ...request,
            ...unavailable('costco_com', 'batch_failed'),
          })),
        );
      }
    }
  }
  return {
    items,
    diagnostic: diagnostic(
      'costco_com',
      CATALOG_SOURCE,
      executableRequests === 0
        ? 'unavailable'
        : failedBatches > 0
          ? 'error'
          : 'ok',
      observedAt,
      requests.length === 0
        ? 'Costco.com product lookup is not applicable.'
        : executableRequests === 0
          ? 'Costco.com product lookup was not run because no request had both a valid item number and price scope.'
          : failedBatches > 0
            ? 'Costco.com lookup completed, but one or more batches failed.'
            : 'Costco.com product lookup completed.',
    ),
  };
}

async function fetchSavingsPrices(
  requests: readonly PriceRequest[],
  now: Date,
  fetchFn: typeof fetch,
  signal: AbortSignal,
): Promise<{
  items: Array<ReportPriceObservation & PriceRequest>;
  diagnostic: ReportSourceDiagnostic;
}> {
  const observedAt = now.toISOString();
  try {
    const response = await fetchFn(WAREHOUSE_SAVINGS_URL, { signal });
    if (!response.ok) throw new Error(`HTTP ${String(response.status)}`);
    const html = await response.text();
    return {
      items: requests.map((request) => ({
        ...request,
        ...parseSavingsForItem(html, request.itemNumber, now, observedAt),
      })),
      diagnostic: diagnostic(
        'warehouse_savings',
        SAVINGS_SOURCE,
        'ok',
        observedAt,
        'Warehouse Savings page refreshed.',
      ),
    };
  } catch {
    return {
      items: requests.map((request) => ({
        ...request,
        ...unavailable('warehouse_savings', 'source_failed'),
      })),
      diagnostic: diagnostic(
        'warehouse_savings',
        SAVINGS_SOURCE,
        'error',
        observedAt,
        'Warehouse Savings page could not be refreshed.',
      ),
    };
  }
}

function parseSavingsForItem(
  html: string,
  itemNumber: string,
  now: Date,
  observedAt: string,
): ReportPriceObservation {
  const hydrated = parseHydrationSavings(html, itemNumber, now, observedAt);
  if (hydrated !== null) return hydrated;

  const articlePattern = /<article\b([^>]*)>([\s\S]*?)<\/article>/giu;
  for (const match of html.matchAll(articlePattern)) {
    const attributes = match[1] ?? '';
    const text = stripHtml(match[2] ?? '');
    if (attribute(attributes, 'data-item-number') !== itemNumber) continue;
    const evidence = (reason: string) => ({
      ...unavailable('warehouse_savings', reason),
      observedAt,
      promotionText: promotionText(text),
      source: SAVINGS_SOURCE,
    });
    if (/item numbers? vary/iu.test(text))
      return evidence('variable_item_numbers');
    if (
      /online\s*only/iu.test(text) ||
      attribute(attributes, 'data-applicability') === 'online'
    ) {
      return evidence('online_only');
    }
    const startDate = attribute(attributes, 'data-start-date');
    const endDate = attribute(attributes, 'data-end-date');
    if (
      !startDate ||
      !endDate ||
      !isCurrentDateRange(startDate, endDate, now)
    ) {
      return evidence('promotion_not_current');
    }
    if (attribute(attributes, 'data-applicability') !== 'warehouse') {
      return evidence('warehouse_applicability_not_stated');
    }
    const cents = parseWirePriceToCents(
      attribute(attributes, 'data-final-price')?.replace(/^\$/u, ''),
    );
    if (cents === null || cents <= 0) return evidence('final_price_not_listed');
    return {
      ...available('warehouse_savings', cents, SAVINGS_SOURCE, observedAt),
      promotionText: promotionText(text),
    };
  }
  return unavailable('warehouse_savings', 'item_not_advertised');
}

function parseHydrationSavings(
  html: string,
  itemNumber: string,
  now: Date,
  observedAt: string,
): ReportPriceObservation | null {
  const normalized = html.replaceAll('\\"', '"');
  const marker = `"itemNumber":"${itemNumber}"`;
  const itemIndex = normalized.indexOf(marker);
  if (itemIndex < 0) return null;
  const nextItem = normalized.indexOf(
    '"itemNumber":"',
    itemIndex + marker.length,
  );
  const block = normalized.slice(
    itemIndex,
    nextItem < 0 ? itemIndex + 12_000 : nextItem,
  );
  const evidence = (reason: string, promotion: string | null = null) => ({
    ...unavailable('warehouse_savings', reason),
    observedAt,
    promotionText: promotion,
    source: SAVINGS_SOURCE,
  });
  const applicability =
    /"applicability":"([^"]+)"/u.exec(block)?.[1]?.toLowerCase() ?? '';
  if (applicability === 'online' || applicability === 'online_only') {
    return evidence('online_only');
  }
  if (!applicability.split('_').includes('warehouse')) {
    return evidence('warehouse_applicability_not_stated');
  }
  const override = /"validDatesOverride":"([^"]+)"/u.exec(block)?.[1] ?? '';
  const range = dateRange(override) ?? dateRange(normalized);
  if (range === null || !isCurrentUsDateRange(range.start, range.end, now)) {
    return evidence('promotion_not_current');
  }
  const price =
    /"pricesOffCSObject":\[\{[\s\S]*?"value":\["(\d+(?:\.\d{1,2})?)"\]/u.exec(
      block,
    )?.[1] ?? null;
  const append = /"append_text":"([^"]+)"/u.exec(block)?.[1]?.trim() ?? '';
  const prepend = /"prepend_text":"([^"]+)"/u.exec(block)?.[1]?.trim() ?? '';
  const cents = parseWirePriceToCents(price);
  const promotion =
    price === null
      ? append || null
      : `$${price}${append === '' ? '' : ` ${append}`}`;
  if (cents === null || cents <= 0 || /^save\b/iu.test(prepend)) {
    return evidence('final_price_not_listed', promotion);
  }
  return {
    ...available('warehouse_savings', cents, SAVINGS_SOURCE, observedAt),
    promotionText: promotion,
  };
}

function dateRange(value: string): { start: string; end: string } | null {
  const match =
    /Valid\s+(\d{1,2}\/\d{1,2}\/\d{2,4})\s*-\s*(\d{1,2}\/\d{1,2}\/\d{2,4})/iu.exec(
      value,
    );
  return match?.[1] && match[2] ? { start: match[1], end: match[2] } : null;
}

function isCurrentUsDateRange(start: string, end: string, now: Date): boolean {
  const startTime = parseUsDate(start, false);
  const endTime = parseUsDate(end, true);
  const current = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
  return (
    startTime !== null &&
    endTime !== null &&
    current >= startTime &&
    current <= endTime
  );
}

function parseUsDate(value: string, endOfDay: boolean): number | null {
  const match = /^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/u.exec(value);
  if (!match?.[1] || !match[2] || !match[3]) return null;
  const month = Number(match[1]);
  const day = Number(match[2]);
  const shortYear = Number(match[3]);
  const year = match[3].length === 2 ? 2000 + shortYear : shortYear;
  const valueTime = Date.UTC(
    year,
    month - 1,
    day,
    endOfDay ? 23 : 0,
    endOfDay ? 59 : 0,
    endOfDay ? 59 : 0,
  );
  const check = new Date(valueTime);
  return check.getUTCFullYear() === year &&
    check.getUTCMonth() === month - 1 &&
    check.getUTCDate() === day
    ? valueTime
    : null;
}

function attribute(attributes: string, name: string): string | null {
  const match = new RegExp(`${name}\\s*=\\s*["']([^"']+)["']`, 'iu').exec(
    attributes,
  );
  return match?.[1]?.trim() ?? null;
}

function stripHtml(value: string): string {
  return value
    .replace(/<[^>]*>/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
}

function promotionText(value: string): string | null {
  return (
    /(\$\d+(?:\.\d{2})?\s+after\s+\$\d+(?:\.\d{2})?\s+off)/iu.exec(
      value,
    )?.[1] ?? (value === '' ? null : value)
  );
}

function isCurrentDateRange(start: string, end: string, now: Date): boolean {
  const startTime = Date.parse(`${start}T00:00:00Z`);
  const endTime = Date.parse(`${end}T23:59:59Z`);
  const current = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
  return (
    Number.isFinite(startTime) &&
    Number.isFinite(endTime) &&
    current >= startTime &&
    current <= endTime
  );
}

function reportPriceFromWarehouse(
  observation: PriceObservation,
): ReportPriceObservation {
  return observation.unitPriceCents !== null &&
    observation.unresolvedReason === null
    ? available(
        'warehouse',
        observation.unitPriceCents,
        observation.source,
        observation.observedAt,
      )
    : {
        ...unavailable(
          'warehouse',
          observation.unresolvedReason ?? 'invalid_warehouse_price',
        ),
        observedAt: observation.observedAt,
        source: observation.source,
      };
}

function available(
  channel: ReportPriceObservation['channel'],
  unitPriceCents: number,
  source: string,
  observedAt: string,
): ReportPriceObservation {
  return {
    channel,
    observedAt,
    promotionText: null,
    source,
    unavailableReason: null,
    unitPriceCents,
  };
}

function unavailable(
  channel: ReportPriceObservation['channel'],
  reason: string,
): ReportPriceObservation {
  return {
    channel,
    observedAt: null,
    promotionText: null,
    source: null,
    unavailableReason: reason,
    unitPriceCents: null,
  };
}

function usableReportPrice(price: ReportPriceObservation): boolean {
  return price.unitPriceCents !== null && price.unavailableReason === null;
}

function reportPriceOnly(
  price: ReportPriceObservation,
): ReportPriceObservation {
  return {
    channel: price.channel,
    observedAt: price.observedAt,
    promotionText: price.promotionText,
    source: price.source,
    unavailableReason: price.unavailableReason,
    unitPriceCents: price.unitPriceCents,
  };
}

function sourcePriceKey(value: WarehousePriceRequest): string {
  return `${value.itemNumber}\u0000${value.warehouseNumber}`;
}

function evidenceKey(value: PriceRequest): string {
  return `${value.purchaseChannel}\u0000${sourcePriceKey(value)}`;
}

function deduplicatePriceRequests(
  requests: readonly PriceRequest[],
): PriceRequest[] {
  const unique = new Map<string, PriceRequest>();
  for (const request of requests) {
    if (
      request.purchaseChannel !== 'warehouse' &&
      request.purchaseChannel !== 'costco_com'
    ) {
      continue;
    }
    const key = evidenceKey(request);
    const description =
      request.description?.trim() || unique.get(key)?.description;
    unique.set(key, {
      ...(description === undefined ? {} : { description }),
      itemNumber: request.itemNumber,
      purchaseChannel: request.purchaseChannel,
      warehouseNumber: request.warehouseNumber,
    });
  }
  return [...unique.values()];
}

function notApplicableDiagnostic(
  channel: ReportSourceDiagnostic['channel'],
  source: string,
  observedAt: string,
): ReportSourceDiagnostic {
  return diagnostic(
    channel,
    source,
    'unavailable',
    observedAt,
    `${source} is not applicable.`,
  );
}

function diagnostic(
  channel: ReportSourceDiagnostic['channel'],
  source: string,
  status: ReportSourceDiagnostic['status'],
  observedAt: string,
  message: string,
): ReportSourceDiagnostic {
  return { channel, message, observedAt, source, status };
}
