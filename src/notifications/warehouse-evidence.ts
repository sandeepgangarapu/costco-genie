import type { WarehousePriceEvidence } from '../domain/types.js';
import { formatPromoEnd } from '../lib/dates.js';

export function warehouseSourceLabel(source: string): string {
  return (
    (
      {
        warehouse_display_price_api: 'Costco warehouse display price',
        warehouse_savings_page: 'Warehouse Savings final',
        'warehouse-price-api': 'Strict WH GraphQL',
      } as Record<string, string>
    )[source] ?? source
  );
}

export function warehouseEvidenceDetails(price: {
  readonly source: string | null;
  readonly warehouseEvidence?: WarehousePriceEvidence;
}): string[] {
  const e = price.warehouseEvidence;
  if (!e) return [];
  const money = (cents: number) => `$${(cents / 100).toFixed(2)}`;
  const amount = (label: string, cents: number | null | undefined) =>
    cents == null ? [] : [`${label}: ${money(cents)}`];
  return [
    ...(price.source ? [warehouseSourceLabel(price.source)] : []),
    `Warehouse ${e.warehouseNumber}`,
    ...amount('Base', e.baseCents),
    ...amount('API discount', e.discountCents),
    ...amount('API delivered final', e.deliveredCents),
    ...amount('Booklet final', e.bookletFinalCents),
    ...(e.unitReason || e.conflictReason
      ? amount('Quotation for review', e.quotationCents)
      : []),
    ...(e.promoEnd ? [`Promotion ends: ${formatPromoEnd(e.promoEnd)}`] : []),
    `Unit: ${e.unitBasis}`,
    ...(e.comparisonBasis === 'assumed_package'
      ? ['Comparison: assumed package price (unit not stated)']
      : []),
    ...(e.discountHandling ? [e.discountHandling] : []),
    ...(e.conflictReason ? [`Review: ${e.conflictReason}`] : []),
    ...(e.unitReason ? [`Unit reason: ${e.unitReason}`] : []),
  ];
}
