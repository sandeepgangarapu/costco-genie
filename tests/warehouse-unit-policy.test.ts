import { describe, expect, it, vi } from 'vitest';
import {
  fetchReportPriceEvidence,
  resolveWarehousePriceEvidence,
  type PriceRequest,
} from '../src/costco/price-client.js';
import { isUsableReportPriceEvidence } from '../src/core/price-evidence.js';
import { normalizeReceipts } from '../src/core/normalize-receipts.js';
import { findAdjustments } from '../src/core/matcher.js';
import type { ReportPriceObservation } from '../src/domain/types.js';

const now = () => new Date('2026-10-24T12:00:00Z');
const request = (itemNumber = '900011'): PriceRequest => ({
  itemNumber,
  warehouseNumber: '123',
  purchaseChannel: 'warehouse',
  description: 'Synthetic packaged item',
  paidUnitCents: 2500,
});
const display: ReportPriceObservation = {
  channel: 'warehouse_display',
  source: 'warehouse_display_price_api',
  observedAt: now().toISOString(),
  unitPriceCents: 2000,
  unavailableReason: null,
  promotionText: null,
  warehouseEvidence: {
    warehouseNumber: '123',
    unitBasis: 'unknown',
    baseCents: 2000,
    deliveredCents: 2000,
    discountCents: 0,
  },
};

describe('assumed package comparisons', () => {
  it.each(['warehouse_savings', 'warehouse'] as const)(
    'does not bypass the plausibility guard through %s fallback',
    (channel) => {
      const quotation = {
        ...display,
        channel,
        source:
          channel === 'warehouse'
            ? 'warehouse-price-api'
            : 'warehouse_savings_page',
        warehouseEvidence: {
          ...display.warehouseEvidence!,
          unitBasis: 'each' as const,
          scope: 'warehouse' as const,
        },
      };
      const resolved = resolveWarehousePriceEvidence(
        { ...request(), paidUnitCents: 4001 },
        undefined,
        channel === 'warehouse_savings' ? quotation : undefined,
        channel === 'warehouse' ? quotation : undefined,
      );
      expect(resolved).toMatchObject({
        unitPriceCents: null,
        unavailableReason: 'warehouse_possible_unit_mismatch',
        warehouseEvidence: { quotationCents: 2000 },
      });
    },
  );

  it('verifies unknown display/booklet units with explicit assumed-package evidence', () => {
    for (const channel of ['warehouse_display', 'warehouse_savings'] as const) {
      const quotation = {
        ...display,
        channel,
        warehouseEvidence: {
          ...display.warehouseEvidence!,
          scope: 'warehouse' as const,
        },
      };
      const resolved = resolveWarehousePriceEvidence(
        request(),
        channel === 'warehouse_display' ? quotation : undefined,
        channel === 'warehouse_savings' ? quotation : undefined,
        undefined,
      );
      expect(resolved).toMatchObject({
        unitPriceCents: 2000,
        unavailableReason: null,
        warehouseEvidence: {
          unitBasis: 'unknown',
          comparisonBasis: 'assumed_package',
        },
      });
      expect(isUsableReportPriceEvidence(resolved, 'warehouse')).toBe(true);
      expect(
        isUsableReportPriceEvidence(
          {
            ...resolved,
            warehouseEvidence: {
              ...resolved.warehouseEvidence!,
              comparisonBasis: undefined,
            },
          },
          'warehouse',
        ),
      ).toBe(false);
    }
  });

  it.each([
    [3999, null],
    [4000, null],
    [4001, 'warehouse_possible_unit_mismatch'],
  ])(
    'applies the strict 50%% boundary against net paid cents %s',
    (paidUnitCents, reason) => {
      const resolved = resolveWarehousePriceEvidence(
        { ...request(), paidUnitCents },
        display,
        undefined,
        undefined,
      );
      expect(resolved.unavailableReason).toBe(reason);
      expect(resolved.unitPriceCents).toBe(reason ? null : 2000);
      expect(resolved.warehouseEvidence?.quotationCents).toBe(2000);
      expect(isUsableReportPriceEvidence(resolved, 'warehouse')).toBe(
        reason === null,
      );
    },
  );
});

