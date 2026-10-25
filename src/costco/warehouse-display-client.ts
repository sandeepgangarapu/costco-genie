import { z } from 'zod';
// Adapted from costco-price-drop-checker/src/costco/warehouse-price.ts.
import type {
  UnitBasis,
  WarehousePromotion,
  ReportPriceObservation,
} from '../domain/types.js';
import type { WarehousePriceRequest } from './price-client.js';
import { parseMoneyToCents } from '../lib/money.js';
import {
  PRODUCT_CLIENT_ID,
  DISPLAY_PRICE_CLIENT_ID,
} from './public-storefront.js';
export { DISPLAY_PRICE_CLIENT_ID } from './public-storefront.js';
export const WAREHOUSE_DISPLAY_SOURCE = 'warehouse_display_price_api';
export function wireCents(value: unknown): number | null {
  const cents = discountCents(value);
  return cents !== null && cents > 0 ? cents : null;
}

export const DISPLAY_PRICE_ENDPOINT =
  'https://gdx-api.costco.com/catalog/product/dispprice-api/v3/display-price-lite';

export interface WarehousePrice {
  cents: number | null;
  reason: string | null;
  warehouseNumber: string;
  baseCents: number | null;
  discountCents: number | null;
  deliveredCents: number | null;
  currency: string | null;
  unitBasis: UnitBasis;
  promotions: WarehousePromotion[];
  promoEnd: string | null;
}
const schema = z.object({
  priceData: z.array(
    z.object({
      id: z.string(),
      displayPrice: z.array(
        z.object({
          warehouseNumber: z.string(),
          currency: z.string(),
          onlinePrice: z.unknown(),
          aggregatedDiscountAmt: z.unknown(),
          deliveredPrice: z.unknown(),
          uom: z.unknown().optional(),
          factor: z.unknown().optional(),
        }),
      ),
      discounts: z
        .array(
          z.object({
            warehouseNumber: z.string(),
            promotions: z.array(z.unknown()).default([]),
          }),
        )
        .default([]),
    }),
  ),
});
function unavailable(warehouseNumber: string, reason: string): WarehousePrice {
  return {
    cents: null,
    reason,
    warehouseNumber,
    baseCents: null,
    discountCents: null,
    deliveredCents: null,
    currency: null,
    unitBasis: 'unknown',
    promotions: [],
    promoEnd: null,
  };
}
function discountCents(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value))
    value = String(value);
  const cents =
    typeof value === 'string'
      ? parseMoneyToCents(value.replace(/(\.\d{2})0+$/u, '$1'))
      : null;
  return cents !== null && cents >= 0 ? cents : null;
}
function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object'
    ? (value as Record<string, unknown>)
    : {};
}
function date(value: unknown): string | null {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T/u.test(value))
    return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) &&
    new Date(ms).toISOString().slice(0, 10) === value.slice(0, 10)
    ? new Date(ms).toISOString()
    : null;
}
function promotion(value: unknown): WarehousePromotion {
  const p = record(value);
  const text = record(p.text);
  const messages = ['longText', 'shortText', 'disclaimerText'].flatMap(
    (key) => {
      const localized = record(record(text[key])['en-US']).text;
      return typeof localized === 'string'
        ? [localized.replace(/<[^>]*>/gu, ' ').trim()]
        : [];
    },
  );
  return {
    discountCents: discountCents(p.calculatedDiscountAmount),
    text: [...new Set(messages)].join(' ') || null,
    start: date(p.promotionStartDate),
    end: date(p.promotionEndDate),
  };
}
export function warehouseUnitBasis(
  uom: unknown,
  factor: unknown,
  text: string,
): UnitBasis {
  const unit = typeof uom === 'string' ? uom.trim().toLowerCase() : '';
  const perPound = /per\s+(?:pound|lb)\b|\/\s*lb\b/iu.test(text);
  if (factor != null && factor !== 1 && factor !== '1') return 'unknown';
  if (/^(?:lb|lbs|pound|pounds)$/u.test(unit) || perPound) return 'lb';
  if (
    /^(?:ea|each)$/u.test(unit) &&
    (factor == null || factor === 1 || factor === '1')
  )
    return 'each';
  // Null UOM/factor is common even for fresh per-pound rates. Absence is not each.
  return 'unknown';
}
export function parseWarehouseDisplayPrices(
  payload: unknown,
  items: readonly string[],
  warehouseNumber: string,
  now = new Date(),
): Map<string, WarehousePrice> {
  if (!/^\d+$/u.test(warehouseNumber) || /^0*847$|^0+$/u.test(warehouseNumber))
    throw new Error('Invalid physical warehouse price scope');
  const data = schema.parse(payload);
  return new Map(
    [...new Set(items)].map((item) => {
      const result = unavailable(
        warehouseNumber,
        'warehouse_display_not_found',
      );
      const products = data.priceData.filter((p) => p.id === item);
      if (products.length !== 1) {
        if (products.length > 1)
          result.reason = 'warehouse_display_ambiguous_item';
        return [item, result];
      }
      const prices = products[0].displayPrice.filter(
        (p) => p.warehouseNumber === warehouseNumber,
      );
      if (prices.length !== 1) {
        if (prices.length > 1)
          result.reason = 'warehouse_display_ambiguous_warehouse';
        return [item, result];
      }
      const p = prices[0];
      result.baseCents = wireCents(p.onlinePrice);
      result.discountCents = discountCents(p.aggregatedDiscountAmt);
      result.deliveredCents = wireCents(p.deliveredPrice);
      result.currency = p.currency;
      const discounts = products[0].discounts.filter(
        (d) => d.warehouseNumber === warehouseNumber,
      );
      result.promotions = discounts.flatMap((d) => d.promotions.map(promotion));
      const text = result.promotions.map((p) => p.text ?? '').join(' ');
      result.unitBasis = warehouseUnitBasis(p.uom, p.factor, text);
      const paidPromos = result.promotions.filter((p) => p.discountCents !== 0);
      const ends = paidPromos.flatMap((p) => (p.end ? [p.end] : [])).sort();
      result.promoEnd = ends[0] ?? null;
      result.reason =
        p.currency !== 'USD'
          ? 'warehouse_display_non_usd'
          : result.baseCents === null ||
              result.discountCents === null ||
              result.deliveredCents === null
            ? 'warehouse_display_invalid_money'
            : result.baseCents - result.discountCents !== result.deliveredCents
              ? 'warehouse_display_arithmetic_mismatch'
              : discounts.length > 1
                ? 'warehouse_display_ambiguous_promotions'
                : paidPromos.length > 1
                  ? 'warehouse_display_ambiguous_promotions'
                  : paidPromos.some(
                        (p) =>
                          p.discountCents === null ||
                          !p.start ||
                          !p.end ||
                          p.start > p.end,
                      )
                    ? 'warehouse_display_invalid_promotion'
                    : paidPromos.some(
                          (p) =>
                            now.getTime() < Date.parse(p.start!) ||
                            now.getTime() > Date.parse(p.end!),
                        )
                      ? 'warehouse_display_promotion_not_current'
                      : paidPromos.length &&
                          paidPromos.reduce(
                            (sum, p) => sum + p.discountCents!,
                            0,
                          ) !== result.discountCents
                        ? 'warehouse_display_promotion_amount_mismatch'
                        : null;
      result.cents = result.reason === null ? result.deliveredCents : null;
      return [item, result];
    }),
  );
}
export interface WarehouseFetchOptions {
  now?: () => Date;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  timeoutMs?: number;
  createTimeoutSignal?: (ms: number) => AbortSignal;
}
const sleep = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', abort);
      resolve();
    }, ms);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
  });
