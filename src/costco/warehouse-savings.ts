// Adapted from costco-price-drop-checker/src/costco/savings.ts (multi-item cards).
import type { UnitBasis, ReportPriceObservation } from '../domain/types.js';
import { wireCents, warehouseUnitBasis } from './warehouse-display-client.js';
import { indicatesVariableWeight } from '../core/warehouse-units.js';
export const SAVINGS_URL = 'https://www.costco.com/o/-/warehouse-savings';
export interface SavingsPrice {
  cents: number | null;
  finalCents: number | null;
  reason: string | null;
  promoStart: string | null;
  promoEnd: string | null;
  promotion: string | null;
  advertisedDiscountCents: number | null;
  unitBasis: UnitBasis;
  variableWeight: boolean;
  scope: 'warehouse' | 'online_only' | 'unknown';
}
const missing = (reason: string): SavingsPrice => ({
  cents: null,
  finalCents: null,
  reason,
  promoStart: null,
  promoEnd: null,
  promotion: null,
  advertisedDiscountCents: null,
  unitBasis: 'unknown',
  variableWeight: false,
  scope: 'unknown',
});
export function currentRange(start: string, end: string, now: Date): boolean {
  const day = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate(),
  ).getTime();
  const a = new Date(`${start}T00:00:00`).getTime();
  const b = new Date(`${end}T00:00:00`).getTime();
  return Number.isFinite(a) && Number.isFinite(b) && day >= a && day <= b;
}
function iso(value: string): string | null {
  if (/^\d{4}-\d{2}-\d{2}$/u.test(value)) {
    const d = new Date(`${value}T00:00:00Z`);
    return Number.isFinite(d.getTime()) &&
      d.toISOString().slice(0, 10) === value
      ? value
      : null;
  }
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/u.exec(value);
  if (!m) return null;
  const year = m[3].length === 2 ? `20${m[3]}` : m[3];
  return iso(`${year}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`);
}
function range(value: string): { start: string; end: string } | null {
  const match =
    /Valid\s+(\d{1,2}\/\d{1,2}\/\d{2,4})\s*[-–]\s*(\d{1,2}\/\d{1,2}\/\d{2,4})/iu.exec(
      value,
    );
  const start = match && iso(match[1]);
  const end = match && iso(match[2]);
  return start && end ? { start, end } : null;
}
function attr(text: string, name: string): string | null {
  return (
    new RegExp(`\\b${name}\\s*=\\s*["']([^"']+)["']`, 'iu')
      .exec(text)?.[1]
      ?.trim() ?? null
  );
}
function exactItems(value: string, item: string): boolean {
  const ids = value.split(',').map((id) => id.trim());
  return ids.every((id) => /^\d+$/u.test(id)) && ids.includes(item);
}
function advertisedDiscount(text: string): number | null {
  const amounts = [
    ...text.matchAll(
      /(?:\bsave\s+\$?(\d+(?:\.\d{1,2})?)(?![\d.])\b|(?<![\d.])\$?(\d+(?:\.\d{1,2})?)\s+OFF\b)/giu,
    ),
  ].map((m) => wireCents(m[1] ?? m[2]));
  const distinct = [...new Set(amounts)];
  return distinct.length === 1 ? distinct[0] : null;
}
function normalize(
  applicability: string,
  text: string,
  dates: { start: string; end: string } | null,
  final: number | null,
  now: Date,
  unitText = text,
): SavingsPrice {
  const scope =
    /online\s*only|online_only/iu.test(`${applicability} ${text}`) ||
    applicability.toLowerCase() === 'online'
      ? 'online_only'
      : applicability.toLowerCase().split('_').includes('warehouse')
        ? 'warehouse'
        : 'unknown';
  const reason = /item numbers? vary/iu.test(text)
    ? 'variable_item_numbers'
    : scope !== 'warehouse'
      ? 'not_warehouse_promotion'
      : !dates || !currentRange(dates.start, dates.end, now)
        ? 'promotion_not_current'
        : final === null
          ? 'final_price_not_listed'
          : null;
  return {
    cents: reason === null ? final : null,
    finalCents: final,
    reason,
    promoStart: dates?.start ?? null,
    promoEnd: dates?.end ?? null,
    promotion: text || null,
    advertisedDiscountCents: advertisedDiscount(text),
    unitBasis: warehouseUnitBasis(null, null, unitText),
    variableWeight: indicatesVariableWeight(unitText),
    scope,
  };
}

/** Find the containing card, including fields preceding itemNumber. A slice
 * ending at the next itemNumber can accidentally borrow that next card's dates.
 * Scan candidate object boundaries independently of the enclosing Flight string.
 */
