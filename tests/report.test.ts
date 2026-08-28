import { describe, expect, it } from 'vitest';

import type { AdjustmentCandidate } from '../src/domain/types.js';
import {
  renderCompactReport,
  renderHtmlReport,
  renderTextReport,
} from '../src/notifications/report.js';

const candidate: AdjustmentCandidate = {
  comparisonChannel: 'warehouse',
  currentUnitCents: 1199,
  daysRemaining: 3,
  observation: {
    itemNumber: '100001',
    observedAt: '2026-08-18T09:00:00.000Z',
    source: 'warehouse-price-api',
    unitPriceCents: 1199,
    unresolvedReason: null,
    warehouseNumber: '123',
  },
  purchase: {
    couponCents: 0,
    description: '<img src=x onerror=alert(1)>',
    id: 'purchase-1',
    itemNumber: '100001<script>',
    paidUnitCents: 1500,
    purchaseChannel: 'warehouse',
    purchasedAt: '2026-08-15T09:00:00.000Z',
    quantity: 2,
    receiptId: 'receipt-1',
    warehouseNumber: '123&main',
  },
  savingsCents: 602,
};

const onlineCandidate: AdjustmentCandidate = {
  ...candidate,
  comparisonChannel: 'costco_com',
  observation: {
    ...candidate.observation,
    source: 'costco_product_api',
    warehouseNumber: '847',
  },
  purchase: {
    ...candidate.purchase,
    description: 'Kirkland Coffee',
    id: 'online-purchase-1',
    itemNumber: '200001',
    purchaseChannel: 'costco_com',
    receiptId: 'costco.com:ORDER-1',
    warehouseNumber: '847',
  },
};

describe('report rendering', () => {
  it('does not add Costco.com guidance to an empty HTML report', () => {
    const report = renderHtmlReport({ candidates: [] });

    expect(report).toContain('No potential price adjustments found.');
    expect(report).not.toContain('current Costco.com price');
  });

  it.each([
    ['compact', renderCompactReport],
    ['text', renderTextReport],
    ['HTML', renderHtmlReport],
  ])(
    'renders a verified Costco.com candidate correctly in the %s report',
    (_name, render) => {
      const report = render({ candidates: [onlineCandidate] });

      expect(report).toContain('Costco.com order');
      expect(report).toContain('Current Costco.com price: $11.99');
      expect(report).toContain('Potential savings: $6.02');
      expect(report).not.toMatch(/WH\s*847/i);
      expect(report).not.toMatch(/original warehouse/i);
      expect(report).not.toMatch(/eligib(?:le|ility)/i);
      expect(report).not.toMatch(/adjustment/i);
    },
  );

  it('renders a compact potential-adjustment text report with original warehouse, prices, savings, and days remaining', () => {
    const report = renderTextReport({ candidates: [candidate] });

    expect(report).toMatch(
      /^Potential Costco price adjustments\nItem 100001<script> \| <img src=x onerror=alert\(1\)> \| Purchased 2026-08-15\n/,
    );
    expect(report).toContain('Potential Costco price adjustments');
    expect(report).toContain(
      'Verify this potential adjustment at the original warehouse.',
    );
    expect(report).toContain('Warehouse: 123&main');
    expect(report).toContain('Paid: $15.00');
    expect(report).toContain('Current: $11.99');
    expect(report).toContain('Potential savings: $6.02');
    expect(report).toContain('3 days remaining');
  });

  it('escapes every vendor and user supplied string in the HTML report', () => {
    const report = renderHtmlReport({ candidates: [candidate] });

    expect(report).toContain(
      '<p><strong>Item 100001&lt;script&gt;</strong> | &lt;img src=x onerror=alert(1)&gt; | Purchased 2026-08-15</p>',
    );
    expect(report).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(report).toContain('100001&lt;script&gt;');
    expect(report).toContain('123&amp;main');
    expect(report).not.toContain('<img src=x');
    expect(report).not.toContain('<script>');
    expect(report).toContain('potential price adjustment');
    expect(report).toContain('Paid: $15.00');
    expect(report).toContain('Current: $11.99');
    expect(report).toContain('Potential savings: $6.02');
    expect(report).toContain('3 days remaining');
  });

  it('strips Unicode format controls from plain-text vendor content', () => {
    const report = renderTextReport({
      candidates: [
        {
          ...candidate,
          purchase: {
            ...candidate.purchase,
            description: 'Kirkland\u2060paper towels',
          },
        },
      ],
    });

    expect(report).toContain('Kirklandpaper towels');
    expect(report).not.toContain('\u2060');
  });

  it('bounds the local report while preserving counts, total savings, and urgency order', () => {
    const candidates = Array.from({ length: 20 }, (_, index) => ({
      ...candidate,
      daysRemaining: index === 19 ? 1 : 10 + index,
      purchase: {
        ...candidate.purchase,
        description: `${'Very long vendor description '.repeat(8)}${String(index)}`,
        id: `purchase-${String(index)}`,
        itemNumber: String(100000 + index),
      },
      savingsCents: index === 19 ? 100 : 1000 + index,
    }));

    const report = renderCompactReport({ candidates });

    expect(report.length).toBeLessThanOrEqual(480);
    expect(report).toContain('20 potential adjustments');
    expect(report).toContain('$192.71 total potential savings');
    expect(report).toContain('item 100019');
    expect(report.indexOf('item 100019')).toBeLessThan(
      report.indexOf('item 100000'),
    );
    expect(report).toContain('+17 more');
    expect(report).toContain('Verify at the original warehouse');
  });
});