describe('unit guards and selective Same-Day fallback (offline HTTP)', () => {
  const cases = [
    {
      label: 'zero-dollar display per-pound disclaimer',
      disclaimer: true,
      reason: 'warehouse_per_lb_not_comparable_to_receipt_package',
    },
    {
      label: 'booklet per-pound rate',
      booklet: 'per pound',
      reason: 'warehouse_per_lb_not_comparable_to_receipt_package',
    },
    {
      label: 'catalog avg wt description even without WH program',
      catalog: 'Synthetic roast, avg wt 5 lbs',
      reason:
        'warehouse_catalog_variable_weight_not_comparable_to_receipt_package',
    },
    {
      label: 'catalog per lb description',
      catalog: 'Synthetic roast per lb',
      reason:
        'warehouse_catalog_variable_weight_not_comparable_to_receipt_package',
    },
    {
      label: 'catalog /lb description',
      catalog: 'Synthetic roast /lb',
      reason:
        'warehouse_catalog_variable_weight_not_comparable_to_receipt_package',
    },
    {
      label: 'catalog variable-weight flag',
      attributes: [{ key: 'isVariableWeight', value: true }],
      reason:
        'warehouse_catalog_variable_weight_not_comparable_to_receipt_package',
    },
    {
      label: 'catalog variable-weight attribute text',
      attributes: [{ key: 'Unit Price', value: 'per lb' }],
      reason:
        'warehouse_catalog_variable_weight_not_comparable_to_receipt_package',
    },
    {
      label: 'receipt variable-weight description',
      receiptDescription: 'Synthetic roast avg wt 5 lbs',
      reason:
        'warehouse_receipt_variable_weight_not_comparable_to_receipt_package',
    },
    {
      label: 'booklet average weight',
      booklet: 'average weight 5 lbs',
      reason:
        'warehouse_booklet_variable_weight_not_comparable_to_receipt_package',
    },
    {
      label: 'price below half net receipt payment',
      paidUnitCents: 4001,
      reason: 'warehouse_possible_unit_mismatch',
    },
  ];
  it.each(cases)(
    'blocks $label and sends only that line to Same-Day',
    async (testCase) => {
      const unsafe = {
        ...request('900012'),
        description:
          'receiptDescription' in testCase
            ? testCase.receiptDescription
            : 'Synthetic packaged item',
        paidUnitCents:
          'paidUnitCents' in testCase ? testCase.paidUnitCents : 2500,
      };
      const requests = [request(), unsafe];
      const queries: string[] = [];
      const fetchFn: typeof fetch = async (input, init) => {
        if (String(input).includes('/warehouse-savings')) {
          return new Response(
            'booklet' in testCase
              ? `<article data-item-number="900012" data-applicability="warehouse" data-start-date="2026-10-01" data-end-date="2026-10-31" data-final-price="20.00">$20.00 ${testCase.booklet}</article>`
              : '<p>No offers</p>',
          );
        }
        if (String(input).includes('/display-price-lite'))
          return Response.json({
            priceData: requests.map((r) => ({
              id: r.itemNumber,
              displayPrice: [
                {
                  warehouseNumber: '123',
                  currency: 'USD',
                  onlinePrice: 20,
                  aggregatedDiscountAmt: 0,
                  deliveredPrice: 20,
                  uom: null,
                  factor: null,
                },
              ],
              discounts: [
                {
                  warehouseNumber: '123',
                  promotions:
                    r.itemNumber === '900012' && 'disclaimer' in testCase
                      ? [
                          {
                            calculatedDiscountAmount: 0,
                            text: {
                              disclaimerText: {
                                'en-US': { text: 'Price is per pound' },
                              },
                            },
                          },
                        ]
                      : [],
                },
              ],
            })),
          });
        queries.push(JSON.parse(String(init?.body)).query);
        return Response.json({
          data: {
            products: {
              catalogData: [
                {
                  itemNumber: '900012',
                  programTypes: 'ONLINE',
                  priceData: { price: '20.00' },
                  description: {
                    shortDescription:
                      'catalog' in testCase
                        ? testCase.catalog
                        : 'Synthetic packaged item',
                  },
                  attributes:
                    'attributes' in testCase ? testCase.attributes : [],
                },
              ],
            },
          },
        });
      };
      const sameDayPriceFetcher = vi.fn(async () => []);
      const result = await fetchReportPriceEvidence(requests, {
        fetchFn,
        now,
        sameDayPriceFetcher,
        sameDayPostalCode: '10001',
        sameDayRepresentativeAddress:
          '123 Example Street, Sample City, NY 10001',
        sameDayMarkupPercent: 13.5,
      });
      expect(result.items[0].prices.warehouse).toMatchObject({
        unitPriceCents: 2000,
        unavailableReason: null,
      });
      const blocked = result.items[1].prices.warehouse;
      expect(blocked).toMatchObject({
        unitPriceCents: null,
        unavailableReason: testCase.reason,
        warehouseEvidence: {
          quotationCents: 2000,
          unitReason: testCase.reason,
        },
      });
      expect(isUsableReportPriceEvidence(blocked, 'warehouse')).toBe(false);
      expect(sameDayPriceFetcher).toHaveBeenCalledExactlyOnceWith(
        [expect.objectContaining(unsafe)],
        expect.anything(),
      );
      expect(queries[0]).toContain('description { shortDescription }');
      expect(queries[0]).toContain('attributes { key value }');
      const purchases = normalizeReceipts(
        {
          transactions: [
            {
              receiptId: '0000000000000000000001',
              transactionType: 'Purchase',
              warehouseNumber: '123',
              purchasedAt: '2026-10-20T12:00:00Z',
              coupons: [],
              items: [
                {
                  itemNumber: unsafe.itemNumber,
                  unitPrice: '25.00',
                  quantity: 1,
                  description: unsafe.description,
                },
              ],
            },
          ],
        },
        now(),
      );
      expect(
        findAdjustments(
          purchases,
          [
            {
              itemNumber: unsafe.itemNumber,
              warehouseNumber: '123',
              observedAt: now().toISOString(),
              source: blocked.source!,
              unitPriceCents: blocked.unitPriceCents,
              unresolvedReason: blocked.unavailableReason,
              warehouseEvidence: blocked.warehouseEvidence,
            },
          ],
          now(),
          { adjustmentWindowDays: 30, minimumSavingsCents: 1 },
        ),
      ).toEqual([]);
    },
  );

  it('keeps the highest net payment and positive receipt weight evidence across duplicate requests', async () => {
    const sameDayPriceFetcher = vi.fn(async () => []);
    const result = await fetchReportPriceEvidence(
      [
        {
          ...request(),
          paidUnitCents: 4500,
          description: 'Synthetic roast /lb',
        },
        request(),
      ],
      {
        now,
        fetchFn: async () =>
          Response.json({ data: { products: { catalogData: [] } } }),
        warehouseDisplayPriceFetcher: async () => [
          { ...request(), ...display },
        ],
        sameDayPriceFetcher,
        sameDayPostalCode: '10001',
        sameDayRepresentativeAddress:
          '123 Example Street, Sample City, NY 10001',
        sameDayMarkupPercent: 13.5,
      },
    );
    expect(result.items).toHaveLength(1);
    expect(result.items[0].prices.warehouse.unavailableReason).toBe(
      'warehouse_receipt_variable_weight_not_comparable_to_receipt_package',
    );
    expect(sameDayPriceFetcher.mock.calls[0][0]).toMatchObject([
      { paidUnitCents: 4500, receiptVariableWeight: true },
    ]);
  });
});