function hydrationCard(text: string, itemIndex: number): string {
  const scriptStart = Math.max(0, text.lastIndexOf('<script', itemIndex));
  for (
    let start = text.lastIndexOf('{', itemIndex);
    start >= scriptStart;
    start = text.lastIndexOf('{', start - 1)
  ) {
    let depth = 0;
    let quoted = false;
    let escaped = false;
    for (let end = start; end < text.length; end++) {
      const character = text[end];
      if (quoted) {
        if (escaped) escaped = false;
        else if (character === '\\') escaped = true;
        else if (character === '"') quoted = false;
      } else if (character === '"') quoted = true;
      else if (character === '{') depth++;
      else if (character === '}' && --depth === 0) {
        if (end > itemIndex) return text.slice(start, end + 1);
        break;
      }
    }
    if (start === 0) break;
  }
  return '';
}
export function parseSavingsForItem(
  html: string,
  item: string,
  now: Date,
): SavingsPrice {
  // Hydration is authoritative. Match comma-separated IDs as complete tokens,
  // never substrings, and refuse overlapping current cards rather than choosing.
  const normalized = html.replaceAll('\\"', '"');
  const matches = [...normalized.matchAll(/"itemNumber":"([^"]+)"/gu)];
  const hydrated: SavingsPrice[] = [];
  for (let i = 0; i < matches.length; i++) {
    const m = matches[i];
    if (!exactItems(m[1], item)) continue;
    const block = hydrationCard(normalized, m.index);
    const applicability = /"applicability":"([^"]+)"/u.exec(block)?.[1] ?? '';
    const override = /"validDatesOverride":"([^"]+)"/u.exec(block)?.[1];
    // Costco also uses this field for limits/selection terms, not just dates.
    // Reject an attempted malformed date, but use the global period for terms.
    const dates =
      range(override ?? '') ??
      (/\bValid\s+\d|\d{1,2}\/\d{1,2}/iu.test(override ?? '')
        ? null
        : range(normalized));
    const priceBlock =
      /"pricesOffCSObject":\[\{([\s\S]*?)\}\]/u.exec(block)?.[1] ?? '';
    const price = /"value":\["(\d+(?:\.\d{1,2})?)"\]/u.exec(priceBlock)?.[1];
    const prepend =
      /"prepend_text":"([^"]*)"/u.exec(priceBlock)?.[1]?.trim() ?? '';
    const append =
      /"append_text":"([^"]*)"/u.exec(priceBlock)?.[1]?.trim() ?? '';
    const text = [prepend, price ? `$${price}` : '', append]
      .filter(Boolean)
      .join(' ');
    const parsed = normalize(
      applicability,
      text,
      dates,
      /^save\b/iu.test(prepend) ? null : wireCents(price),
      now,
      text +
        ' ' +
        ['cardDescription', 'offerDetails', 'offerTerms']
          .map(
            (key) =>
              new RegExp(`"${key}":"([^"]*)"`, 'u').exec(block)?.[1] ?? '',
          )
          .join(' '),
    );
    // A shared item list is safe only when the card has one explicit amount.
    // Do not assign one variant's price to every item on a multi-price card.
    if (
      [...priceBlock.matchAll(/"value":/gu)].length > 1 &&
      parsed.scope === 'warehouse'
    ) {
      parsed.cents = null;
      parsed.reason = 'ambiguous_warehouse_promotions';
    }
    hydrated.push(parsed);
  }
  if (hydrated.length) return select(hydrated);
  const articles: SavingsPrice[] = [];
  for (const article of html.matchAll(
    /<article\b([^>]*)>([\s\S]*?)<\/article>/giu,
  )) {
    if (!exactItems(attr(article[1], 'data-item-number') ?? '', item)) continue;
    const text = article[2]
      .replace(/<[^>]+>/gu, ' ')
      .replace(/\s+/gu, ' ')
      .trim();
    const start = iso(attr(article[1], 'data-start-date') ?? '');
    const end = iso(attr(article[1], 'data-end-date') ?? '');
    articles.push(
      normalize(
        attr(article[1], 'data-applicability') ?? '',
        text,
        start && end ? { start, end } : null,
        wireCents(attr(article[1], 'data-final-price')?.replace(/^\$/u, '')),
        now,
      ),
    );
  }
  return articles.length ? select(articles) : missing('item_not_advertised');
}
function select(cards: SavingsPrice[]): SavingsPrice {
  const onlineOnly = cards.find((c) => c.scope === 'online_only');
  if (onlineOnly) return onlineOnly;
  const current = cards.filter(
    (c) => c.scope === 'warehouse' && c.reason !== 'promotion_not_current',
  );
  return current.length > 1
    ? missing('ambiguous_warehouse_promotions')
    : (current[0] ?? cards[0]);
}
export async function fetchSavings(
  fetchFn: typeof fetch = fetch,
): Promise<string | null> {
  try {
    const r = await fetchFn(SAVINGS_URL, {
      signal: AbortSignal.timeout(30_000),
    });
    return r.ok ? await r.text() : null;
  } catch {
    return null;
  }
}

export function savingsReportPrice(
  html: string,
  item: string,
  warehouseNumber: string,
  now: Date,
): ReportPriceObservation {
  const price = parseSavingsForItem(html, item, now);
  return {
    channel: 'warehouse_savings',
    source: 'warehouse_savings_page',
    observedAt: now.toISOString(),
    unitPriceCents: price.cents,
    unavailableReason:
      price.reason === 'not_warehouse_promotion'
        ? price.scope === 'online_only'
          ? 'online_only'
          : 'warehouse_applicability_not_stated'
        : price.reason,
    promotionText: price.promotion,
    warehouseEvidence: {
      warehouseNumber,
      unitBasis: price.unitBasis,
      ...(price.variableWeight ? { variableWeight: true } : {}),
      promoStart: price.promoStart,
      promoEnd: price.promoEnd,
      scope: price.scope,
      bookletFinalCents: price.finalCents,
      advertisedDiscountCents: price.advertisedDiscountCents,
    },
  };
}