function retryDelay(value: string | null, now: Date): number {
  const seconds =
    value !== null && /^\d+(?:\.\d+)?$/u.test(value)
      ? Number(value) * 1000
      : NaN;
  const delay = Number.isFinite(seconds)
    ? seconds
    : value
      ? Date.parse(value) - now.getTime()
      : NaN;
  return Number.isFinite(delay) ? Math.min(10_000, Math.max(0, delay)) : 1000;
}
async function fetchWarehouseGroup(
  items: readonly string[],
  warehouseNumber: string,
  fetchFn: typeof fetch = fetch,
  options: WarehouseFetchOptions = {},
): Promise<Map<string, WarehousePrice>> {
  if (
    !/^\d+$/u.test(warehouseNumber) ||
    warehouseNumber === '847' ||
    items.some((n) => !/^\d+$/u.test(n))
  )
    throw new Error('Invalid physical warehouse price scope or item number');
  const distinct = [...new Set(items)];
  const results = new Map<string, WarehousePrice>();
  let stopped: string | null = null;
  const now = options.now ?? (() => new Date());
  for (let offset = 0; offset < distinct.length; offset += 8) {
    const batch = distinct.slice(offset, offset + 8);
    if (!batch.length) continue;
    const url = new URL(DISPLAY_PRICE_ENDPOINT);
    url.search = new URLSearchParams({
      whsNumber: warehouseNumber,
      clientId: PRODUCT_CLIENT_ID,
      item: batch.join(','),
      locale: 'en-us',
    }).toString();
    let reason: string | null = stopped;
    if (!stopped) {
      const timeout = options.timeoutMs ?? 30_000;
      const signal = (options.createTimeoutSignal ?? AbortSignal.timeout)(
        Number.isFinite(timeout)
          ? Math.min(30_000, Math.max(1, Math.floor(timeout)))
          : 30_000,
      );
      let throttleStatus: number | null = null;
      try {
        let response: Response | undefined;
        for (let attempt = 0; attempt < 2; attempt++) {
          response = await fetchFn(url, {
            method: 'GET',
            credentials: 'omit',
            signal,
            headers: { 'client-identifier': DISPLAY_PRICE_CLIENT_ID },
          });
          if (![403, 429].includes(response.status)) break;
          throttleStatus = response.status;
          if (attempt === 1) {
            stopped = `warehouse_display_backoff_http_${response.status}`;
            break;
          }
          await (options.sleep ?? sleep)(
            retryDelay(response.headers.get('retry-after'), now()),
            signal,
          );
        }
        if (response?.status === 200 || response?.status === 206) {
          for (const [item, price] of parseWarehouseDisplayPrices(
            await response.json(),
            batch,
            warehouseNumber,
            now(),
          ))
            results.set(item, price);
          continue;
        }
        reason =
          response?.status === 404
            ? 'warehouse_display_not_found'
            : response?.status === 400
              ? 'warehouse_display_configuration_error_http_400'
              : (stopped ??
                `warehouse_display_http_${response?.status ?? 'failed'}`);
        if (response?.status === 400) stopped = reason;
      } catch (error) {
        if (throttleStatus !== null) {
          // An interrupted backoff is still a throttle, not permission to start
          // the next batch immediately with a fresh request deadline.
          stopped = `warehouse_display_backoff_http_${throttleStatus}`;
        }
        reason =
          stopped ??
          (signal.aborted ||
          (error instanceof Error &&
            ['TimeoutError', 'AbortError'].includes(error.name))
            ? 'warehouse_display_timeout'
            : 'warehouse_display_price_failed');
      }
    }
    for (const item of batch)
      results.set(item, unavailable(warehouseNumber, reason!));
  }
  return results;
}

