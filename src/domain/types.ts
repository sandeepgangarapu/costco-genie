export type PurchaseChannel = 'warehouse' | 'costco_com';

export interface Purchase {
  readonly description?: string;
  readonly id: string;
  readonly receiptId: string;
  readonly itemNumber: string;
  readonly warehouseNumber: string;
  readonly purchasedAt: string;
  readonly grossUnitCents?: number;
  readonly paidUnitCents: number;
  readonly purchaseChannel: PurchaseChannel;
  readonly quantity: number;
  readonly couponCents: number;
}

export interface PriceObservation {
  readonly warehouseEvidence?: WarehousePriceEvidence;
  readonly itemNumber: string;
  readonly warehouseNumber: string;
  readonly observedAt: string;
  readonly unitPriceCents: number | null;
  readonly source: string;
  readonly unresolvedReason: string | null;
}

export type PriceChannel =
  | 'warehouse'
  | 'warehouse_display'
  | 'warehouse_graphql'
  | 'receipt_history'
  | 'warehouse_savings'
  | 'costco_com'
  | 'same_day';

export interface ReportPriceObservation {
  readonly warehouseEvidence?: WarehousePriceEvidence;
  readonly channel: PriceChannel;
  readonly unitPriceCents: number | null;
  readonly source: string | null;
  readonly observedAt: string | null;
  readonly unavailableReason: string | null;
  readonly promotionText: string | null;
}

export interface ReportPriceChannels {
  readonly warehouseDisplay?: ReportPriceObservation;
  readonly warehouseGraphql?: ReportPriceObservation;
  readonly warehouse: ReportPriceObservation;
  readonly receiptHistory: ReportPriceObservation;
  readonly warehouseSavings: ReportPriceObservation;
  readonly costcoCom: ReportPriceObservation;
  readonly sameDay: ReportPriceObservation;
}

export interface FullReportRow {
  readonly purchase: Purchase;
  readonly prices: ReportPriceChannels;
  readonly comparisonChannel: ComparisonChannel | null;
  readonly comparisonUnitCents: number | null;
  readonly comparisonDeltaCents: number | null;
  readonly potentialSavingsCents: number | null;
  readonly sameDayWarehouseEstimateCents: number | null;
  readonly sameDayMarkupPercent: number;
  readonly sameDayEstimatedDeltaCents: number | null;
  readonly warehouseDeltaCents: number | null;
  readonly daysRemaining: number | null;
  readonly status: 'candidate' | 'estimated_opportunity' | 'not_eligible';
  readonly reason: string | null;
}

export interface ReportSourceDiagnostic {
  readonly channel: PriceChannel | null;
  readonly source: string;
  readonly status: 'ok' | 'unavailable' | 'error';
  readonly observedAt: string;
  readonly message: string;
}

export type RunOutcome =
  'success' | 'partial_failure' | 'failure' | 'auth_required' | 'skipped';

export interface FullRunReport {
  readonly schemaVersion: 3;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly outcome: RunOutcome;
  readonly diagnostic: string | null;
  readonly rows: readonly FullReportRow[];
  readonly sourceDiagnostics: readonly ReportSourceDiagnostic[];
}

export type UnitBasis = 'each' | 'lb' | 'unknown';

export interface WarehousePromotion {
  readonly discountCents: number | null;
  readonly text: string | null;
  readonly start: string | null;
  readonly end: string | null;
}

/** Source amounts remain quotations even when unsafe for receipt comparison. */
export interface WarehousePriceEvidence {
  readonly warehouseNumber: string;
  readonly baseCents?: number | null;
  readonly discountCents?: number | null;
  readonly deliveredCents?: number | null;
  readonly quotationCents?: number | null;
  readonly currency?: string | null;
  readonly unitBasis: UnitBasis;
  readonly comparisonBasis?: 'package' | 'assumed_package';
  readonly variableWeight?: boolean;
  readonly promotions?: readonly WarehousePromotion[];
  readonly promoStart?: string | null;
  readonly promoEnd?: string | null;
  readonly scope?: 'warehouse' | 'online_only' | 'unknown';
  readonly bookletFinalCents?: number | null;
  readonly advertisedDiscountCents?: number | null;
  readonly bookletPromoStart?: string | null;
  readonly bookletPromoEnd?: string | null;
  readonly bookletUnitBasis?: UnitBasis;
  readonly bookletScope?: 'warehouse' | 'online_only' | 'unknown';
  readonly conflictReason?: string | null;
  readonly unitReason?: string | null;
  readonly discountHandling?: string | null;
}

export interface FullReportFiles {
  readonly htmlFile: string;
  readonly csvFile: string;
  readonly jsonFile: string;
}

export type ComparisonChannel = 'warehouse' | 'costco_com' | 'same_day';

export interface AdjustmentCandidate {
  readonly comparisonChannel: ComparisonChannel;
  readonly purchase: Purchase;
  readonly observation: PriceObservation;
  readonly currentUnitCents: number;
  readonly savingsCents: number;
  readonly daysRemaining: number;
  readonly estimated?: boolean;
}

export interface RunSummary {
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly diagnostic?: string;
  readonly outcome: RunOutcome;
  readonly purchasesProcessed: number;
  readonly warehousePurchasesProcessed?: number;
  readonly onlinePurchasesProcessed?: number;
  readonly observationsRecorded: number;
  readonly candidatesFound: number;
  readonly estimatedOpportunitiesFound?: number;
  readonly alertsSent: number;
  readonly unresolvedPrices: number;
  readonly warehouseUnresolvedPrices?: number;
  readonly onlineUnresolvedPrices?: number;
  readonly notifications?: NotificationResults;
  readonly reportFiles?: FullReportFiles;
}

export interface NotificationChannelResult {
  readonly attempted: boolean;
  readonly delivered: number;
  readonly error: string | null;
}

export interface NotificationResults {
  readonly email: NotificationChannelResult;
  readonly local: NotificationChannelResult;
}
