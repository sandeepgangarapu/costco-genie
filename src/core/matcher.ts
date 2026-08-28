import type {
  AdjustmentCandidate,
  PriceObservation,
  Purchase,
  PurchaseChannel,
  ReportPriceChannels,
} from '../domain/types.js';

export interface MatcherConfig {
  readonly adjustmentWindowDays: number;
  readonly minimumSavingsCents: number;
}

export interface OnlinePriceEvidence {
  readonly purchaseChannel: PurchaseChannel;
  readonly itemNumber: string;
  readonly warehouseNumber: string;
  readonly prices: Pick<ReportPriceChannels, 'costcoCom'>;
}

interface ParsedTimestamp {
  readonly calendarDay: number;
  readonly instant: number;
}

const TIMESTAMP_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|[+-]\d{2}:?\d{2})?$/;

export function findAdjustments(
  purchases: readonly Purchase[],
  observations: readonly PriceObservation[],
  now: Date,
  config: MatcherConfig,
): AdjustmentCandidate[] {
  const latestObservations = latestByItemAndWarehouse(observations);
  const nowCalendarDay = calendarDayForDate(now);

  if (nowCalendarDay === null || !isValidConfig(config)) {
    return [];
  }

  return purchases
    .flatMap((purchase) => {
      if (purchase.purchaseChannel !== 'warehouse') {
        return [];
      }
      const daysRemaining = eligibleDaysRemaining(
        purchase,
        nowCalendarDay,
        config,
      );
      if (daysRemaining === null) return [];

      const observation = latestObservations.get(
        observationKey(purchase.itemNumber, purchase.warehouseNumber),
      );
      if (!observation || !isUsable(observation)) {
        return [];
      }

      return candidateForPrice(
        purchase,
        observation,
        observation.unitPriceCents,
        daysRemaining,
        config,
        'warehouse',
      );
    })
    .sort(compareCandidates);
}

export function findOnlineAdjustments(
  purchases: readonly Purchase[],
  evidenceItems: readonly OnlinePriceEvidence[],
  now: Date,
  config: MatcherConfig,
): AdjustmentCandidate[] {
  const nowCalendarDay = calendarDayForDate(now);
  if (nowCalendarDay === null || !isValidConfig(config)) return [];

  const latestEvidence = latestOnlineEvidence(evidenceItems);
  return purchases
    .flatMap((purchase) => {
      if (purchase.purchaseChannel !== 'costco_com') return [];
      const daysRemaining = eligibleDaysRemaining(
        purchase,
        nowCalendarDay,
        config,
      );
      if (daysRemaining === null) return [];

      const evidence = latestEvidence.get(
        observationKey(purchase.itemNumber, purchase.warehouseNumber),
      );
      if (!evidence) return [];
      const price = evidence.prices.costcoCom;
      if (!isUsableOnlinePrice(price)) return [];

      const observation: PriceObservation = {
        itemNumber: purchase.itemNumber,
        observedAt: price.observedAt,
        source: price.source,
        unitPriceCents: price.unitPriceCents,
        unresolvedReason: null,
        warehouseNumber: purchase.warehouseNumber,
      };
      return candidateForPrice(
        purchase,
        observation,
        price.unitPriceCents,
        daysRemaining,
        config,
        'costco_com',
      );
    })
    .sort(compareCandidates);
}

function latestOnlineEvidence(
  evidenceItems: readonly OnlinePriceEvidence[],
): Map<string, OnlinePriceEvidence> {
  const latest = new Map<
    string,
    { evidence: OnlinePriceEvidence; observedAt: number }
  >();
  for (const evidence of evidenceItems) {
    if (
      evidence.purchaseChannel !== 'costco_com' ||
      evidence.prices.costcoCom.channel !== 'costco_com' ||
      evidence.prices.costcoCom.observedAt === null
    ) {
      continue;
    }
    const observedAt = parseTimestamp(evidence.prices.costcoCom.observedAt);
    if (!observedAt) continue;
    const key = observationKey(evidence.itemNumber, evidence.warehouseNumber);
    const existing = latest.get(key);
    if (!existing || observedAt.instant > existing.observedAt) {
      latest.set(key, { evidence, observedAt: observedAt.instant });
    }
  }
  return new Map(
    [...latest.entries()].map(([key, value]) => [key, value.evidence]),
  );
}

