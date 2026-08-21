import { describe, expect, it } from 'vitest';

import type { AdjustmentCandidate } from '../src/domain/types.js';
import {
  alertFingerprint,
  selectAlerts,
  urgencyBucket,
} from '../src/core/alert-policy.js';
import type { AlertState } from '../src/storage/database.js';

const candidate: AdjustmentCandidate = {
  currentUnitCents: 1200,
  daysRemaining: 8,
  observation: {
    itemNumber: '100001',
    observedAt: '2026-08-18T09:00:00.000Z',
    source: 'warehouse-price-api',
    unitPriceCents: 1200,
    unresolvedReason: null,
    warehouseNumber: '123',
  },
  purchase: {
    couponCents: 0,
    id: 'purchase-1',
    itemNumber: '100001',
    paidUnitCents: 1500,
    purchasedAt: '2026-08-10T09:00:00.000Z',
    quantity: 2,
    receiptId: 'receipt-1',
    warehouseNumber: '123',
  },
  savingsCents: 600,
};

function state(
  lastNotifiedPriceCents: number,
  urgency: AlertState['urgencyBucket'],
): AlertState {
  return {
    lastNotifiedPriceCents,
    purchaseId: candidate.purchase.id,
    urgencyBucket: urgency,
  };
}

describe('alert policy', () => {
  it('selects a first potential adjustment alert and creates a stable fingerprint', () => {
    expect(selectAlerts([candidate], [])).toEqual([
      {
        candidate,
        state: {
          lastNotifiedPriceCents: 1200,
          purchaseId: 'purchase-1',
          urgencyBucket: 'normal',
        },
      },
    ]);
    expect(alertFingerprint(candidate)).toBe('purchase-1:1200:normal');
  });

  it('suppresses an alert with an identical notified price and urgency', () => {
    expect(selectAlerts([candidate], [state(1200, 'normal')])).toEqual([]);
  });

  it('selects an alert when the current price falls below the last notified price', () => {
    const lowerPrice = { ...candidate, currentUnitCents: 1100 };

    expect(selectAlerts([lowerPrice], [state(1200, 'normal')])).toEqual([
      {
        candidate: lowerPrice,
        state: {
          lastNotifiedPriceCents: 1100,
          purchaseId: 'purchase-1',
          urgencyBucket: 'normal',
        },
      },
    ]);
  });

  it('re-alerts as a candidate becomes urgent at three and one calendar days remaining', () => {
    const threeDays = { ...candidate, daysRemaining: 3 };
    const oneDay = { ...candidate, daysRemaining: 1 };

    expect(urgencyBucket(candidate)).toBe('normal');
    expect(urgencyBucket(threeDays)).toBe('3-days');
    expect(urgencyBucket(oneDay)).toBe('1-day');
    expect(selectAlerts([threeDays], [state(1200, 'normal')])).toEqual([
      expect.objectContaining({ candidate: threeDays }),
    ]);
    expect(selectAlerts([oneDay], [state(1200, '3-days')])).toEqual([
      expect.objectContaining({ candidate: oneDay }),
    ]);
  });
});
