import type {
  PriceObservation,
  ReportPriceObservation,
  WarehousePriceEvidence,
} from '../domain/types.js';

function comparableWarehouseEvidence(
  evidence?: WarehousePriceEvidence,
): boolean {
  return (
    evidence === undefined ||
    (evidence.unitBasis === 'each' &&
      evidence.scope !== 'online_only' &&
      evidence.bookletScope !== 'online_only' &&
      !evidence.conflictReason &&
      !evidence.unitReason &&
      /^\d+$/u.test(evidence.warehouseNumber) &&
      !/^0*847$|^0+$/u.test(evidence.warehouseNumber))
  );
}

function currentWarehouseSource(source: string | null): boolean {
  return source !== null && !/same[_-]day|receipt[_-]history/iu.test(source);
}

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
    (expectedChannel !== 'warehouse' ||
      (currentWarehouseSource(price.source) &&
        (price.source !== 'warehouse_display_price_api' ||
          price.warehouseEvidence !== undefined) &&
        comparableWarehouseEvidence(price.warehouseEvidence))) &&
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
    currentWarehouseSource(price.source) &&
    (price.source !== 'warehouse_display_price_api' ||
      price.warehouseEvidence !== undefined) &&
    comparableWarehouseEvidence(price.warehouseEvidence) &&
    /^\d+$/u.test(price.warehouseNumber) &&
    !/^0*847$|^0+$/u.test(price.warehouseNumber) &&
    (price.warehouseEvidence === undefined ||
      price.warehouseEvidence.warehouseNumber === price.warehouseNumber) &&
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
