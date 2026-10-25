import { expect, it, vi } from 'vitest';
import { fetchReportPriceEvidence } from '../src/costco/price-client.js';
import { parseSavingsForItem } from '../src/costco/warehouse-savings.js';
import { probeWarehouseCoverage } from '../src/costco/warehouse-coverage-probe.js';

const now = () => new Date('2026-10-24T12:00:00Z');
// Synthetic public-card layout: nested assets, a terms-only override BEFORE
// itemNumber, Flight-escaped hydration, and an adjacent card with other dates.
const cards = [
  {
    productImage: [{ apiDto: { attributes: { filename: 'synthetic.jpg' } } }],
    cardDescription: 'Synthetic cotton pajamas',
    validDatesOverride: 'Limit 8. Selection varies by location.',
    couponType: 'item',
    productId: '9000981000',
    itemNumber: '900981',
    applicability: 'warehouse_online',
    pricesOffCSObject: [
      {
        select_style: 'Vertical',
        prepend_text: '',
        _metadata: { uid: 'synthetic-card' },
        add_currency: true,
        value: ['16.75'],
        has_off: false,
        append_text: 'After $4 OFF',
        text_color: {},
      },
    ],
  },
  {
    validDatesOverride: 'Valid 9/1/26 - 9/30/26',
    itemNumber: '900982',
    applicability: 'warehouse',
    pricesOffCSObject: [{ value: ['12.25'] }],
  },
];
const html =
  '<p>Valid 10/19/26 - 11/15/26</p><script>self.__next_f.push(' +
  JSON.stringify([1, JSON.stringify({ cards })]) +
  ')</script>';

it('uses the global dates for terms-only overrides without borrowing the next card dates', () => {
  expect(parseSavingsForItem(html, '900981', now())).toMatchObject({
    cents: 1675,
    finalCents: 1675,
    advertisedDiscountCents: 400,
    reason: null,
    promoStart: '2026-10-19',
    promoEnd: '2026-11-15',
    scope: 'warehouse',
  });
  expect(parseSavingsForItem(html, '900982', now())).toMatchObject({
    cents: null,
    reason: 'promotion_not_current',
    promoEnd: '2026-09-30',
  });
});

it('honors a card date override preceding itemNumber and rejects its malformed dates', () => {
  const fixture = (validDatesOverride: string) =>
    '<p>Valid 10/1/26 - 10/31/26</p><script>' +
    JSON.stringify({ ...cards[0], validDatesOverride }) +
    '</script>';
  expect(
    parseSavingsForItem(fixture('Valid 11/1/26 - 11/15/26'), '900981', now()),
  ).toMatchObject({
    cents: null,
    reason: 'promotion_not_current',
    promoStart: '2026-11-01',
  });
  expect(
    parseSavingsForItem(fixture('Valid 10/99/26 - 11/15/26'), '900981', now()),
  ).toMatchObject({
    cents: null,
    reason: 'promotion_not_current',
    promoStart: null,
  });
});

const fetchFn: typeof fetch = async (input) => {
  if (String(input).includes('/warehouse-savings')) return new Response(html);
  if (String(input).includes('/display-price-lite'))
    return Response.json({
      priceData: [
        {
          id: '900981',
          displayPrice: [
            {
              warehouseNumber: '123',
              currency: 'USD',
              onlinePrice: '20.75',
              deliveredPrice: '20.75',
              aggregatedDiscountAmt: 0,
              uom: null,
              factor: null,
            },
          ],
        },
      ],
    });
  return Response.json({ data: { products: { catalogData: [] } } });
};

it('fills the missing API promotion from the corroborated hydration final and skips Same-Day', async () => {
  const sameDayPriceFetcher = vi.fn(async () => []);
  const result = await fetchReportPriceEvidence(
    [
      {
        itemNumber: '900981',
        warehouseNumber: '123',
        purchaseChannel: 'warehouse',
        paidUnitCents: 2075,
      },
    ],
    {
      now,
      fetchFn,
      sameDayPriceFetcher,
      sameDayMarkupPercent: 13.5,
      sameDayPostalCode: '10001',
      sameDayRepresentativeAddress: '123 Example Street, Sample City, NY 10001',
    },
  );
  expect(result.items[0].prices.warehouse).toMatchObject({
    unitPriceCents: 1675,
    unavailableReason: null,
    source: 'warehouse_savings_page',
    warehouseEvidence: {
      deliveredCents: 2075,
      bookletFinalCents: 1675,
      promoEnd: '2026-11-15',
      comparisonBasis: 'assumed_package',
      discountHandling: expect.stringContaining(
        'missing API promotion filled by corroborated booklet final',
      ),
    },
  });
  expect(sameDayPriceFetcher).not.toHaveBeenCalled();
});

it('counts savings quotations on their own channel and aggregates unavailable reasons without item data', async () => {
  const result = await probeWarehouseCoverage(['900981', '900983'], '123', {
    now,
    fetchFn,
  });
  expect(result).toMatchObject({
    requested: 2,
    display: 1,
    savings: 1,
    strictWH: 0,
    verifiedComparable: 1,
    sameDayWouldBeNeeded: 1,
    blockedOrUnavailableReasons: {
      display: { warehouse_display_not_found: 1 },
      savings: { item_not_advertised: 1 },
      strictWH: { product_not_found: 2 },
      verifiedComparable: { warehouse_display_not_found: 1 },
    },
  });
  expect(JSON.stringify(result)).not.toMatch(/900981|900983|2075|1675|123/);
});
