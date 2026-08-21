import { z } from 'zod';

import { parseMoneyToCents } from '../lib/money.js';
import type { CostcoTokens } from './browser-session.js';
import { AuthRequiredError, CostcoApiError } from './errors.js';
import { receiptPayloadSchema, type ReceiptPayload } from './receipt-schema.js';

const RECEIPT_ENDPOINT =
  'https://ecom-api.costco.com/ebusiness/order/v1/orders/graphql';
const CLIENT_IDENTIFIER = '481b1aec-aa3b-454b-b81b-48187e28f205';

const receiptResponseSchema = z.object({
  data: z.object({ receipts: z.array(z.unknown()) }),
  errors: z.array(z.unknown()).optional(),
});

const wireScalarSchema = z.union([z.string(), z.number()]);
const localOrOffsetTimestampSchema = z
  .string()
  .regex(
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})?$/,
  );

const liveReceiptSchema = z.object({
  couponArray: z.array(z.unknown()).default([]),
  itemArray: z.array(z.unknown()),
  registerNumber: wireScalarSchema,
  transactionBarcode: wireScalarSchema.nullish(),
  transactionDateTime: localOrOffsetTimestampSchema,
  transactionNumber: wireScalarSchema,
  transactionType: z.string().min(1),
  warehouseNumber: wireScalarSchema,
});

const liveItemSchema = z.object({
  amount: wireScalarSchema,
  itemDescription01: z.string().nullish(),
  itemNumber: wireScalarSchema,
  itemUnitPriceAmount: wireScalarSchema.nullish(),
  refundFlag: z.unknown().optional(),
  unit: wireScalarSchema,
  voidFlag: z.unknown().optional(),
});

const liveCouponSchema = z.object({
  amountCoupon: wireScalarSchema,
  associatedItemNumber: wireScalarSchema.nullish(),
  couponNumber: wireScalarSchema.nullish(),
  refundflagCoupon: z.unknown().optional(),
  unitCoupon: wireScalarSchema.nullish(),
  upcnumberCoupon: wireScalarSchema.nullish(),
  voidflagCoupon: z.unknown().optional(),
});

const RECEIPT_QUERY = `
  query receipts($startDate: String!, $endDate: String!) {
    receipts(startDate: $startDate, endDate: $endDate) {
      warehouseName
      documentType
      transactionDateTime
      transactionDate
      companyNumber
      warehouseNumber
      operatorNumber
      warehouseShortName
      registerNumber
      transactionNumber
      transactionType
      transactionBarcode
      total
      warehouseAddress1
      warehouseAddress2
      warehouseCity
      warehouseState
      warehouseCountry
      warehousePostalCode
      totalItemCount
      subTotal
      taxes
      itemArray {
        itemNumber
        itemDescription01
        frenchItemDescription1
        itemDescription02
        frenchItemDescription2
        itemIdentifier
        itemUnitPriceAmount
        unit
        amount
        taxFlag
        refundFlag
        resaleFlag
        voidFlag
        merchantID
        entryMethod
      }
      tenderArray {
        tenderTypeCode
        tenderDescription
        amountTender
        displayAccountNumber
        sequenceNumber
        approvalNumber
        responseCode
        transactionID
        merchantID
        entryMethod
      }
      couponArray {
        couponNumber
        upcnumberCoupon
        associatedItemNumber
        unitCoupon
        voidflagCoupon
        refundflagCoupon
        taxflagCoupon
        amountCoupon
      }
      subTaxes {
        tax1
        tax2
        tax3
        tax4
        aTaxPercent
        aTaxLegend
        aTaxAmount
        bTaxPercent
        bTaxLegend
        bTaxAmount
        cTaxPercent
        cTaxLegend
        cTaxAmount
        dTaxAmount
      }
      instantSavings
      membershipNumber
    }
  }
`
  .replace(/\s+/g, ' ')
  .trim();

function positiveQuantity(value: string | number): number | null {
  const quantity =
    typeof value === 'number'
      ? value
      : /^\d+$/.test(value)
        ? Number(value)
        : Number.NaN;
  return Number.isSafeInteger(quantity) && quantity > 0 ? quantity : null;
}

