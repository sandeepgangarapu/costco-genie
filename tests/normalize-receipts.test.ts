import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { normalizeReceipts } from '../src/core/normalize-receipts.js';

const fixture = JSON.parse(
  readFileSync(
    fileURLToPath(new URL('./fixtures/receipt.json', import.meta.url)),
    'utf8',
  ),
) as unknown;

describe('normalizeReceipts', () => {
  it('normalizes valid purchase lines deterministically using integer cents', () => {
    const first = normalizeReceipts(
      fixture,
      new Date('2026-08-18T00:00:00.000Z'),
    );
    const second = normalizeReceipts(
      fixture,
      new Date('2026-08-18T00:00:00.000Z'),
    );

    expect(first).toEqual([
      {
        id: first[0]?.id,
        receiptId: 'receipt-2026-08-01-001',
        itemNumber: '100001',
        warehouseNumber: '123',
        purchasedAt: '2026-08-01T16:30:00.000Z',
        grossUnitCents: 1250,
        paidUnitCents: 1184,
        purchaseChannel: 'warehouse',
        quantity: 2,
        couponCents: 132,
      },
      {
        id: first[1]?.id,
        receiptId: 'receipt-2026-08-01-001',
        itemNumber: '100001',
        warehouseNumber: '123',
        purchasedAt: '2026-08-01T16:30:00.000Z',
        grossUnitCents: 1250,
        paidUnitCents: 1182,
        purchaseChannel: 'warehouse',
        quantity: 1,
        couponCents: 68,
      },
    ]);
    expect(first[0]?.id).toMatch(/^[a-f0-9]{64}$/);
    expect(second).toEqual(first);
  });

  it('defaults a missing quantity to one and applies its item coupon', () => {
    const purchases = normalizeReceipts(
      {
        transactions: [
          {
            receiptId: 'receipt-quantity-default',
            purchasedAt: '2026-08-03T00:00:00.000Z',
            warehouseNumber: '456',
            transactionType: 'purchase',
            items: [{ itemNumber: '200002', unitPrice: '3.33' }],
            coupons: [{ itemNumber: '200002', amount: '-0.33' }],
          },
        ],
      },
      new Date('2026-08-18T00:00:00.000Z'),
    );

    expect(purchases).toMatchObject([
      {
        itemNumber: '200002',
        quantity: 1,
        grossUnitCents: 333,
        couponCents: 33,
        paidUnitCents: 300,
      },
    ]);
  });

  it('rejects malformed lines and refund transactions without rejecting valid purchases', () => {
    expect(
      normalizeReceipts(fixture, new Date('2026-08-18T00:00:00.000Z')),
    ).toHaveLength(2);
  });
});
