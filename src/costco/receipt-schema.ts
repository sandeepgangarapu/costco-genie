import { z } from 'zod';

const receiptItemSchema = z.object({
  description: z.string().min(1).optional(),
  itemNumber: z.string(),
  quantity: z.number().int().positive().optional(),
  unitPrice: z.string(),
});

const receiptCouponSchema = z.object({
  amount: z.string(),
  itemNumber: z.string(),
});

export const receiptTransactionSchema = z.object({
  coupons: z.array(z.unknown()).default([]),
  items: z.array(z.unknown()),
  purchasedAt: z
    .string()
    .regex(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})?$/,
    ),
  receiptId: z.string().min(1),
  transactionType: z.string(),
  warehouseNumber: z.string(),
});

export const receiptPayloadSchema = z.object({
  transactions: z.array(receiptTransactionSchema),
});

export type ReceiptTransaction = z.infer<typeof receiptTransactionSchema>;
export type ReceiptPayload = z.infer<typeof receiptPayloadSchema>;
export type ReceiptItem = z.infer<typeof receiptItemSchema>;
export type ReceiptCoupon = z.infer<typeof receiptCouponSchema>;

export function parseReceiptItem(value: unknown): ReceiptItem | null {
  const parsed = receiptItemSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export function parseReceiptCoupon(value: unknown): ReceiptCoupon | null {
  const parsed = receiptCouponSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}