function eligibleDaysRemaining(
  purchase: Purchase,
  nowCalendarDay: number,
  config: MatcherConfig,
): number | null {
  if (
    !isSafePositiveInteger(purchase.paidUnitCents) ||
    !isSafePositiveInteger(purchase.quantity)
  ) {
    return null;
  }
  const purchasedAt = parseTimestamp(purchase.purchasedAt);
  if (!purchasedAt) return null;
  const elapsedDays = (nowCalendarDay - purchasedAt.calendarDay) / 86_400_000;
  if (elapsedDays < 0 || elapsedDays > config.adjustmentWindowDays) return null;
  return Math.max(
    0,
    Math.min(
      config.adjustmentWindowDays,
      config.adjustmentWindowDays - elapsedDays,
    ),
  );
}

function candidateForPrice(
  purchase: Purchase,
  observation: PriceObservation,
  currentUnitCents: number,
  daysRemaining: number,
  config: MatcherConfig,
  comparisonChannel: AdjustmentCandidate['comparisonChannel'],
): AdjustmentCandidate[] {
  if (currentUnitCents >= purchase.paidUnitCents) return [];
  const savingsCents =
    (purchase.paidUnitCents - currentUnitCents) * purchase.quantity;
  if (
    !isSafePositiveInteger(savingsCents) ||
    savingsCents < config.minimumSavingsCents
  ) {
    return [];
  }
  return [
    {
      comparisonChannel,
      currentUnitCents,
      daysRemaining,
      observation,
      purchase,
      savingsCents,
    },
  ];
}

function compareCandidates(
  left: AdjustmentCandidate,
  right: AdjustmentCandidate,
): number {
  return (
    left.daysRemaining - right.daysRemaining ||
    right.savingsCents - left.savingsCents ||
    left.purchase.id.localeCompare(right.purchase.id)
  );
}

function latestByItemAndWarehouse(
  observations: readonly PriceObservation[],
): Map<string, PriceObservation> {
  const latest = new Map<
    string,
    { observation: PriceObservation; observedAt: number }
  >();

  for (const observation of observations) {
    const observedAt = parseTimestamp(observation.observedAt);
    if (!observedAt) {
      continue;
    }

    const key = observationKey(
      observation.itemNumber,
      observation.warehouseNumber,
    );
    const existing = latest.get(key);
    if (!existing || observedAt.instant > existing.observedAt) {
      latest.set(key, { observation, observedAt: observedAt.instant });
    }
  }

  return new Map(
    [...latest.entries()].map(([key, value]) => [key, value.observation]),
  );
}

function isUsable(
  observation: PriceObservation,
): observation is PriceObservation & { readonly unitPriceCents: number } {
  return (
    observation.unresolvedReason === null &&
    observation.unitPriceCents !== null &&
    isSafePositiveInteger(observation.unitPriceCents)
  );
}

export function isUsableOnlinePrice(
  price: ReportPriceChannels['costcoCom'],
): price is ReportPriceChannels['costcoCom'] & {
  readonly observedAt: string;
  readonly source: string;
  readonly unitPriceCents: number;
} {
  return (
    price.channel === 'costco_com' &&
    price.unavailableReason === null &&
    price.observedAt !== null &&
    parseTimestamp(price.observedAt) !== null &&
    price.source !== null &&
    isSafePositiveInteger(price.unitPriceCents ?? 0)
  );
}

function isValidConfig(config: MatcherConfig): boolean {
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

function observationKey(itemNumber: string, warehouseNumber: string): string {
  return `${itemNumber}\u0000${warehouseNumber}`;
}

function parseTimestamp(value: string): ParsedTimestamp | null {
  const match = TIMESTAMP_PATTERN.exec(value);
  if (!match) {
    return null;
  }

  const [
    ,
    yearText,
    monthText,
    dayText,
    hourText,
    minuteText,
    secondText,
    ,
    offset,
  ] = match;
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

  const localInstant = utcInstant(year, month, day, hour, minute, second);
  const calendarDay = utcInstant(year, month, day, 0, 0, 0);
  if (offset === undefined) return { calendarDay, instant: localInstant };

  const instant = Date.parse(value);
  return Number.isFinite(instant) ? { calendarDay, instant } : null;
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

function calendarDayForDate(value: Date): number | null {
  if (!Number.isFinite(value.getTime())) {
    return null;
  }

  return utcInstant(
    value.getFullYear(),
    value.getMonth() + 1,
    value.getDate(),
    0,
    0,
    0,
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
