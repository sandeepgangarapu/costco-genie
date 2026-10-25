import { PRODUCT_CLIENT_ID } from './public-storefront.js';
import { z } from 'zod';

import type {
  PriceObservation,
  PurchaseChannel,
  ReportPriceChannels,
  ReportPriceObservation,
  ReportSourceDiagnostic,
} from '../domain/types.js';
import { isUsableReportPriceEvidence } from '../core/price-evidence.js';
import {
  indicatesVariableWeight,
  possibleWarehouseUnitMismatch,
} from '../core/warehouse-units.js';
import {
  fetchWarehouseDisplayPrices,
  WAREHOUSE_DISPLAY_SOURCE,
  type WarehouseDisplayOptions,
} from './warehouse-display-client.js';
import { savingsReportPrice } from './warehouse-savings.js';
import { parseMoneyToCents } from '../lib/money.js';
import {
  fetchSameDayPrices,
  type SameDayPriceOptions,
  type SameDayPriceObservation,
} from './same-day-client.js';

const PRODUCT_ENDPOINT =
  'https://ecom-api.costco.com/ebusiness/product/v1/products/graphql';

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
  description: z.unknown().optional(),
  attributes: z.unknown().optional(),
});

const catalogItemSchema = z.object({ itemNumber: z.string() });

export interface WarehousePriceRequest {
  readonly description?: string;
  readonly paidUnitCents?: number;
  readonly receiptVariableWeight?: boolean;
  readonly itemNumber: string;
  readonly warehouseNumber: string;
}

export interface PriceRequest extends WarehousePriceRequest {
  readonly purchaseChannel: PurchaseChannel;
}

export interface WarehousePriceOptions {
  readonly warehouseDisplayPriceFetcher?: (
    requests: readonly WarehousePriceRequest[],
    options: WarehouseDisplayOptions,
  ) => Promise<Array<ReportPriceObservation & WarehousePriceRequest>>;
  readonly batchSize?: number;
  readonly createTimeoutSignal?: (timeoutMilliseconds: number) => AbortSignal;
  readonly fetchFn?: typeof fetch;
  readonly now?: () => Date;
  readonly timeoutMilliseconds?: number;
  readonly sameDayMarkupPercent?: number;
  readonly sameDayPostalCode?: string | null;
  readonly sameDayRepresentativeAddress?: string | null;
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
        description { shortDescription }
        attributes { key value }
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
  const variableWeight = catalogVariableWeight(product);
  const withMetadata = (price: PriceObservation): PriceObservation =>
    variableWeight
      ? {
          ...price,
          warehouseEvidence: {
            warehouseNumber: indexed.request.warehouseNumber,
            unitBasis: 'each',
            variableWeight: true,
            unitReason:
              'warehouse_catalog_variable_weight_not_comparable_to_receipt_package',
          },
        }
      : price;
  if (!hasWarehouseProgram(product.programTypes)) {
    return withMetadata(
      unresolved(indexed.request, observedAt, 'not_warehouse_price'),
    );
  }

  const cents = parseWirePriceToCents(product.priceData?.price);
  if (cents === null || cents <= 0) {
    return withMetadata(
      unresolved(indexed.request, observedAt, 'invalid_price'),
    );
  }

  return withMetadata({
    itemNumber: indexed.request.itemNumber,
    observedAt,
    source: SOURCE,
    unitPriceCents: cents,
    unresolvedReason: null,
    warehouseNumber: indexed.request.warehouseNumber,
  });
}

