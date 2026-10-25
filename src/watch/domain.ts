// Ported from Costco Price Drop Checker; integrated with matcher boundaries.
export type PriceKind = 'online' | 'warehouse' | 'warehouse_estimate';
export type Channel = 'online' | 'warehouse' | 'both';
export type UnitBasis = 'each' | 'lb' | 'unknown';

export function unitBasis(value: unknown): UnitBasis {
  return value === 'each' || value === 'lb' ? value : 'unknown';
}

export interface WatchItem {
  id: number;
  itemNumber: string;
  name: string;
  url: string;
  channel: Channel;
  addedAt: string;
}

export interface Observation {
  itemId: number;
  kind: PriceKind;
  observedAt: string;
  cents: number | null;
  estimateCents: number | null;
  source: string;
  reason: string | null;
  promoEnd: string | null;
  evidence: Record<string, string | number | null>;
}

export interface Low {
  itemId: number;
  kind: PriceKind;
  baselineCents: number;
  lowCents: number;
  unitBasis?: UnitBasis;
}

export interface Drop {
  item: WatchItem;
  observation: Observation;
  previousLowCents: number;
  baselineCents: number;
  unverifiedReason?: string;
}

export interface SourceResult {
  productNames?: ReadonlyMap<number, string>;
  observations: Observation[];
  session:
    | 'authenticated'
    | 'signed_out'
    | 'unknown'
    | 'not_attempted'
    | 'not_required';
  diagnostics: string[];
}

export function kindsFor(channel: Channel): PriceKind[] {
  return channel === 'online'
    ? ['online']
    : channel === 'warehouse'
      ? ['warehouse', 'warehouse_estimate']
      : ['online', 'warehouse', 'warehouse_estimate'];
}

export function usable(observation: Observation): boolean {
  return (
    observation.reason === null &&
    observation.cents !== null &&
    Number.isSafeInteger(observation.cents) &&
    observation.cents > 0
  );
}

export function evaluateLow(
  previous: Low | undefined,
  observation: Observation,
  minimumDropCents: number,
): { low: Low | undefined; alert: boolean; unverifiedReason?: string } {
  if (!usable(observation)) return { low: previous, alert: false };
  const cents = observation.cents!;
  const unit = unitBasis(observation.evidence.unitBasis);
  if (
    observation.kind === 'warehouse' &&
    previous &&
    unit !== unitBasis(previous.unitBasis)
  )
    return {
      low: previous,
      alert: false,
      unverifiedReason: `Unit basis changed from ${unitBasis(previous.unitBasis)} to ${unit}; prices cannot be compared.`,
    };
  const api = observation.evidence.apiCents;
  const displayed = observation.evidence.displayedCents;
  const disagreement =
    observation.kind === 'online' &&
    typeof api === 'number' &&
    Number.isSafeInteger(api) &&
    api > 0 &&
    typeof displayed === 'number' &&
    Number.isSafeInteger(displayed) &&
    displayed > 0 &&
    Math.abs(displayed - api) > api * 0.5;
  const conflict =
    observation.kind === 'warehouse' &&
    typeof observation.evidence.conflictReason === 'string'
      ? observation.evidence.conflictReason
      : undefined;
  const unverifiedReason =
    conflict ||
    (disagreement
      ? 'Displayed and API prices differ by more than 50%.'
      : previous && cents < previous.lowCents * 0.5
        ? 'Price is less than 50% of the previous low.'
        : undefined);
  if (!previous) {
    // Conflicting sources must not establish a misleading silent baseline.
    if (unverifiedReason)
      return { low: undefined, alert: false, unverifiedReason };
    return {
      low: {
        itemId: observation.itemId,
        kind: observation.kind,
        baselineCents: cents,
        lowCents: cents,
        ...(observation.kind === 'warehouse' ? { unitBasis: unit } : {}),
      },
      alert: false,
    };
  }
  const alert =
    cents < previous.lowCents && previous.lowCents - cents >= minimumDropCents;
  return {
    low:
      alert && !unverifiedReason ? { ...previous, lowCents: cents } : previous,
    alert,
    unverifiedReason,
  };
}
