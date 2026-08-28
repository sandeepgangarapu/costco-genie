import { describe, expect, it } from 'vitest';

import type {
  PriceObservation,
  Purchase,
  ReportPriceObservation,
} from '../src/domain/types.js';
import {
  findAdjustments,
  findOnlineAdjustments,
  type OnlinePriceEvidence,
} from '../src/core/matcher.js';

const now = new Date('2026-08-18T12:00:00.000Z');

const purchase: Purchase = {
  couponCents: 0,
  description: 'Kirkland paper towels',
  id: 'purchase-1',
  itemNumber: '100001',
  paidUnitCents: 1500,
  purchaseChannel: 'warehouse',
  purchasedAt: '2026-07-19T08:00:00.000Z',
  quantity: 3,
  receiptId: 'receipt-1',
  warehouseNumber: '123',
};

const observation: PriceObservation = {
  itemNumber: '100001',
  observedAt: '2026-08-18T09:00:00.000Z',
  source: 'warehouse-price-api',
  unitPriceCents: 1200,
  unresolvedReason: null,
  warehouseNumber: '123',
};

const config = {
  adjustmentWindowDays: 30,
  minimumSavingsCents: 1,
};

const onlinePurchase: Purchase = {
  ...purchase,
  id: 'online-purchase-1',
  purchaseChannel: 'costco_com',
  purchasedAt: '2026-07-20T08:00:00.000Z',
  receiptId: 'costco_com:order-1',
  warehouseNumber: '847',
};

function onlineEvidence(
  pricePatch: Partial<ReportPriceObservation> = {},
  evidencePatch: Partial<OnlinePriceEvidence> = {},
): OnlinePriceEvidence {
  return {
    itemNumber: onlinePurchase.itemNumber,
    purchaseChannel: 'costco_com',
    warehouseNumber: onlinePurchase.warehouseNumber,
    prices: {
      costcoCom: {
        channel: 'costco_com',
        observedAt: observation.observedAt,
        promotionText: null,
        source: 'costco_product_api',
        unavailableReason: null,
        unitPriceCents: 1300,
        ...pricePatch,
      },
    },
    ...evidencePatch,
  };
}

describe('findAdjustments', () => {
  it('finds exact same-warehouse lower prices on the inclusive 30-day boundary with quantity-aware savings', () => {
    const candidates = findAdjustments([purchase], [observation], now, config);

    expect(candidates).toEqual([
      {
        comparisonChannel: 'warehouse',
        purchase,
        observation,
        currentUnitCents: 1200,
        savingsCents: 900,
        daysRemaining: 0,
      },
    ]);
  });

  it('does not match a different item number or a different warehouse', () => {
    const candidates = findAdjustments(
      [purchase],
      [
        { ...observation, itemNumber: '100002', unitPriceCents: 1000 },
        { ...observation, warehouseNumber: '456', unitPriceCents: 1000 },
      ],
      now,
      config,
    );

    expect(candidates).toEqual([]);
  });

  it('excludes purchases older than the inclusive eligibility window and prices that are not lower', () => {
    const candidates = findAdjustments(
      [
        { ...purchase, id: 'too-old', purchasedAt: '2026-07-18T08:00:00.000Z' },
        { ...purchase, id: 'same-price', itemNumber: '100002' },
      ],
      [
        observation,
        { ...observation, itemNumber: '100002', unitPriceCents: 1500 },
      ],
      now,
      config,
    );

    expect(candidates).toEqual([]);
  });

  it('uses the newest usable observation and excludes unresolved observations', () => {
    const newestUsable = {
      ...observation,
      observedAt: '2026-08-18T10:00:00.000Z',
      unitPriceCents: 1100,
    };
    const candidates = findAdjustments(
      [purchase, { ...purchase, id: 'unresolved-only', itemNumber: '100003' }],
      [
        observation,
        newestUsable,
        {
          ...observation,
          itemNumber: '100003',
          unitPriceCents: null,
          unresolvedReason: 'product_not_found',
        },
      ],
      now,
      config,
    );

    expect(candidates).toEqual([
      {
        comparisonChannel: 'warehouse',
        purchase,
        observation: newestUsable,
        currentUnitCents: 1100,
        savingsCents: 1200,
        daysRemaining: 0,
      },
    ]);
  });

  it('excludes an item when its latest observation is unresolved even if an older observation was lower', () => {
    const candidates = findAdjustments(
      [purchase],
      [
        observation,
        {
          ...observation,
          observedAt: '2026-08-18T10:00:00.000Z',
          unitPriceCents: null,
          unresolvedReason: 'product_not_found',
        },
      ],
      now,
      config,
    );

    expect(candidates).toEqual([]);
  });

  it('uses the leading printed calendar date for receipt timestamps regardless of offset', () => {
    const timezoneLessPurchase = {
      ...purchase,
      id: 'timezone-less',
      itemNumber: '100004',
      purchasedAt: '2026-07-19T23:30:00',
    };
    const offsetPurchase = {
      ...purchase,
      id: 'offset',
      itemNumber: '100005',
      purchasedAt: '2026-07-19T23:30:00-05:00',
    };

    const candidates = findAdjustments(
      [timezoneLessPurchase, offsetPurchase],
      [
        { ...observation, itemNumber: '100004' },
        { ...observation, itemNumber: '100005' },
      ],
      now,
      config,
    );

    expect(candidates).toMatchObject([
      { purchase: offsetPurchase, daysRemaining: 0 },
      { purchase: timezoneLessPurchase, daysRemaining: 0 },
    ]);
  });

  it('uses injected Mac-local calendar fields when UTC has rolled into the next day', () => {
    const westCoastNow = new (class extends Date {
      override getFullYear() {
        return 2026;
      }
      override getMonth() {
        return 7;
      }
      override getDate() {
        return 18;
      }
    })('2026-08-19T06:30:00.000Z');
    const printedAtUtc = {
      ...purchase,
      purchasedAt: '2026-07-19T23:30:00.000Z',
    };

    expect(
      findAdjustments([printedAtUtc], [observation], westCoastNow, config),
    ).toEqual([
      expect.objectContaining({
        comparisonChannel: 'warehouse',
        daysRemaining: 0,
        purchase: printedAtUtc,
      }),
    ]);
  });

  it('rejects malformed calendar timestamps instead of producing a candidate with a NaN deadline', () => {
    const candidates = findAdjustments(
      [{ ...purchase, purchasedAt: '2026-08-32T09:00:00Z' }],
      [observation],
      now,
      config,
    );

    expect(candidates).toEqual([]);
  });

  it.each([
    ['a fractional quantity', { quantity: 1.5 }, config],
    ['a zero quantity', { quantity: 0 }, config],
    ['a negative quantity', { quantity: -1 }, config],
    ['an unsafe quantity', { quantity: Number.MAX_SAFE_INTEGER + 1 }, config],
    [
      'an unsafe paid unit price',
      { paidUnitCents: Number.MAX_SAFE_INTEGER + 1, quantity: 1 },
      config,
    ],
    [
      'a price difference whose quantity multiplication is unsafe',
      { quantity: Number.MAX_SAFE_INTEGER },
      config,
    ],
    [
      'an unsafe minimum savings configuration',
      {},
      { ...config, minimumSavingsCents: Number.MAX_SAFE_INTEGER + 1 },
    ],
  ])(
    'rejects %s before calculating a candidate',
    (_, purchasePatch, configPatch) => {
      const candidates = findAdjustments(
        [{ ...purchase, ...purchasePatch }],
        [observation],
        now,
        configPatch,
      );

      expect(candidates).toEqual([]);
    },
  );
});