export interface WarehouseDisplayOptions extends WarehouseFetchOptions {
  readonly fetchFn?: typeof fetch;
}

export function displayReportPrice(
  price: WarehousePrice,
  observedAt: string,
): ReportPriceObservation {
  return {
    channel: 'warehouse_display',
    source: WAREHOUSE_DISPLAY_SOURCE,
    observedAt,
    unitPriceCents: price.cents,
    unavailableReason: price.reason,
    promotionText:
      price.promotions
        .map((p) => p.text)
        .filter(Boolean)
        .join(' ') || null,
    warehouseEvidence: {
      warehouseNumber: price.warehouseNumber,
      baseCents: price.baseCents,
      discountCents: price.discountCents,
      deliveredCents: price.deliveredCents,
      quotationCents: price.cents,
      currency: price.currency,
      unitBasis: price.unitBasis,
      promotions: price.promotions,
      promoEnd: price.promoEnd,
      scope: 'warehouse',
    },
  };
}

/** One physical warehouse and at most eight distinct items per sequential GET. */
export async function fetchWarehouseDisplayPrices(
  requests: readonly WarehousePriceRequest[],
  options: WarehouseDisplayOptions = {},
): Promise<Array<ReportPriceObservation & WarehousePriceRequest>> {
  const observedAt = (options.now ?? (() => new Date()))().toISOString();
  const groups = new Map<string, string[]>();
  const results = new Map<string, WarehousePrice>();
  const key = (r: WarehousePriceRequest) =>
    r.warehouseNumber + '\0' + r.itemNumber;
  for (const r of requests) {
    if (
      !/^\d+$/u.test(r.itemNumber) ||
      !/^\d+$/u.test(r.warehouseNumber) ||
      /^0*847$/u.test(r.warehouseNumber) ||
      /^0+$/u.test(r.warehouseNumber)
    ) {
      results.set(
        key(r),
        unavailable(
          r.warehouseNumber,
          'invalid_physical_warehouse_scope_or_item',
        ),
      );
    } else {
      const group = groups.get(r.warehouseNumber) ?? [];
      group.push(r.itemNumber);
      groups.set(r.warehouseNumber, group);
    }
  }
  // A throttle/configuration response stops all remaining warehouse groups too.
  let stopped: string | null = null;
  for (const [warehouse, items] of groups) {
    const prices: Map<string, WarehousePrice> = stopped
      ? new Map(items.map((item) => [item, unavailable(warehouse, stopped!)]))
      : await fetchWarehouseGroup(
          items,
          warehouse,
          options.fetchFn ?? fetch,
          options,
        );
    for (const [item, price] of prices) {
      results.set(key({ itemNumber: item, warehouseNumber: warehouse }), price);
      if (/backoff_http_|configuration_error_http_/u.test(price.reason ?? ''))
        stopped = price.reason;
    }
  }
  return requests.map((r) => ({
    ...r,
    ...displayReportPrice(results.get(key(r))!, observedAt),
  }));
}
