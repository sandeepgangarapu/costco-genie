import { createHash } from 'node:crypto';

import {
  parseReceiptCoupon,
  parseReceiptItem,
  receiptPayloadSchema,
} from '../costco/receipt-schema.js';
import type { Purchase } from '../domain/types.js';
import { parseMoneyToCents } from '../lib/money.js';

const NUMERIC_IDENTIFIER = /^\d+$/;

interface NormalizedLine {
  readonly description?: string;
  readonly itemNumber: string;
  readonly lineIndex: number;
  readonly quantity: number;
  readonly unitPriceCents: number;
}

function isPurchase(transactionType: string): boolean {
  return !/(refund|return)/i.test(transactionType);
}

function purchaseId(
  receiptId: string,
  warehouseNumber: string,
  itemNumber: string,
  lineIndex: number,
): string {
  return createHash('sha256')
    .update(
      `${receiptId}\u0000${warehouseNumber}\u0000${itemNumber}\u0000${lineIndex}`,
    )
    .digest('hex');
}

function allocateCouponCents(
  lines: readonly NormalizedLine[],
  totalCouponCents: number,
): Map<number, number> | null {
  const allocations = new Map<number, number>();
  let remainingCouponCents = totalCouponCents;
  let remainingQuantity = lines.reduce(
    (total, line) => total + line.quantity,
    0,
  );

  for (const [index, line] of lines.entries()) {
    const isLastLine = index === lines.length - 1;
    const couponCents = isLastLine
      ? remainingCouponCents
      : Math.floor((remainingCouponCents * line.quantity) / remainingQuantity) -
        (Math.floor(
          (remainingCouponCents * line.quantity) / remainingQuantity,
        ) %
          line.quantity);
    const grossCents = line.unitPriceCents * line.quantity;

    if (
      couponCents < 0 ||
      couponCents > grossCents ||
      couponCents % line.quantity !== 0
    ) {
      return null;
    }

    allocations.set(line.lineIndex, couponCents);
    remainingCouponCents -= couponCents;
    remainingQuantity -= line.quantity;
  }

  return remainingCouponCents === 0 ? allocations : null;
}

export function normalizeReceipts(rawReceipts: unknown, now: Date): Purchase[] {
  void now;

  const payload = receiptPayloadSchema.safeParse(rawReceipts);
  if (!payload.success) {
    return [];
  }

  return payload.data.transactions.flatMap((transaction) => {
    if (
      !isPurchase(transaction.transactionType) ||
      !NUMERIC_IDENTIFIER.test(transaction.warehouseNumber)
    ) {
      return [];
    }

    const couponCentsByItem = new Map<string, number>();
    for (const rawCoupon of transaction.coupons) {
      const coupon = parseReceiptCoupon(rawCoupon);
      if (!coupon || !NUMERIC_IDENTIFIER.test(coupon.itemNumber)) {
        continue;
      }

      const amountCents = parseMoneyToCents(coupon.amount);
      if (amountCents === null) {
        continue;
      }

      const next =
        (couponCentsByItem.get(coupon.itemNumber) ?? 0) + Math.abs(amountCents);
      if (Number.isSafeInteger(next)) {
        couponCentsByItem.set(coupon.itemNumber, next);
      }
    }

    const linesByItem = new Map<string, NormalizedLine[]>();
    for (const [lineIndex, rawItem] of transaction.items.entries()) {
      const item = parseReceiptItem(rawItem);
      const unitPriceCents = item ? parseMoneyToCents(item.unitPrice) : null;
      if (
        !item ||
        !NUMERIC_IDENTIFIER.test(item.itemNumber) ||
        unitPriceCents === null ||
        unitPriceCents < 0
      ) {
        continue;
      }

      const line: NormalizedLine = {
        ...(item.description === undefined
          ? {}
          : { description: item.description }),
        itemNumber: item.itemNumber,
        lineIndex,
        quantity: item.quantity ?? 1,
        unitPriceCents,
      };
      const lines = linesByItem.get(line.itemNumber) ?? [];
      lines.push(line);
      linesByItem.set(line.itemNumber, lines);
    }

    return [...linesByItem.values()].flatMap((lines) => {
      const allocations = allocateCouponCents(
        lines,
        couponCentsByItem.get(lines[0]?.itemNumber ?? '') ?? 0,
      );
      if (!allocations) {
        return [];
      }

      return lines.flatMap((line) => {
        const couponCents = allocations.get(line.lineIndex) ?? 0;
        const grossCents = line.unitPriceCents * line.quantity;
        const paidLineCents = grossCents - couponCents;
        if (!Number.isSafeInteger(grossCents) || paidLineCents < 0) {
          return [];
        }

        return [
          {
            couponCents,
            ...(line.description === undefined
              ? {}
              : { description: line.description }),
            id: purchaseId(
              transaction.receiptId,
              transaction.warehouseNumber,
              line.itemNumber,
              line.lineIndex,
            ),
            grossUnitCents: line.unitPriceCents,
            itemNumber: line.itemNumber,
            paidUnitCents: paidLineCents / line.quantity,
            purchaseChannel: 'warehouse',
            purchasedAt: transaction.purchasedAt,
            quantity: line.quantity,
            receiptId: transaction.receiptId,
            warehouseNumber: transaction.warehouseNumber,
          },
        ];
      });
    });
  });
}
