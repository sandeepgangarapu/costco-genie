export interface Purchase {
  readonly description?: string;
  readonly id: string;
  readonly receiptId: string;
  readonly itemNumber: string;
  readonly warehouseNumber: string;
  readonly purchasedAt: string;
  readonly grossUnitCents?: number;
  readonly paidUnitCents: number;
  readonly quantity: number;
  readonly couponCents: number;
}

export interface PriceObservation {
  readonly itemNumber: string;
  readonly warehouseNumber: string;
  readonly observedAt: string;
  readonly unitPriceCents: number | null;
  readonly source: string;
  readonly unresolvedReason: string | null;
}

export type PriceChannel =
  | 'warehouse'
  | 'receipt_history'
  | 'warehouse_savings'
  | 'costco_com'
  | 'same_day';

export interface ReportPriceObservation {
  readonly channel: PriceChannel;
  readonly unitPriceCents: number | null;
  readonly source: string | null;
  readonly observedAt: string | null;
  readonly unavailableReason: string | null;
  readonly promotionText: string | null;
}

export interface ReportPriceChannels {
  readonly warehouse: ReportPriceObservation;
  readonly receiptHistory: ReportPriceObservation;
  readonly warehouseSavings: ReportPriceObservation;
  readonly costcoCom: ReportPriceObservation;
  readonly sameDay: ReportPriceObservation;
}

export interface FullReportRow {
  readonly purchase: Purchase;
  readonly prices: ReportPriceChannels;
  readonly warehouseDeltaCents: number | null;
  readonly daysRemaining: number | null;
  readonly status: 'candidate' | 'not_eligible';
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
  readonly schemaVersion: 1;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly outcome: RunOutcome;
  readonly diagnostic: string | null;
  readonly rows: readonly FullReportRow[];
  readonly sourceDiagnostics: readonly ReportSourceDiagnostic[];
}

export interface FullReportFiles {
  readonly htmlFile: string;
  readonly csvFile: string;
  readonly jsonFile: string;
}

export interface AdjustmentCandidate {
  readonly purchase: Purchase;
  readonly observation: PriceObservation;
  readonly currentUnitCents: number;
  readonly savingsCents: number;
  readonly daysRemaining: number;
}

export interface RunSummary {
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly diagnostic?: string;
  readonly outcome: RunOutcome;
  readonly purchasesProcessed: number;
  readonly observationsRecorded: number;
  readonly candidatesFound: number;
  readonly alertsSent: number;
  readonly unresolvedPrices: number;
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