function catalogVariableWeight(
  product: z.infer<typeof catalogProductSchema>,
): boolean {
  const description = z
    .object({ shortDescription: z.string().nullish() })
    .safeParse(product.description);
  if (
    description.success &&
    indicatesVariableWeight(description.data.shortDescription ?? '')
  )
    return true;
  if (!Array.isArray(product.attributes)) return false;
  return product.attributes.some((raw) => {
    const attribute = z
      .object({ key: z.string(), value: z.unknown() })
      .safeParse(raw);
    if (!attribute.success) return false;
    const { key, value } = attribute.data;
    const values = Array.isArray(value) ? value : [value];
    return values.some((v) => {
      if (indicatesVariableWeight(String(v))) return true;
      const flag = key.replace(/[\s_-]/gu, '').toLowerCase();
      return (
        /^(?:is)?(?:variableweight|randomweight|catchweight)$/u.test(flag) &&
        /^(?:true|yes|y|1)$/iu.test(String(v))
      );
    });
  });
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
    if (
      !DIGITS.test(request.warehouseNumber) ||
      /^0*847$|^0+$/u.test(request.warehouseNumber)
    ) {
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
  const physicalRequests = warehouseRequests.filter(
    (r) =>
      DIGITS.test(r.warehouseNumber) &&
      !/^0*847$|^0+$/u.test(r.warehouseNumber),
  );
  const display =
    physicalRequests.length === 0
      ? []
      : await (
          options.warehouseDisplayPriceFetcher ?? fetchWarehouseDisplayPrices
        )(physicalRequests, {
          fetchFn,
          now: () => observed,
          timeoutMs: options.timeoutMilliseconds,
          createTimeoutSignal: options.createTimeoutSignal,
        });
  // Coupon evidence is always refreshed, independently of browser success.
  const savings =
    physicalRequests.length === 0
      ? {
          items: [],
          diagnostic: notApplicableDiagnostic(
            'warehouse_savings',
            SAVINGS_SOURCE,
            observedAt,
          ),
        }
      : await fetchSavingsPrices(
          physicalRequests,
          observed,
          fetchFn,
          (options.createTimeoutSignal ?? AbortSignal.timeout)(
            options.timeoutMilliseconds ??
              EXTERNAL_REQUEST_TIMEOUT_MILLISECONDS,
          ),
        );
  const displayByKey = new Map(
    display.map((value) => [sourcePriceKey(value), value]),
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
  const resolvedByKey = new Map(
    warehouseRequests.map((request) => {
      const key = sourcePriceKey(request);
      const raw = warehouseByKey.get(key);
      return [
        key,
        resolveWarehousePriceEvidence(
          request,
          displayByKey.get(key),
          savingsByKey.get(key),
          raw ? reportPriceFromWarehouse(raw) : undefined,
        ),
      ];
    }),
  );
  const unresolvedRequests = warehouseRequests.filter(
    (request) =>
      DIGITS.test(request.itemNumber) &&
      DIGITS.test(request.warehouseNumber) &&
      !/^0*847$|^0+$/u.test(request.warehouseNumber) &&
      !usableReportPrice(resolvedByKey.get(sourcePriceKey(request))!),
  );
  const sameDay =
    unresolvedRequests.length === 0
      ? {
          items: [],
          diagnostic: diagnostic(
            'same_day',
            'same_day',
            'unavailable',
            observedAt,
            'Same-Day browser skipped: no unresolved physical warehouse prices.',
          ),
        }
      : await fetchSameDayEvidence(unresolvedRequests, options, observed);
  const sameDayByKey = new Map(
    sameDay.items.map((value) => [sourcePriceKey(value), value]),
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
          warehouseDisplay: unavailable('warehouse_display', 'not_applicable'),
          warehouseGraphql: unavailable('warehouse_graphql', 'not_applicable'),
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
    const currentWarehouse = resolvedByKey.get(sourceKey)!;
    return {
      purchaseChannel: request.purchaseChannel,
      itemNumber: request.itemNumber,
      warehouseNumber: request.warehouseNumber,
      prices: {
        warehouse: currentWarehouse,
        warehouseDisplay: displayByKey.get(sourceKey)
          ? reportPriceOnly(displayByKey.get(sourceKey)!)
          : unavailable('warehouse_display', 'warehouse_display_not_found'),
        warehouseGraphql: {
          ...apiWarehouse,
          channel: 'warehouse_graphql' as const,
        },
        warehouseSavings: savingsPrice,
        costcoCom: onlineRecord
          ? reportPriceOnly(onlineRecord)
          : unavailable('costco_com', 'product_not_found'),
        sameDay: sameDayByKey.get(sourceKey)
          ? reportPriceOnly(sameDayByKey.get(sourceKey)!)
          : unavailable(
              'same_day',
              usableReportPrice(currentWarehouse)
                ? 'verified_warehouse_price_available'
                : 'source_not_configured',
            ),
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
      diagnostic(
        'warehouse_display',
        WAREHOUSE_DISPLAY_SOURCE,
        warehouseRequests.length === 0
          ? 'unavailable'
          : display.some((p) =>
                /http_|failed|timeout|malformed/u.test(
                  p.unavailableReason ?? '',
                ),
              )
            ? 'error'
            : 'ok',
        observedAt,
        displayDiagnosticMessage(display),
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
  if (
    postalCode == null ||
    options.sameDayRepresentativeAddress == null ||
    options.sameDayMarkupPercent === undefined
  ) {
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
      deliveryAddress: options.sameDayRepresentativeAddress ?? undefined,
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
        ...savingsReportPrice(
          html,
          request.itemNumber,
          request.warehouseNumber,
          now,
        ),
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

function reportPriceFromWarehouse(
  observation: PriceObservation,
): ReportPriceObservation {
  const price =
    observation.unitPriceCents !== null && observation.unresolvedReason === null
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
  return {
    ...price,
    ...(observation.warehouseEvidence
      ? { warehouseEvidence: observation.warehouseEvidence }
      : {}),
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
  return isUsableReportPriceEvidence(price, price.channel);
}

function reportPriceOnly(
  price: ReportPriceObservation,
): ReportPriceObservation {
  return {
    ...(price.warehouseEvidence
      ? { warehouseEvidence: price.warehouseEvidence }
      : {}),
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
    const previous = unique.get(key);
    const paid = [request.paidUnitCents, previous?.paidUnitCents].filter(
      (v): v is number => v !== undefined && Number.isSafeInteger(v) && v > 0,
    );
    const variableWeight =
      request.receiptVariableWeight ||
      previous?.receiptVariableWeight ||
      indicatesVariableWeight(request.description ?? '');
    unique.set(key, {
      ...(description === undefined ? {} : { description }),
      ...(paid.length ? { paidUnitCents: Math.max(...paid) } : {}),
      ...(variableWeight ? { receiptVariableWeight: true } : {}),
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

function displayDiagnosticMessage(
  prices: readonly ReportPriceObservation[],
): string {
  const counts = new Map<string, number>();
  for (const p of prices)
    if (p.unavailableReason)
      counts.set(
        p.unavailableReason,
        (counts.get(p.unavailableReason) ?? 0) + 1,
      );
  return (
    'Warehouse display lookup completed.' +
    [...counts]
      .map(([reason, count]) => ' ' + reason + ' (' + count + ').')
      .join('')
  );
}

/** Adapted from costco-price-drop-checker/src/costco/warehouse-evidence.ts.
 * Conflicting quotations are retained, but cannot become verified comparisons.
 */
export function resolveWarehousePriceEvidence(
  request: WarehousePriceRequest,
  display: ReportPriceObservation | undefined,
  savings: ReportPriceObservation | undefined,
  graphql: ReportPriceObservation | undefined,
): ReportPriceObservation {
  const d = display?.warehouseEvidence;
  const b = savings?.warehouseEvidence;
  const exactDisplay =
    d?.warehouseNumber === request.warehouseNumber &&
    display?.channel === 'warehouse_display';
  const exactBooklet =
    b?.warehouseNumber === request.warehouseNumber &&
    savings?.channel === 'warehouse_savings';
  const currentBooklet =
    exactBooklet &&
    b.scope === 'warehouse' &&
    (savings.unavailableReason === null ||
      savings.unavailableReason === 'final_price_not_listed');
  const delivered =
    exactDisplay && usableReportPrice(display!)
      ? display!.unitPriceCents
      : null;
  const final = currentBooklet ? savings!.unitPriceCents : null;
  const usableGraphql =
    graphql?.channel === 'warehouse' && usableReportPrice(graphql);
  let selected =
    delivered !== null ? display : final !== null ? savings : graphql;
  let cents =
    delivered ?? final ?? (usableGraphql ? graphql!.unitPriceCents : null);
  let unitBasis =
    delivered !== null
      ? d!.unitBasis
      : final !== null
        ? b!.unitBasis
        : ('each' as const);
  let promoEnd = selected?.warehouseEvidence?.promoEnd ?? null;
  let handling =
    delivered !== null
      ? 'delivered price; no further subtraction'
      : final !== null
        ? 'advertised final price; no further subtraction'
        : 'strict WH GraphQL fallback';
  let conflict: string | null = null;
  if (delivered !== null && currentBooklet) {
    const discount = b!.advertisedDiscountCents;
    if (
      (final !== null || discount != null) &&
      b!.unitBasis !== 'unknown' &&
      d!.unitBasis !== 'unknown' &&
      b!.unitBasis !== d!.unitBasis
    ) {
      conflict = 'warehouse_display_booklet_unit_conflict';
    } else if (
      d!.discountCents! > 0 &&
      ((discount != null && discount !== d!.discountCents) ||
        (final !== null && final !== delivered))
    ) {
      conflict = 'warehouse_display_booklet_final_conflict';
    } else if (final === delivered) {
      handling = 'booklet final equals delivered; used once';
      promoEnd =
        [promoEnd, b!.promoEnd].filter((v): v is string => !!v).sort()[0] ??
        null;
    } else if (
      final !== null &&
      d!.discountCents === 0 &&
      delivered === d!.baseCents &&
      discount != null &&
      d!.baseCents! - discount === final
    ) {
      cents = final;
      selected = savings;
      handling =
        'missing API promotion filled by corroborated booklet final; no subtraction from delivered';
      promoEnd = b!.promoEnd ?? null;
    } else if (final !== null) {
      conflict = 'warehouse_display_booklet_final_conflict';
    }
  }
  // An ambiguous current card or explicit online-only card is not bypassed by WH.
  if (exactBooklet && b.scope === 'online_only')
    conflict = 'warehouse_online_only_promotion';
  if (savings?.unavailableReason === 'ambiguous_warehouse_promotions')
    conflict = 'ambiguous_warehouse_promotions';
  // Known rates cannot be laundered through a package booklet/WH fallback.
  if (
    (exactDisplay && d.unitBasis === 'lb') ||
    (exactBooklet && b.unitBasis === 'lb')
  )
    unitBasis = 'lb';
  const catalogVariable = graphql?.warehouseEvidence?.variableWeight === true;
  const receiptVariable =
    request.receiptVariableWeight ||
    indicatesVariableWeight(request.description ?? '');
  const bookletVariable = exactBooklet && b.variableWeight === true;
  const unitReason =
    unitBasis === 'lb'
      ? 'warehouse_per_lb_not_comparable_to_receipt_package'
      : catalogVariable
        ? 'warehouse_catalog_variable_weight_not_comparable_to_receipt_package'
        : receiptVariable
          ? 'warehouse_receipt_variable_weight_not_comparable_to_receipt_package'
          : bookletVariable
            ? 'warehouse_booklet_variable_weight_not_comparable_to_receipt_package'
            : cents !== null &&
                possibleWarehouseUnitMismatch(cents, request.paidUnitCents)
              ? 'warehouse_possible_unit_mismatch'
              : null;
  let reason =
    conflict ??
    unitReason ??
    (cents !== null
      ? null
      : (display?.unavailableReason ??
        graphql?.unavailableReason ??
        savings?.unavailableReason ??
        'warehouse_price_missing'));
  if (
    !DIGITS.test(request.warehouseNumber) ||
    /^0*847$|^0+$/u.test(request.warehouseNumber)
  )
    reason = 'invalid_physical_warehouse_scope';
  return {
    channel: 'warehouse',
    unitPriceCents: reason === null ? cents : null,
    source: selected?.source ?? display?.source ?? graphql?.source ?? null,
    observedAt:
      selected?.observedAt ??
      display?.observedAt ??
      graphql?.observedAt ??
      null,
    unavailableReason: reason,
    promotionText: savings?.promotionText ?? display?.promotionText ?? null,
    warehouseEvidence: {
      ...d,
      warehouseNumber: request.warehouseNumber,
      unitBasis,
      ...(unitReason === null
        ? {
            comparisonBasis:
              unitBasis === 'unknown'
                ? ('assumed_package' as const)
                : ('package' as const),
          }
        : {}),
      ...(catalogVariable || receiptVariable || bookletVariable
        ? { variableWeight: true }
        : {}),
      quotationCents: cents,
      promoEnd,
      bookletFinalCents: b?.bookletFinalCents ?? null,
      advertisedDiscountCents: b?.advertisedDiscountCents ?? null,
      bookletPromoStart: b?.promoStart ?? null,
      bookletPromoEnd: b?.promoEnd ?? null,
      bookletUnitBasis: b?.unitBasis,
      bookletScope: b?.scope,
      conflictReason: conflict,
      unitReason,
      discountHandling: handling,
    },
  };
}
