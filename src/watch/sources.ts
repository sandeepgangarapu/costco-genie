// Ported from Costco Price Drop Checker; integrated with matcher boundaries.
import type { AppConfig } from '../config/config.js';
import {
  evaluateLow,
  kindsFor,
  usable,
  type Low,
  type Observation,
  type SourceResult,
  type WatchItem,
} from './domain.js';
import {
  fetchApiPrices,
  type ApiPrice,
} from '../costco/watch-online-client.js';
import {
  fetchSavings,
  savingsReportPrice,
} from '../costco/warehouse-savings.js';
import {
  fetchWarehousePrices as fetchStrictWarehousePrices,
  resolveWarehousePriceEvidence,
} from '../costco/price-client.js';
import type { ReportPriceObservation } from '../domain/types.js';
import type { AppPaths } from '../config/paths.js';
import {
  fetchSameDayPrices,
  inverseMarkupCents,
  type SameDayPriceOptions,
  type SameDayPriceRequest,
  type SameDayPriceObservation,
} from '../costco/same-day-client.js';
import {
  readWatchProductPricesLocked,
  type BrowserProduct,
  type BrowserResult,
} from '../costco/browser-session.js';
import { fetchProductHtml, parseProductPage } from '../costco/product.js';
import {
  parseDisplayedPrice,
  type DisplayedPrice,
} from '../costco/online-page.js';
import { fetchWarehouseDisplayPrices } from '../costco/warehouse-display-client.js';
export interface SourceOptions {
  fetchFn?: typeof fetch;
  now?: () => Date;
  api?: (
    items: readonly string[],
    warehouse: string,
    kind: 'online' | 'warehouse',
  ) => Promise<Map<string, ApiPrice>>;
  savings?: () => Promise<string | null>;
  warehousePrice?: (
    items: readonly string[],
    warehouse: string,
  ) => Promise<Map<string, ReportPriceObservation>>;
  warehouseGraphql?: (
    items: readonly string[],
    warehouse: string,
  ) => Promise<Map<string, ReportPriceObservation>>;
  sameDay?: (
    requests: readonly SameDayPriceRequest[],
    options: SameDayPriceOptions,
  ) => Promise<SameDayPriceObservation[]>;
  signedIn?: (items: readonly BrowserProduct[]) => Promise<BrowserResult>;
  publicPage?: (url: string) => Promise<{ html: string; url: string } | null>;
}
const TRANSIENT_SAME_DAY_REASONS = new Set([
  'search_failed',
  'deadline_exceeded',
  'postal_code_not_confirmed',
  'browser_launch_failed',
]);
function bodyText(html: string): string {
  return html
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/giu, '')
    .replace(/<[^>]+>/gu, '\n')
    .replaceAll('&nbsp;', ' ')
    .replaceAll('&amp;', '&');
}
export function makeSources(
  config: AppConfig,
  options: SourceOptions = {},
  paths?: AppPaths,
): (
  items: WatchItem[],
  warehouseLows?: ReadonlyMap<number, Low>,
) => Promise<SourceResult> {
  const fetchFn = options.fetchFn ?? fetch;
  return async (items, warehouseLows = new Map()) => {
    const now = (options.now ?? (() => new Date()))();
    const api =
      options.api ??
      ((numbers, warehouse, kind) =>
        fetchApiPrices(numbers, warehouse, kind, fetchFn));
    const diagnostics: string[] = [];
    const onlineItems = items.filter((i) => i.channel !== 'warehouse');
    const warehouseItems = items.filter((i) => i.channel !== 'online');
    const online = await api(
      onlineItems.map((i) => i.itemNumber),
      '847',
      'online',
    );
    const warehouse =
      config.watchWarehouseNumber && warehouseItems.length
        ? await (
            options.warehouseGraphql ??
            (async (numbers, warehouseNumber) =>
              new Map(
                (
                  await fetchStrictWarehousePrices(
                    numbers.map((itemNumber) => ({
                      itemNumber,
                      warehouseNumber,
                    })),
                    { fetchFn, now: () => now },
                  )
                ).map((p) => [
                  p.itemNumber,
                  {
                    channel: 'warehouse' as const,
                    unitPriceCents: p.unitPriceCents,
                    unavailableReason: p.unresolvedReason,
                    source: p.source,
                    observedAt: p.observedAt,
                    promotionText: null,
                    productName: p.productName,
                    warehouseEvidence: p.warehouseEvidence,
                  },
                ]),
              ))
          )(
            warehouseItems.map((i) => i.itemNumber),
            config.watchWarehouseNumber,
          )
        : new Map<string, ReportPriceObservation>();
    const warehouseDisplay =
      config.watchWarehouseNumber && warehouseItems.length
        ? await (
            options.warehousePrice ??
            (async (numbers, warehouseNumber) =>
              new Map(
                (
                  await fetchWarehouseDisplayPrices(
                    numbers.map((itemNumber) => ({
                      itemNumber,
                      warehouseNumber,
                    })),
                    { fetchFn, now: () => now },
                  )
                ).map((p) => [p.itemNumber, p]),
              ))
          )(
            warehouseItems.map((i) => i.itemNumber),
            config.watchWarehouseNumber,
          )
        : new Map<string, ReportPriceObservation>();
    const displayFailures = new Map<string, number>();
    for (const price of warehouseDisplay.values()) {
      if (price.unavailableReason)
        displayFailures.set(
          price.unavailableReason,
          (displayFailures.get(price.unavailableReason) ?? 0) + 1,
        );
    }
    for (const [reason, count] of displayFailures)
      diagnostics.push(
        `Warehouse display source: ${reason} (${count} item(s)).`,
      );
    const savingsHtml =
      warehouseItems.length && config.watchWarehouseNumber
        ? await (options.savings ?? (() => fetchSavings(fetchFn)))()
        : null;
    const productNames = new Map<number, string>();
    for (const item of items) {
      const name =
        online.get(item.itemNumber)?.name?.trim() ||
        warehouse.get(item.itemNumber)?.productName?.trim();
      if (name) productNames.set(item.id, name);
    }
    const publicPrices = new Map<string, DisplayedPrice>();
    let failedPublicPages = 0;
    for (const item of onlineItems) {
      try {
        const page = await (
          options.publicPage ?? ((url) => fetchProductHtml(url, fetchFn))
        )(item.url);
        if (page) {
          publicPrices.set(
            item.itemNumber,
            parseDisplayedPrice(bodyText(page.html), item.itemNumber, page.url),
          );
          const product = parseProductPage(page.html, page.url);
          if (
            product?.itemNumber === item.itemNumber &&
            product.name?.trim() &&
            !productNames.has(item.id)
          )
            productNames.set(item.id, product.name.trim());
        } else failedPublicPages += 1;
      } catch {
        failedPublicPages += 1;
      }
    }
    if (failedPublicPages)
      diagnostics.push(
        `Public product page unavailable for ${failedPublicPages} item(s); API evidence retained.`,
      );
    const fallback = onlineItems.filter((i) => {
      const a = online.get(i.itemNumber);
      const page = publicPrices.get(i.itemNumber);
      return (
        !a?.warehouseOnly &&
        !page?.warehouseOnly &&
        !(page?.cents != null && !page.memberGate) &&
        (a?.memberOnly || page?.memberGate)
      );
    });
    // Missing public display evidence alone never opens the shared profile.
    const signed = fallback.length
      ? await (
          options.signedIn ??
          ((products) => {
            if (!paths)
              throw new Error('App paths required for member-price lookup');
            return readWatchProductPricesLocked(paths, products);
          })
        )(fallback)
      : { prices: new Map<string, DisplayedPrice>(), diagnostic: null };
    if (signed.diagnostic) diagnostics.push(signed.diagnostic);
    let session: SourceResult['session'] = 'not_required';
    if (fallback.length) {
      session = fallback.some((i) => {
        const p = signed.prices.get(i.itemNumber);
        return (
          p?.session === 'signed_out' && p.cents === null && !p.warehouseOnly
        );
      })
        ? 'signed_out'
        : fallback.every((i) => {
              const p = signed.prices.get(i.itemNumber);
              return p && (p.warehouseOnly || !p.memberGate);
            })
          ? [...signed.prices.values()].some(
              (p) => p.session === 'authenticated',
            )
            ? 'authenticated'
            : 'not_required'
          : 'unknown';
    }
    const warehouseObservations = new Map<number, Observation>();
    const verifiedWarehouse = new Set<number>();
    for (const item of warehouseItems) {
      const request = {
        itemNumber: item.itemNumber,
        warehouseNumber: config.watchWarehouseNumber ?? '',
      };
      const resolved = resolveWarehousePriceEvidence(
        request,
        warehouseDisplay.get(item.itemNumber),
        savingsHtml
          ? savingsReportPrice(
              savingsHtml,
              item.itemNumber,
              request.warehouseNumber,
              now,
            )
          : undefined,
        warehouse.get(item.itemNumber),
        'watchlist',
      );
      const evidence = resolved.warehouseEvidence;
      const quarantined =
        resolved.unavailableReason === 'warehouse_online_only_promotion' ||
        resolved.unavailableReason === 'ambiguous_warehouse_promotions';
      const observation: Observation = {
        itemId: item.id,
        kind: 'warehouse',
        observedAt: now.toISOString(),
        estimateCents: null,
        cents: quarantined
          ? null
          : (evidence?.quotationCents ?? resolved.unitPriceCents),
        reason: !config.watchWarehouseNumber
          ? 'warehouse_not_configured'
          : quarantined
            ? resolved.unavailableReason
            : evidence?.conflictReason
              ? null
              : resolved.unavailableReason,
        source: resolved.source ?? 'warehouse_price_api',
        promoEnd: evidence?.promoEnd ?? null,
        evidence: Object.fromEntries(
          Object.entries(evidence ?? {}).map(([key, value]) => [
            key,
            typeof value === 'string' ||
            typeof value === 'number' ||
            value === null
              ? value
              : (JSON.stringify(value) ?? null),
          ]),
        ),
      };
      warehouseObservations.set(item.id, observation);
      // Reuse the low guards: conflicts, implausible drops, and unit changes
      // need the fallback. Without a stored low, any valid unit can baseline.
      if (
        usable(observation) &&
        !evaluateLow(
          warehouseLows.get(item.id),
          observation,
          config.minimumDropCents,
        ).unverifiedReason
      )
        verifiedWarehouse.add(item.id);
    }
    const locationConfigured =
      config.sameDayPostalCode &&
      config.sameDayRepresentativeAddress &&
      config.sameDayMarkupPercent !== null;
    const sameDayRequests = warehouseItems
      .filter((i) => !verifiedWarehouse.has(i.id))
      .map((i) => ({
        itemNumber: i.itemNumber,
        description: productNames.get(i.id) ?? i.name,
        warehouseNumber: config.watchWarehouseNumber ?? '',
      }));
    const lookupSameDay = (requests: SameDayPriceRequest[]) =>
      (options.sameDay ?? fetchSameDayPrices)(requests, {
        postalCode: config.sameDayPostalCode!,
        deliveryAddress: config.sameDayRepresentativeAddress!,
        now: () => now,
        timeout: 180_000,
      });
    let sameDay =
      sameDayRequests.length && locationConfigured
        ? await lookupSameDay(sameDayRequests)
        : [];
    // The Same-Day storefront fails intermittently; retry transient failures once.
    const retryable = sameDayRequests.filter((request) =>
      TRANSIENT_SAME_DAY_REASONS.has(
        sameDay.find((p) => p.itemNumber === request.itemNumber)
          ?.unavailableReason ?? '',
      ),
    );
    if (retryable.length) {
      const retried = await lookupSameDay(retryable);
      sameDay = sameDay.map(
        (p) =>
          retried.find(
            (r) => r.itemNumber === p.itemNumber && !r.unavailableReason,
          ) ?? p,
      );
    }
    const observations: Observation[] = [];
    for (const item of items) {
      for (const kind of kindsFor(item.channel)) {
        const o: Observation = {
          itemId: item.id,
          kind,
          observedAt: now.toISOString(),
          cents: null,
          estimateCents: null,
          source: kind,
          reason: 'source_unavailable',
          promoEnd: null,
          evidence: {},
        };
        if (kind === 'online') {
          const a = online.get(item.itemNumber);
          const browser = signed.prices.get(item.itemNumber);
          const page = browser ?? publicPrices.get(item.itemNumber);
          const gate = a?.memberOnly || page?.memberGate;
          const warehouseOnly =
            a?.warehouseOnly ||
            publicPrices.get(item.itemNumber)?.warehouseOnly ||
            browser?.warehouseOnly;
          // Store both reported API and displayed prices. A labeled final/current
          // page price takes precedence; never blindly subtract "$X OFF" again.
          const displayedUsable =
            page?.cents != null &&
            !page.memberGate &&
            page.session !== 'signed_out';
          o.cents = warehouseOnly
            ? null
            : displayedUsable
              ? page!.cents
              : gate
                ? null
                : (a?.cents ?? null);
          o.reason = warehouseOnly
            ? 'warehouse_only'
            : o.cents !== null
              ? null
              : (a?.reason ?? 'member_price_unavailable');
          o.source = displayedUsable
            ? browser
              ? 'costco_signed_in_product_page'
              : 'costco_public_product_page'
            : 'costco_product_api';
          o.promoEnd = page?.promoEnd ?? null;
          o.evidence = {
            apiCents: warehouseOnly ? null : (a?.cents ?? null),
            displayedCents: warehouseOnly ? null : (page?.cents ?? null),
            referenceCents: page?.referenceCents ?? null,
            discountCents: page?.discountCents ?? null,
            discountHandling: displayedUsable
              ? 'labeled displayed price; no further subtraction'
              : 'API as reported; discount inclusion unconfirmed',
          };
        } else if (kind === 'warehouse') {
          Object.assign(o, warehouseObservations.get(item.id));
        } else {
          const skipped = verifiedWarehouse.has(item.id);
          const s = skipped
            ? undefined
            : sameDay.find((p) => p.itemNumber === item.itemNumber);
          o.cents = s?.unitPriceCents ?? null;
          o.reason = skipped
            ? 'skipped_verified_warehouse_price'
            : o.cents !== null && !s?.unavailableReason
              ? null
              : !locationConfigured
                ? 'same_day_location_or_markup_not_configured'
                : (s?.unavailableReason ?? 'same_day_unavailable');
          o.source = 'same_day_guest_storefront';
          o.estimateCents =
            o.cents !== null && config.sameDayMarkupPercent !== null
              ? inverseMarkupCents(o.cents, config.sameDayMarkupPercent)
              : null;
          o.evidence = {
            rawSameDayCents: o.cents,
            markupPercent: config.sameDayMarkupPercent,
          };
        }
        observations.push(o);
      }
    }
    return { observations, session, diagnostics, productNames };
  };
}
