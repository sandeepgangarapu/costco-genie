import type {
  PriceObservation,
  ReportPriceObservation,
} from '../domain/types.js';

export type UsableReportPriceEvidence = ReportPriceObservation & {
  readonly observedAt: string;
  readonly source: string;
  readonly unitPriceCents: number;
};

export function isUsableReportPriceEvidence(
  price: ReportPriceObservation,
  expectedChannel: ReportPriceObservation['channel'],
): price is UsableReportPriceEvidence {
  return (
    price.channel === expectedChannel &&
    price.unavailableReason === null &&
    price.observedAt !== null &&
    Number.isFinite(Date.parse(price.observedAt)) &&
    price.source !== null &&
    price.source.trim().length > 0 &&
    price.unitPriceCents !== null &&
    Number.isSafeInteger(price.unitPriceCents) &&
    price.unitPriceCents > 0
  );
}

export function isUsableOnlinePriceEvidence(
  price: ReportPriceObservation,
): price is UsableReportPriceEvidence & { readonly channel: 'costco_com' } {
  return isUsableReportPriceEvidence(price, 'costco_com');
}

export function isUsableWarehousePriceObservation(
  price: PriceObservation,
): price is PriceObservation & { readonly unitPriceCents: number } {
  return (
    price.unresolvedReason === null &&
    Number.isFinite(Date.parse(price.observedAt)) &&
    price.source.trim().length > 0 &&
    price.unitPriceCents !== null &&
    Number.isSafeInteger(price.unitPriceCents) &&
    price.unitPriceCents > 0
  );
}

export function isCanonicalNotApplicableReportPrice(
  price: ReportPriceObservation,
  expectedChannel: ReportPriceObservation['channel'],
): boolean {
  return (
    price.channel === expectedChannel &&
    price.unitPriceCents === null &&
    price.unavailableReason === 'not_applicable' &&
    price.source === null &&
    price.observedAt === null &&
    price.promotionText === null
  );
}