describe('findOnlineAdjustments', () => {
  it('finds an exact lower Costco.com price at the inclusive savings threshold using active quantity and Mac-local days', () => {
    const westCoastNow = new (class extends Date {
      override getFullYear() {
        return 2026;
      }
      override getMonth() {
        return 7;
      }
      override getDate() {
        return 18;
      }
    })('2026-08-19T06:30:00.000Z');
    const evidence = onlineEvidence();

    expect(
      findOnlineAdjustments([onlinePurchase], [evidence], westCoastNow, {
        adjustmentWindowDays: 30,
        minimumSavingsCents: 600,
      }),
    ).toEqual([
      {
        comparisonChannel: 'costco_com',
        currentUnitCents: 1300,
        daysRemaining: 1,
        observation: {
          itemNumber: onlinePurchase.itemNumber,
          observedAt: observation.observedAt,
          source: 'costco_product_api',
          unitPriceCents: 1300,
          unresolvedReason: null,
          warehouseNumber: onlinePurchase.warehouseNumber,
        },
        purchase: onlinePurchase,
        savingsCents: 600,
      },
    ]);
  });

  it.each([
    [
      'an equal price',
      onlinePurchase,
      onlineEvidence({ unitPriceCents: 1500 }),
    ],
    [
      'a higher price',
      onlinePurchase,
      onlineEvidence({ unitPriceCents: 1600 }),
    ],
    [
      'an unavailable price',
      onlinePurchase,
      onlineEvidence({
        observedAt: null,
        source: null,
        unavailableReason: 'product_not_found',
        unitPriceCents: null,
      }),
    ],
    [
      'savings below the minimum',
      onlinePurchase,
      onlineEvidence({ unitPriceCents: 1301 }),
    ],
    [
      'an order outside the window',
      { ...onlinePurchase, purchasedAt: '2026-07-18T08:00:00.000Z' },
      onlineEvidence(),
    ],
    [
      'an item-number mismatch',
      onlinePurchase,
      onlineEvidence({}, { itemNumber: '999999' }),
    ],
    [
      'an online scope mismatch',
      onlinePurchase,
      onlineEvidence({}, { warehouseNumber: '999' }),
    ],
    [
      'warehouse evidence',
      onlinePurchase,
      onlineEvidence({ channel: 'warehouse' }),
    ],
    [
      'Same-Day evidence',
      onlinePurchase,
      onlineEvidence({ channel: 'same_day' }),
    ],
    [
      'Costco.com evidence attached to a warehouse request',
      onlinePurchase,
      onlineEvidence({}, { purchaseChannel: 'warehouse' }),
    ],
  ])('rejects %s', (_, candidatePurchase, evidence) => {
    expect(
      findOnlineAdjustments([candidatePurchase], [evidence], now, {
        adjustmentWindowDays: 30,
        minimumSavingsCents: 600,
      }),
    ).toEqual([]);
  });

  it('rejects online purchases from the warehouse matcher and warehouse purchases from the online matcher', () => {
    expect(
      findAdjustments(
        [onlinePurchase],
        [{ ...observation, warehouseNumber: onlinePurchase.warehouseNumber }],
        now,
        config,
      ),
    ).toEqual([]);
    expect(
      findOnlineAdjustments(
        [purchase],
        [onlineEvidence({}, { warehouseNumber: purchase.warehouseNumber })],
        now,
        config,
      ),
    ).toEqual([]);
  });
});
