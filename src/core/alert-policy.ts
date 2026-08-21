import type { AdjustmentCandidate } from '../domain/types.js';
import type { AlertState } from '../storage/database.js';

export type UrgencyBucket = 'normal' | '3-days' | '1-day';

export interface AlertSelection {
  readonly candidate: AdjustmentCandidate;
  readonly state: AlertState;
}

export function urgencyBucket(candidate: AdjustmentCandidate): UrgencyBucket {
  if (candidate.daysRemaining <= 1) {
    return '1-day';
  }
  if (candidate.daysRemaining <= 3) {
    return '3-days';
  }
  return 'normal';
}

export function alertFingerprint(candidate: AdjustmentCandidate): string {
  return [
    candidate.purchase.id,
    candidate.currentUnitCents,
    urgencyBucket(candidate),
  ].join(':');
}

export function selectAlerts(
  candidates: readonly AdjustmentCandidate[],
  states: readonly AlertState[],
): AlertSelection[] {
  const stateByPurchaseId = new Map(
    states.map((state) => [state.purchaseId, state]),
  );

  return candidates.flatMap((candidate) => {
    const priorState = stateByPurchaseId.get(candidate.purchase.id);
    const bucket = urgencyBucket(candidate);
    if (!shouldAlert(candidate, bucket, priorState)) {
      return [];
    }

    return [
      {
        candidate,
        state: {
          lastNotifiedPriceCents: candidate.currentUnitCents,
          purchaseId: candidate.purchase.id,
          urgencyBucket: bucket,
        },
      },
    ];
  });
}

function shouldAlert(
  candidate: AdjustmentCandidate,
  bucket: UrgencyBucket,
  priorState: AlertState | undefined,
): boolean {
  if (!priorState) {
    return true;
  }

  return (
    candidate.currentUnitCents < priorState.lastNotifiedPriceCents ||
    urgencyRank(bucket) > urgencyRank(priorState.urgencyBucket)
  );
}

function urgencyRank(bucket: string): number {
  switch (bucket) {
    case '1-day':
      return 2;
    case '3-days':
      return 1;
    case 'normal':
      return 0;
    default:
      return -1;
  }
}