function formatCents(cents: number): string {
  const absoluteCents = Math.abs(cents);
  const sign = cents < 0 ? '-' : '';
  return `${sign}${Math.floor(absoluteCents / 100)}.${String(absoluteCents % 100).padStart(2, '0')}`;
}

function identifier(value: string | number | null | undefined): string | null {
  const text = String(value ?? '').trim();
  if (!/^\d+$/.test(text)) {
    return null;
  }
  return text;
}

function moneyCents(value: string | number): number | null {
  return parseMoneyToCents(String(value));
}

function hasWireFlag(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (value === 0) return false;
    if (value === 1) return true;
    return true;
  }
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (['', '0', 'false', 'f', 'n', 'no'].includes(normalized)) return false;
    if (['1', 'true', 't', 'y', 'yes'].includes(normalized)) return true;
  }
  // Unknown encodings are excluded conservatively instead of being coerced.
  return true;
}

function isPurchaseReceipt(transactionType: string): boolean {
  return !/(refund|return)/i.test(transactionType);
}

export function adaptCostcoReceipts(raw: unknown[]): ReceiptPayload {
  const transactions = raw.flatMap((rawReceipt) => {
    const receipt = liveReceiptSchema.safeParse(rawReceipt);
    if (!receipt.success || !isPurchaseReceipt(receipt.data.transactionType)) {
      return [];
    }

    const warehouseNumber = identifier(receipt.data.warehouseNumber);
    const registerNumber = identifier(receipt.data.registerNumber);
    const transactionNumber = identifier(receipt.data.transactionNumber);
    const transactionBarcode = identifier(receipt.data.transactionBarcode);
    if (!warehouseNumber || !registerNumber || !transactionNumber) {
      return [];
    }

    const items: Array<{
      description?: string;
      itemNumber: string;
      quantity: number;
      unitPrice: string;
    }> = [];
    const coupons: Array<{ amount: string; itemNumber: string }> = [];
    let immediatelyPreviousPurchase: (typeof items)[number] | null = null;

    for (const rawItem of receipt.data.itemArray) {
      const previousPurchase = immediatelyPreviousPurchase;
      immediatelyPreviousPurchase = null;
      const item = liveItemSchema.safeParse(rawItem);
      if (
        !item.success ||
        hasWireFlag(item.data.refundFlag) ||
        hasWireFlag(item.data.voidFlag)
      ) {
        continue;
      }

      const itemNumber = identifier(item.data.itemNumber);
      const lineCents = moneyCents(item.data.amount);
      const description = item.data.itemDescription01?.trim();
      const discountMatch = /\/\s*(\d+)\b/.exec(description ?? '');
      const textDiscountMatch = /^\/\s*\S/.exec(description ?? '');
      if (discountMatch) {
        if (lineCents !== null && lineCents < 0) {
          const referencedItemNumber = discountMatch[1];
          const target = [...items]
            .reverse()
            .find((candidate) => candidate.itemNumber === referencedItemNumber);
          if (target) {
            coupons.push({
              amount: formatCents(lineCents),
              itemNumber: target.itemNumber,
            });
          }
        }
        continue;
      }
      if (textDiscountMatch) {
        if (lineCents !== null && lineCents < 0 && previousPurchase) {
          coupons.push({
            amount: formatCents(lineCents),
            itemNumber: previousPurchase.itemNumber,
          });
        }
        continue;
      }
      if (description?.startsWith('/')) continue;

      const quantity = positiveQuantity(item.data.unit);
      const explicitUnitCents =
        item.data.itemUnitPriceAmount === null ||
        item.data.itemUnitPriceAmount === undefined
          ? null
          : moneyCents(item.data.itemUnitPriceAmount);
      const unitCents =
        explicitUnitCents !== null && explicitUnitCents > 0
          ? explicitUnitCents
          : lineCents !== null && lineCents % (quantity ?? 1) === 0
            ? lineCents / (quantity ?? 1)
            : null;
      if (
        !itemNumber ||
        quantity === null ||
        lineCents === null ||
        lineCents < 0 ||
        unitCents === null
      ) {
        continue;
      }

      const purchase = {
        ...(description ? { description } : {}),
        itemNumber,
        quantity,
        unitPrice: formatCents(unitCents),
      };
      items.push(purchase);
      immediatelyPreviousPurchase = purchase;
    }

    for (const rawCoupon of receipt.data.couponArray) {
      const coupon = liveCouponSchema.safeParse(rawCoupon);
      if (
        !coupon.success ||
        hasWireFlag(coupon.data.refundflagCoupon) ||
        hasWireFlag(coupon.data.voidflagCoupon)
      ) {
        continue;
      }

      const associatedItemNumber = identifier(coupon.data.associatedItemNumber);
      const couponCents = moneyCents(coupon.data.amountCoupon);
      if (
        !associatedItemNumber ||
        associatedItemNumber === '0' ||
        couponCents === null ||
        !items.some((item) => item.itemNumber === associatedItemNumber)
      ) {
        continue;
      }
      coupons.push({
        amount: formatCents(couponCents),
        itemNumber: associatedItemNumber,
      });
    }

    const receiptId =
      transactionBarcode ??
      `${warehouseNumber}:${registerNumber}:${transactionNumber}:${receipt.data.transactionDateTime}`;

    return [
      {
        coupons,
        items,
        purchasedAt: receipt.data.transactionDateTime,
        receiptId,
        transactionType: receipt.data.transactionType,
        warehouseNumber,
      },
    ];
  });

  return receiptPayloadSchema.parse({ transactions });
}

