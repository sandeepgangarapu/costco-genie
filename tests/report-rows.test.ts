import { describe, expect, it } from 'vitest';

import { buildReportRows } from '../src/core/report-rows.js';
import type { PriceObservation, Purchase } from '../src/domain/types.js';

const purchase: Purchase = {
  couponCents: 300,
  grossUnitCents: 1200,
  id: 'purchase-1',
  itemNumber: '2048748',
  paidUnitCents: 1050,
  purchasedAt: '2026-08-10T12:00:00.000Z',
  quantity: 2,
  receiptId: 'receipt-1',
  warehouseNumber: '129',
};

const warehousePrice: PriceObservation = {
  itemNumber: '2048748',
  observedAt: '2026-08-18T12:00:00.000Z',
  source: 'warehouse-price-api',
  unitPriceCents: 900,
  unresolvedReason: null,
  warehouseNumber: '129',
};

describe('buildReportRows', () => {
  it('derives one candidate row per purchase line using the latest same-warehouse price', () => {
    const rows = buildReportRows(
      [purchase],
      [
        { ...warehousePrice, observedAt: '2026-08-17T12:00:00.000Z' },
        warehousePrice,
        { ...warehousePrice, unitPriceCents: 100, warehouseNumber: '130' },
      ],
      new Date('2026-08-18T12:00:00.000Z'),
      { adjustmentWindowDays: 30, minimumSavingsCents: 1 },
    );

    expect(rows).toEqual([
      {
        daysRemaining: 22,
        purchase,
        reason: null,
        status: 'candidate',
        warehouseDeltaCents: 150,
        warehousePrice,
      },
    ]);
  });

  it('keeps a purchase row when its same-warehouse price is unavailable', () => {
    const unavailable: PriceObservation = {
      ...warehousePrice,
      unitPriceCents: null,
      unresolvedReason: 'batch_failed',
    };

    expect(
      buildReportRows(
        [purchase],
        [unavailable],
        new Date('2026-08-18T12:00:00.000Z'),
        { adjustmentWindowDays: 30, minimumSavingsCents: 1 },
      ),
    ).toEqual([
      {
        daysRemaining: 22,
        purchase,
        reason: 'batch_failed',
        status: 'not_eligible',
        warehouseDeltaCents: null,
        warehousePrice: unavailable,
      },
    ]);
  });
});
