import type { PriceObservation, Purchase } from '../domain/types.js';

export interface ReportRowConfig {
  readonly adjustmentWindowDays: number;
  readonly minimumSavingsCents: number;
}

export interface ReportRow {
  readonly daysRemaining: number | null;
  readonly purchase: Purchase;
  readonly reason: string | null;
  readonly status: 'candidate' | 'not_eligible';
  readonly warehouseDeltaCents: number | null;
  readonly warehousePrice: PriceObservation | null;
}

interface ParsedTimestamp {
  readonly calendarDay: number;
  readonly instant: number;
}

const TIMESTAMP_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(?:Z|[+-]\d{2}:?\d{2})?$/;

export function buildReportRows(
  purchases: readonly Purchase[],
  priceSnapshots: readonly PriceObservation[],
  now: Date,
  config: ReportRowConfig,
): ReportRow[] {
  const nowCalendarDay = calendarDayForDate(now);
  const latestPrices = latestByItemAndWarehouse(priceSnapshots);

  return purchases.map((purchase) => {
    const warehousePrice =
      latestPrices.get(
        priceKey(purchase.itemNumber, purchase.warehouseNumber),
      ) ?? null;
    const purchaseTime = parseTimestamp(purchase.purchasedAt);
    const elapsedDays =
      nowCalendarDay === null || purchaseTime === null
        ? null
        : (nowCalendarDay - purchaseTime.calendarDay) / 86_400_000;
    const daysRemaining =
      elapsedDays === null || !isValidConfig(config)
        ? null
        : Math.max(
            0,
            Math.min(
              config.adjustmentWindowDays,
              config.adjustmentWindowDays - elapsedDays,
            ),
          );
    const warehouseDeltaCents = usablePrice(warehousePrice)
      ? purchase.paidUnitCents - warehousePrice.unitPriceCents
      : null;

    if (!isValidConfig(config)) {
      return row(
        purchase,
        warehousePrice,
        warehouseDeltaCents,
        daysRemaining,
        'invalid_config',
      );
    }
    if (elapsedDays === null) {
      return row(
        purchase,
        warehousePrice,
        warehouseDeltaCents,
        daysRemaining,
        'invalid_purchase_timestamp',
      );
    }
    if (elapsedDays < 0 || elapsedDays > config.adjustmentWindowDays) {
      return row(
        purchase,
        warehousePrice,
        warehouseDeltaCents,
        daysRemaining,
        'outside_adjustment_window',
      );
    }
    if (
      !isSafePositiveInteger(purchase.paidUnitCents) ||
      !isSafePositiveInteger(purchase.quantity)
    ) {
      return row(
        purchase,
        warehousePrice,
        warehouseDeltaCents,
        daysRemaining,
        'invalid_purchase_price',
      );
    }
    if (!warehousePrice) {
      return row(
        purchase,
        null,
        null,
        daysRemaining,
        'warehouse_price_missing',
      );
    }
    if (!usablePrice(warehousePrice)) {
      return row(
        purchase,
        warehousePrice,
        null,
        daysRemaining,
        warehousePrice.unresolvedReason ?? 'invalid_warehouse_price',
      );
    }
    if (warehouseDeltaCents === null || warehouseDeltaCents <= 0) {
      return row(
        purchase,
        warehousePrice,
        warehouseDeltaCents,
        daysRemaining,
        'warehouse_price_not_lower',
      );
    }
    if (warehouseDeltaCents * purchase.quantity < config.minimumSavingsCents) {
      return row(
        purchase,
        warehousePrice,
        warehouseDeltaCents,
        daysRemaining,
        'below_minimum_savings',
      );
    }

    return {
      daysRemaining,
      purchase,
      reason: null,
      status: 'candidate',
      warehouseDeltaCents,
      warehousePrice,
    };
  });
}

function row(
  purchase: Purchase,
  warehousePrice: PriceObservation | null,
  warehouseDeltaCents: number | null,
  daysRemaining: number | null,
  reason: string,
): ReportRow {
  return {
    daysRemaining,
    purchase,
    reason,
    status: 'not_eligible',
    warehouseDeltaCents,
    warehousePrice,
  };
}

function latestByItemAndWarehouse(
  prices: readonly PriceObservation[],
): Map<string, PriceObservation> {
  const latest = new Map<
    string,
    { price: PriceObservation; observedAt: number }
  >();

  for (const price of prices) {
    const timestamp = parseTimestamp(price.observedAt);
    if (!timestamp) continue;

    const key = priceKey(price.itemNumber, price.warehouseNumber);
    const current = latest.get(key);
    if (!current || timestamp.instant > current.observedAt) {
      latest.set(key, { observedAt: timestamp.instant, price });
    }
  }

  return new Map(
    [...latest.entries()].map(([key, value]) => [key, value.price]),
  );
}

function usablePrice(
  price: PriceObservation | null,
): price is PriceObservation & { readonly unitPriceCents: number } {
  return (
    price !== null &&
    price.unresolvedReason === null &&
    price.unitPriceCents !== null &&
    isSafePositiveInteger(price.unitPriceCents)
  );
}

function isValidConfig(config: ReportRowConfig): boolean {
  return (
    isSafePositiveInteger(config.adjustmentWindowDays) &&
    isSafeNonNegativeInteger(config.minimumSavingsCents)
  );
}

function isSafePositiveInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

function isSafeNonNegativeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function priceKey(itemNumber: string, warehouseNumber: string): string {
  return `${itemNumber}\u0000${warehouseNumber}`;
}

function parseTimestamp(value: string): ParsedTimestamp | null {
  const match = TIMESTAMP_PATTERN.exec(value);
  if (!match) return null;

  const [, yearText, monthText, dayText, hourText, minuteText, secondText] =
    match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  if (
    !isValidCalendarDate(year, month, day) ||
    hour > 23 ||
    minute > 59 ||
    second > 59
  ) {
    return null;
  }

  const calendarDay = utcInstant(year, month, day, 0, 0, 0);
  const instant = Date.parse(value);
  return Number.isFinite(instant)
    ? { calendarDay, instant }
    : {
        calendarDay,
        instant: utcInstant(year, month, day, hour, minute, second),
      };
}

function calendarDayForDate(value: Date): number | null {
  if (!Number.isFinite(value.getTime())) return null;
  return utcInstant(
    value.getFullYear(),
    value.getMonth() + 1,
    value.getDate(),
    0,
    0,
    0,
  );
}

function isValidCalendarDate(
  year: number,
  month: number,
  day: number,
): boolean {
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(0, 0, 0, 0);
  return (
    month >= 1 &&
    month <= 12 &&
    day >= 1 &&
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

function utcInstant(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
): number {
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(hour, minute, second, 0);
  return date.getTime();
}