export async function fetchReceipts(
  tokens: CostcoTokens,
  startDate: string,
  endDate: string,
  fetchFn: typeof fetch = fetch,
  signal?: AbortSignal,
): Promise<unknown[]> {
  let response: Response;
  try {
    response = await fetchFn(RECEIPT_ENDPOINT, {
      body: JSON.stringify({
        query: RECEIPT_QUERY,
        variables: { endDate, startDate },
      }),
      headers: {
        'Client-Identifier': CLIENT_IDENTIFIER,
        'Content-Type': 'application/json-patch+json',
        'Costco.Env': 'ecom',
        'Costco.Service': 'restOrders',
        'Costco-X-Authorization': `Bearer ${tokens.idToken}`,
        'Costco-X-Wcs-Clientid': tokens.clientId,
      },
      method: 'POST',
      signal,
    });
  } catch (error) {
    if (isTimeoutError(error)) {
      throw new CostcoApiError('Costco receipt request timed out', {
        cause: error,
      });
    }
    throw new CostcoApiError('Costco receipt request failed', { cause: error });
  }

  if (response.status === 401 || response.status === 403) {
    throw new AuthRequiredError();
  }

  if (!response.ok) {
    throw new CostcoApiError(
      `Costco receipt request failed with HTTP ${response.status}`,
    );
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch (error) {
    throw new CostcoApiError('Costco receipt response was not valid JSON', {
      cause: error,
    });
  }

  if (hasAuthenticationError(payload)) {
    throw new AuthRequiredError();
  }

  const parsed = receiptResponseSchema.safeParse(payload);
  if (!parsed.success || (parsed.data.errors?.length ?? 0) > 0) {
    throw new CostcoApiError(
      'Costco receipt response was malformed or errored',
    );
  }

  return parsed.data.data.receipts;
}

function isTimeoutError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === 'AbortError' || error.name === 'TimeoutError')
  );
}

function hasAuthenticationError(payload: unknown): boolean {
  if (
    typeof payload !== 'object' ||
    payload === null ||
    !('errors' in payload) ||
    !Array.isArray(payload.errors)
  ) {
    return false;
  }
  return payload.errors.some((error) =>
    /auth|unauthori[sz]ed|forbidden|token|session|jwt/i.test(safeJson(error)),
  );
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? '';
  } catch {
    return '';
  }
}
