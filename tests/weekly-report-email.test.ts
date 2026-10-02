import { describe, expect, it } from 'vitest';

import type {
  AdjustmentCandidate,
  FullReportRow,
  ReportPriceObservation,
} from '../src/domain/types.js';
import {
  renderWeeklyReportEmail,
  renderWeeklyReportHtml,
} from '../src/notifications/weekly-report-email.js';

function price(
  channel: ReportPriceObservation['channel'],
  unitPriceCents: number | null,
  unavailableReason: string | null = null,
): ReportPriceObservation {
  return {
    channel,
    unitPriceCents,
    unavailableReason,
    source: unitPriceCents === null ? null : 'test-source',
    observedAt: unitPriceCents === null ? null : '2026-10-02T23:00:00.000Z',
    promotionText: null,
  };
}

const candidate: AdjustmentCandidate = {
  comparisonChannel: 'same_day',
  currentUnitCents: 800,
  daysRemaining: 5,
  estimated: true,
  observation: {
    itemNumber: '100001',
    observedAt: '2026-10-02T23:00:00.000Z',
    source: 'costco_same_day_estimate',
    unitPriceCents: 800,
    unresolvedReason: null,
    warehouseNumber: '123',
  },
  purchase: {
    couponCents: 0,
    description: 'Test Butter',
    id: 'purchase-1',
    itemNumber: '100001',
    paidUnitCents: 1000,
    purchaseChannel: 'warehouse',
    purchasedAt: '2026-09-27T23:00:00.000Z',
    quantity: 1,
    receiptId: 'receipt-1',
    warehouseNumber: '123',
  },
  savingsCents: 200,
};

function row(
  purchase: FullReportRow['purchase'],
  sameDayPriceCents: number | null,
  daysRemaining: number,
  sameDayUnavailableReason: string | null = null,
): FullReportRow {
  return {
    purchase,
    prices: {
      warehouse: price('warehouse', null, 'not_warehouse_price'),
      receiptHistory: price('receipt_history', null),
      warehouseSavings: price('warehouse_savings', null),
      costcoCom: price('costco_com', null, 'invalid_price'),
      sameDay: price('same_day', sameDayPriceCents, sameDayUnavailableReason),
    },
    comparisonChannel: sameDayPriceCents === null ? null : 'same_day',
    comparisonUnitCents: sameDayPriceCents === null ? null : 800,
    comparisonDeltaCents: sameDayPriceCents === null ? null : 200,
    potentialSavingsCents: sameDayPriceCents === null ? null : 200,
    sameDayWarehouseEstimateCents: sameDayPriceCents === null ? null : 800,
    sameDayMarkupPercent: 13.5,
    sameDayEstimatedDeltaCents: sameDayPriceCents === null ? null : 200,
    warehouseDeltaCents: null,
    daysRemaining,
    status:
      sameDayPriceCents === null ? 'not_eligible' : 'estimated_opportunity',
    reason: null,
  };
}

describe('renderWeeklyReportEmail', () => {
  it('shows a readable Pacific timestamp and end stats for an empty check', () => {
    const body = renderWeeklyReportEmail({
      candidates: [],
      rows: [],
      startedAt: '2026-10-02T23:00:00.000Z',
    });

    expect(body).toContain('Checked: Friday, October 2, 2026 at 4:00 PM PDT');
    expect(body).not.toContain('Costco weekly price report');
    expect(body).toContain('None found.');
    expect(body).toContain('Items considered: 0');
    expect(body).toContain('Prices found: 0 of 0 (0 verified; 0 Same-Day)');
    expect(body).toContain(
      'Potential adjustments: 0 (0 verified; 0 Same-Day estimates)',
    );
    expect(body.trimEnd().endsWith('Current prices unavailable: (none)')).toBe(
      true,
    );
  });

  it('shows one adjustment row and puts unavailable names only at the end', () => {
    const unavailableWarehouse = {
      ...candidate.purchase,
      description: 'Seaweed Sticks',
      id: 'purchase-2',
      itemNumber: '2066942',
      paidUnitCents: 597,
    };
    const unavailableOnline = {
      ...candidate.purchase,
      description: 'Solar Light',
      id: 'purchase-3',
      itemNumber: '1937995',
      paidUnitCents: 2999,
      purchaseChannel: 'costco_com' as const,
    };
    const report = {
      candidates: [candidate],
      rows: [
        row(candidate.purchase, 907, 5),
        row(unavailableWarehouse, null, 1, 'exact_item_not_found'),
        row(unavailableOnline, null, 2),
      ],
      startedAt: '2026-10-02T23:00:00.000Z',
    };
    const body = renderWeeklyReportEmail(report);
    const html = renderWeeklyReportHtml(report);

    expect(body).toContain(
      '| Item / name | Paid / unit | Current / unit | Savings total | Purchased | Days left | Source |',
    );
    expect(body).toContain(
      '| Test Butter (item #100001, WH 123) | $10.00 | ~$8.00 | ~$2.00 | Sep 27, 2026 | 5 days | Same-Day estimate |',
    );
    expect(body).not.toContain('Item 2066942');
    expect(body).not.toContain('Item 1937995');
    expect(body).toContain('Items considered: 3');
    expect(body).toContain('Prices found: 1 of 3 (0 verified; 1 Same-Day)');
    expect(body).toContain(
      'Potential adjustments: 1 (0 verified; 1 Same-Day estimates)',
    );
    expect(
      body
        .trimEnd()
        .endsWith('Current prices unavailable: (Seaweed Sticks; Solar Light)'),
    ).toBe(true);
    expect(html).toContain('<table');
    expect(html).toContain('<strong>Test Butter</strong>');
    expect(html).toContain('Item #100001 · WH 123');
    expect(html).toContain(
      'Current prices unavailable: (Seaweed Sticks; Solar Light)',
    );
    expect(html.indexOf('Solar Light')).toBeGreaterThan(
      html.indexOf('</table>'),
    );
  });

  it('escapes names in the HTML table and unavailable-name footer', () => {
    const unsafeCandidate = {
      ...candidate,
      purchase: { ...candidate.purchase, description: '<Butter & Milk>' },
    };
    const unavailable = {
      ...candidate.purchase,
      description: '<Missing & Price>',
      id: 'missing',
    };
    const html = renderWeeklyReportHtml({
      candidates: [unsafeCandidate],
      rows: [row(candidate.purchase, 907, 5), row(unavailable, null, 2)],
      startedAt: '2026-10-02T23:00:00.000Z',
    });

    expect(html).toContain('&lt;Butter &amp; Milk&gt;');
    expect(html).toContain('&lt;Missing &amp; Price&gt;');
    expect(html).not.toContain('<Butter & Milk>');
    expect(html).not.toContain('<Missing & Price>');
  });
});
