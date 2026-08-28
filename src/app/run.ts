import type { AppConfig } from '../config/config.js';
import { selectAlerts, type AlertSelection } from '../core/alert-policy.js';
import {
  findAdjustments,
  findOnlineAdjustments,
  isUsableOnlinePrice,
} from '../core/matcher.js';
import { normalizeReceipts } from '../core/normalize-receipts.js';
import { buildReportRows } from '../core/report-rows.js';
import type { CostcoTokens } from '../costco/browser-session.js';
import { AuthRequiredError } from '../costco/errors.js';
import type {
  PriceRequest,
  WarehousePriceOptions,
  WarehousePriceRequest,
  ReportPriceEvidenceResult,
} from '../costco/price-client.js';
import { inverseMarkupCents } from '../costco/same-day-client.js';
import { adaptCostcoReceipts } from '../costco/receipt-client.js';
import type { OnlineOrderFetchResult } from '../costco/online-order-client.js';
import type {
  NotificationChannelResult,
  NotificationResults,
  FullRunReport,
  PriceObservation,
  Purchase,
  PurchaseChannel,
  ReportPriceChannels,
  ReportPriceObservation,
  ReportSourceDiagnostic,
  RunSummary,
} from '../domain/types.js';
import { sanitizeDiagnosticText } from '../lib/diagnostics.js';
import {
  renderCompactReport,
  renderTextReport,
} from '../notifications/report.js';
import type { FullReportFiles } from '../notifications/full-report.js';
import type { AlertChannel, Database } from '../storage/database.js';

const HOUR_MILLISECONDS = 60 * 60 * 1000;
const ALERT_TITLE = 'Potential Costco price adjustments';
const AUTH_TITLE = 'Costco sign-in required';
// Conservative internal deadline for unofficial HTTP calls held under the lock.
const EXTERNAL_REQUEST_TIMEOUT_MILLISECONDS = 30_000;

export interface RunLock {
  runExclusive<T>(action: () => Promise<T>): Promise<T>;
}

export interface LocalNotifier {
  send(title: string, body: string): Promise<void>;
}

export interface MailNotifier {
  resolveSelfRecipient(): Promise<string>;
  send(recipient: string, subject: string, text: string): Promise<void>;
}

type RunDatabase = Pick<
  Database,
  | 'beginRun'
  | 'finishRun'
  | 'getChannelAlertState'
  | 'getLastSuccessfulRun'
  | 'recordPriceObservations'
  | 'recentPurchases'
  | 'saveChannelAlertState'
  | 'upsertPurchases'
>;

export interface RunDependencies {
  readonly config: AppConfig;
  readonly database: RunDatabase;
  readonly fetchReceipts: (
    tokens: CostcoTokens,
    startDate: string,
    endDate: string,
    signal?: AbortSignal,
  ) => Promise<unknown[]>;
  readonly fetchOnlineOrderPurchases: (
    tokens: CostcoTokens,
    startDate: string,
    endDate: string,
  ) => Promise<OnlineOrderFetchResult>;
  readonly fetchWarehousePrices: (
    requests: readonly WarehousePriceRequest[],
    options: WarehousePriceOptions,
  ) => Promise<PriceObservation[]>;
  readonly fetchReportPriceEvidence?: (
    requests: readonly PriceRequest[],
    options: WarehousePriceOptions,
  ) => Promise<ReportPriceEvidenceResult>;
  readonly localNotifier: LocalNotifier;
  readonly lock: RunLock;
  readonly mailNotifier: MailNotifier;
  readonly readCostcoTokens: () => Promise<CostcoTokens>;
  readonly createTimeoutSignal?: (timeoutMilliseconds: number) => AbortSignal;
  readonly writeFullReport: (report: FullRunReport) => Promise<FullReportFiles>;
}

export type LockedRunDependencies = Omit<RunDependencies, 'lock'>;

export interface RunOptions {
  readonly now?: () => Date;
  readonly scheduled?: boolean;
}

export function runPriceCheck(
  dependencies: RunDependencies,
  options: RunOptions = {},
): Promise<RunSummary> {
  return dependencies.lock.runExclusive(() =>
    runPriceCheckLocked(dependencies, options),
  );
}

export function runPriceCheckLocked(
  dependencies: LockedRunDependencies,
  options: RunOptions = {},
): Promise<RunSummary> {
  return runLocked(dependencies, options, options.now ?? (() => new Date()));
}

async function runLocked(
  dependencies: LockedRunDependencies,
  options: RunOptions,
  now: () => Date,
): Promise<RunSummary> {
  const started = now();
  const startedAt = started.toISOString();
  if (
    options.scheduled === true &&
    isFresh(
      dependencies.database.getLastSuccessfulRun(),
      started,
      scheduledFreshnessMilliseconds(dependencies.config.scheduledIntervalDays),
    )
  ) {
    const skipped = emptySummary(
      startedAt,
      now().toISOString(),
      'skipped',
      emptyNotificationResults(),
    );
    const skippedRunId = dependencies.database.beginRun(startedAt);
    const withReport = await writeTerminalReport(
      dependencies,
      skipped,
      [],
      [
        sourceDiagnostic(
          null,
          'scheduler',
          'unavailable',
          skipped.finishedAt,
          'Scheduled run skipped because a recent successful run is fresh.',
        ),
      ],
    );
    dependencies.database.finishRun(skippedRunId, withReport);
    return withReport;
  }

  const runId = dependencies.database.beginRun(startedAt);
  return executeBegunRun(dependencies, runId, started, startedAt, now);
}

async function executeBegunRun(
  dependencies: LockedRunDependencies,
  runId: number,
  started: Date,
  startedAt: string,
  now: () => Date,
): Promise<RunSummary> {
  let terminalState: 'idle' | 'in_progress' | 'complete' = 'idle';
  const finish = async (
    summary: RunSummary,
    rows: FullRunReport['rows'] = [],
    sourceDiagnostics: readonly ReportSourceDiagnostic[] = [],
    afterFinish?: () => void,
  ): Promise<RunSummary> => {
    terminalState = 'in_progress';
    const withReport = await writeTerminalReport(
      dependencies,
      summary,
      rows,
      sourceDiagnostics,
    );
    dependencies.database.finishRun(runId, withReport);
    terminalState = 'complete';
    afterFinish?.();
    return withReport;
  };

  try {
    let tokens: CostcoTokens;
    try {
      tokens = await dependencies.readCostcoTokens();
    } catch (error) {
      if (!(error instanceof AuthRequiredError)) throw error;
      const summary = await authRequiredSummary(
        dependencies.localNotifier,
        startedAt,
        now,
      );
      return finish(
        summary,
        [],
        [
          sourceDiagnostic(
            null,
            'costco_orders',
            'error',
            summary.finishedAt,
            'Authentication required before Orders can be read.',
          ),
        ],
      );
    }

    const fetchStartDate = dateDaysBefore(
      started,
      dependencies.config.daysToFetch,
    );
    const fetchEndDate = datePart(started);
    const receiptImport = (async (): Promise<Purchase[]> => {
      const rawReceipts = await dependencies.fetchReceipts(
        tokens,
        fetchStartDate,
        fetchEndDate,
        timeoutSignal(dependencies),
      );
      return normalizeReceipts(adaptCostcoReceipts(rawReceipts), started);
    })();
    const onlineImport = (async (): Promise<OnlineOrderFetchResult> =>
      dependencies.fetchOnlineOrderPurchases(
        tokens,
        fetchStartDate,
        fetchEndDate,
      ))();
    const [receiptResult, onlineResult] = await Promise.allSettled([
      receiptImport,
      onlineImport,
    ]);
    const importedPurchases: Purchase[] = [];
    const successfulPurchaseChannels = new Set<PurchaseChannel>();
    const purchaseSourceDiagnostics: ReportSourceDiagnostic[] = [];
    let purchaseSourceFailure = false;
    let authImplicated = false;

    if (receiptResult.status === 'fulfilled') {
      successfulPurchaseChannels.add('warehouse');
      importedPurchases.push(...receiptResult.value);
    } else {
      purchaseSourceFailure = true;
      authImplicated ||= receiptResult.reason instanceof AuthRequiredError;
      purchaseSourceDiagnostics.push(
        sourceDiagnostic(
          null,
          'costco_receipts',
          'error',
          now().toISOString(),
          receiptResult.reason instanceof AuthRequiredError
            ? 'Receipt authorization expired.'
            : failureDiagnostic(
                'Receipt retrieval failed',
                receiptResult.reason,
              ),
        ),
      );
    }

    if (onlineResult.status === 'fulfilled') {
      successfulPurchaseChannels.add('costco_com');
      importedPurchases.push(...onlineResult.value.purchases);
      const onlineDiagnostic = sanitizeSourceDiagnostic(
        onlineResult.value.diagnostic,
        onlineResult.value.failedDetailBatches > 0 ? 'error' : undefined,
      );
      purchaseSourceDiagnostics.push(onlineDiagnostic);
      purchaseSourceFailure ||=
        onlineResult.value.failedDetailBatches > 0 ||
        onlineDiagnostic.status === 'error';
    } else {
      purchaseSourceFailure = true;
      authImplicated ||= onlineResult.reason instanceof AuthRequiredError;
      purchaseSourceDiagnostics.push(
        sourceDiagnostic(
          null,
          'costco_online_orders',
          'error',
          now().toISOString(),
          onlineResult.reason instanceof AuthRequiredError
            ? 'Costco.com order authorization expired.'
            : failureDiagnostic(
                'Costco.com order retrieval failed',
                onlineResult.reason,
              ),
        ),
      );
    }

    if (successfulPurchaseChannels.size === 0) {
      const diagnostic = purchaseSourceDiagnostics
        .map(({ message }) => message)
        .join(' ');
      if (authImplicated) {
        const authSummary = await authRequiredSummary(
          dependencies.localNotifier,
          startedAt,
          now,
        );
        return finish(
          { ...authSummary, ...(diagnostic ? { diagnostic } : {}) },
          [],
          purchaseSourceDiagnostics,
        );
      }
      const summary = emptySummary(
        startedAt,
        now().toISOString(),
        'failure',
        emptyNotificationResults(),
        diagnostic || 'Purchase retrieval failed.',
      );
      return finish(summary, [], purchaseSourceDiagnostics);
    }

    if (successfulPurchaseChannels.size < 2) purchaseSourceFailure = true;
    dependencies.database.upsertPurchases(importedPurchases);
    const recentPurchases = dependencies.database
      .recentPurchases(
        `${dateDaysBefore(started, dependencies.config.adjustmentWindowDays)}T00:00:00.000Z`,
      )
      .filter((purchase) =>
        successfulPurchaseChannels.has(purchase.purchaseChannel),
      );
    const requests = uniquePriceRequests(recentPurchases);
    const warehousePurchases = recentPurchases.filter(
      (purchase) => purchase.purchaseChannel === 'warehouse',
    );
    const onlinePurchases = recentPurchases.filter(
      (purchase) => purchase.purchaseChannel === 'costco_com',
    );

    let observations: PriceObservation[];
    let priceEvidence: ReportPriceEvidenceResult;
    try {
      const priceOptions = {
        batchSize: dependencies.config.priceBatchSize,
        createTimeoutSignal:
          dependencies.createTimeoutSignal ?? defaultTimeoutSignal,
        now: () => started,
        sameDayMarkupPercent: dependencies.config.sameDayMarkupPercent,
        sameDayPostalCode: dependencies.config.sameDayPostalCode,
        sameDayRepresentativeAddress:
          dependencies.config.sameDayRepresentativeAddress,
        timeoutMilliseconds: EXTERNAL_REQUEST_TIMEOUT_MILLISECONDS,
      };
      if (dependencies.fetchReportPriceEvidence) {
        const fetchedEvidence = await dependencies.fetchReportPriceEvidence(
          requests,
          priceOptions,
        );
        priceEvidence = {
          ...fetchedEvidence,
          diagnostics: fetchedEvidence.diagnostics.map((diagnostic) =>
            sanitizeSourceDiagnostic(diagnostic),
          ),
        };
        observations = priceEvidence.items
          .filter((item) => item.purchaseChannel === 'warehouse')
          .map((item) => toWarehouseObservation(item, startedAt));
      } else {
        const warehouseRequests = requests.filter(
          (request) => request.purchaseChannel === 'warehouse',
        );
        observations = await dependencies.fetchWarehousePrices(
          warehouseRequests,
          priceOptions,
        );
        priceEvidence = fallbackPriceEvidence(observations, startedAt);
      }
    } catch (error) {
      const summary: RunSummary = {
        ...emptySummary(
          startedAt,
          now().toISOString(),
          'failure',
          emptyNotificationResults(),
          failureDiagnostic('Price check failed', error),
        ),
        purchasesProcessed: recentPurchases.length,
        warehousePurchasesProcessed: warehousePurchases.length,
        onlinePurchasesProcessed: onlinePurchases.length,
      };
      return finish(
        summary,
        [],
        [
          ...purchaseSourceDiagnostics,
          sourceDiagnostic(
            null,
            'price_sources',
            'error',
            summary.finishedAt,
            summary.diagnostic ?? 'Price check failed.',
          ),
        ],
      );
    }

    dependencies.database.recordPriceObservations(observations);
    const warehouseCandidates = findAdjustments(
      warehousePurchases,
      observations,
      started,
      dependencies.config,
    );
    const onlineCandidates = findOnlineAdjustments(
      onlinePurchases,
      priceEvidence.items,
      started,
      dependencies.config,
    );
    const verifiedCandidates = [...warehouseCandidates, ...onlineCandidates];
    const reportRows = fullReportRows(
      recentPurchases,
      observations,
      priceEvidence,
      started,
      dependencies.config,
      new Set(onlineCandidates.map(({ purchase }) => purchase.id)),
    );
    const estimatedOpportunities = estimatedCandidates(reportRows);
    const alertCandidates = [...verifiedCandidates, ...estimatedOpportunities];
    const localSelections = selectionsForChannel(
      dependencies.database,
      'local',
      alertCandidates,
    );
    const emailSelections = selectionsForChannel(
      dependencies.database,
      'email',
      alertCandidates,
    );
    const deliveredPurchaseIds = new Set<string>();
    const local = await deliverLocal(
      dependencies,
      localSelections,
      deliveredPurchaseIds,
    );
    const email = await deliverEmail(
      dependencies,
      emailSelections,
      deliveredPurchaseIds,
    );
    const warehouseUnresolvedPrices = observations.filter(
      (observation) => observation.unresolvedReason !== null,
    ).length;
    const onlineUnresolvedPrices = onlineUnresolvedPriceCount(
      requests,
      priceEvidence,
    );
    const unresolvedPrices = warehouseUnresolvedPrices + onlineUnresolvedPrices;
    const hasBatchFailure =
      observations.some(
        (observation) => observation.unresolvedReason === 'batch_failed',
      ) ||
      priceEvidence.items.some(
        (item) =>
          item.purchaseChannel === 'costco_com' &&
          item.prices.costcoCom.unavailableReason === 'batch_failed',
      );
    const hasSourceFailure = priceEvidence.diagnostics.some(
      (diagnostic) => diagnostic.status === 'error',
    );
    const notifications = { email, local };
    const outcome =
      purchaseSourceFailure ||
      hasBatchFailure ||
      hasSourceFailure ||
      local.error !== null ||
      email.error !== null
        ? 'partial_failure'
        : 'success';
    const diagnostics = [
      ...purchaseSourceDiagnostics
        .filter(({ status }) => status === 'error')
        .map(({ message }) => message),
      ...(hasBatchFailure
        ? ['One or more price batches failed or timed out.']
        : []),
      ...(hasSourceFailure
        ? ['One or more comparison price sources failed.']
        : []),
      ...(local.error === null
        ? []
        : [`Local notification failed: ${local.error}`]),
      ...(email.error === null
        ? []
        : [`Email delivery failed: ${email.error}`]),
    ];
    const summary: RunSummary = {
      alertsSent: deliveredPurchaseIds.size,
      candidatesFound: verifiedCandidates.length,
      ...(estimatedOpportunities.length === 0
        ? {}
        : { estimatedOpportunitiesFound: estimatedOpportunities.length }),
      finishedAt: now().toISOString(),
      notifications,
      observationsRecorded: observations.length,
      outcome,
      onlinePurchasesProcessed: onlinePurchases.length,
      onlineUnresolvedPrices,
      purchasesProcessed: recentPurchases.length,
      startedAt,
      unresolvedPrices,
      warehousePurchasesProcessed: warehousePurchases.length,
      warehouseUnresolvedPrices,
      ...(diagnostics.length === 0
        ? {}
        : { diagnostic: diagnostics.join(' ') }),
    };
    return finish(
      summary,
      reportRows,
      [...purchaseSourceDiagnostics, ...priceEvidence.diagnostics],
      () => {
        if (local.error === null) {
          persistSelections(dependencies.database, 'local', localSelections);
        }
        if (email.error === null) {
          persistSelections(dependencies.database, 'email', emailSelections);
        }
      },
    );
  } catch (error) {
    if (terminalState === 'idle') {
      const summary = emptySummary(
        startedAt,
        now().toISOString(),
        'failure',
        emptyNotificationResults(),
        failureDiagnostic('Run failed', error),
      );
      return finish(
        summary,
        [],
        [
          sourceDiagnostic(
            null,
            'run',
            'error',
            summary.finishedAt,
            summary.diagnostic ?? 'Run failed.',
          ),
        ],
      );
    }
    throw error;
  }
}

async function writeTerminalReport(
  dependencies: LockedRunDependencies,
  summary: RunSummary,
  rows: FullRunReport['rows'],
  sourceDiagnostics: readonly ReportSourceDiagnostic[],
): Promise<RunSummary> {
  const reportFiles = await dependencies.writeFullReport({
    schemaVersion: 1,
    startedAt: summary.startedAt,
    finishedAt: summary.finishedAt,
    outcome: summary.outcome,
    diagnostic: summary.diagnostic ?? null,
    rows,
    sourceDiagnostics,
  });
  return { ...summary, reportFiles };
}

function fullReportRows(
  purchases: readonly Purchase[],
  observations: readonly PriceObservation[],
  evidence: ReportPriceEvidenceResult,
  now: Date,
  config: AppConfig,
  onlineCandidatePurchaseIds: ReadonlySet<string>,
): FullRunReport['rows'] {
  const evidenceByKey = new Map(
    evidence.items.map((item) => [priceKey(item), item.prices]),
  );
  return buildReportRows(purchases, observations, now, config).map((row) => {
    const currentEvidence = evidenceByKey.get(priceKey(row.purchase));
    const isOnline = row.purchase.purchaseChannel === 'costco_com';
    const prices: ReportPriceChannels = {
      warehouse:
        currentEvidence?.warehouse ??
        reportWarehouseObservation(row.warehousePrice),
      receiptHistory: isOnline
        ? unavailableReportPrice('receipt_history', 'not_applicable')
        : laterReceiptEvidence(row.purchase, purchases),
      warehouseSavings:
        currentEvidence?.warehouseSavings ??
        unavailableReportPrice('warehouse_savings', 'source_not_configured'),
      costcoCom:
        currentEvidence?.costcoCom ??
        unavailableReportPrice('costco_com', 'source_not_configured'),
      sameDay:
        currentEvidence?.sameDay ??
        unavailableReportPrice('same_day', 'source_not_configured'),
    };
    const sameDayWarehouseEstimateCents = usableReportPrice(prices.sameDay)
      ? inverseMarkupCents(
          prices.sameDay.unitPriceCents,
          config.sameDayMarkupPercent,
        )
      : null;
    const sameDayEstimatedDeltaCents =
      sameDayWarehouseEstimateCents === null
        ? null
        : row.purchase.paidUnitCents - sameDayWarehouseEstimateCents;
    const estimatedOpportunity =
      !isOnline &&
      row.status !== 'candidate' &&
      !usableReportPrice(prices.warehouse) &&
      row.daysRemaining !== null &&
      ![
        'invalid_config',
        'invalid_purchase_timestamp',
        'invalid_purchase_price',
        'outside_adjustment_window',
      ].includes(row.reason ?? '') &&
      sameDayEstimatedDeltaCents !== null &&
      sameDayEstimatedDeltaCents > 0 &&
      sameDayEstimatedDeltaCents * row.purchase.quantity >=
        config.minimumSavingsCents;
    const onlineStatus = isOnline
      ? onlineReportStatus(row, prices.costcoCom, onlineCandidatePurchaseIds)
      : null;
    return {
      purchase: row.purchase,
      prices,
      sameDayWarehouseEstimateCents: isOnline
        ? null
        : sameDayWarehouseEstimateCents,
      sameDayMarkupPercent: config.sameDayMarkupPercent,
      sameDayEstimatedDeltaCents: isOnline ? null : sameDayEstimatedDeltaCents,
      warehouseDeltaCents: isOnline ? null : row.warehouseDeltaCents,
      daysRemaining: row.daysRemaining,
      status:
        onlineStatus === null
          ? estimatedOpportunity
            ? 'estimated_opportunity'
            : row.status
          : onlineStatus.status,
      reason:
        onlineStatus === null
          ? estimatedOpportunity
            ? 'same_day_estimate_lower_manual_verification_required'
            : row.reason
          : onlineStatus.reason,
    };
  });
}

function onlineReportStatus(
  row: ReturnType<typeof buildReportRows>[number],
  price: ReportPriceObservation,
  candidatePurchaseIds: ReadonlySet<string>,
): Pick<FullRunReport['rows'][number], 'reason' | 'status'> {
  if (
    [
      'invalid_config',
      'invalid_purchase_timestamp',
      'invalid_purchase_price',
      'outside_adjustment_window',
    ].includes(row.reason ?? '')
  ) {
    return { reason: row.reason, status: 'not_eligible' };
  }
  if (candidatePurchaseIds.has(row.purchase.id)) {
    return { reason: null, status: 'candidate' };
  }
  if (!isUsableOnlinePrice(price)) {
    return { reason: 'costco_com_price_unavailable', status: 'not_eligible' };
  }
  return {
    reason:
      price.unitPriceCents >= row.purchase.paidUnitCents
        ? 'no_price_drop'
        : 'below_savings_threshold',
    status: 'not_eligible',
  };
}

function usableReportPrice(
  price: ReportPriceObservation,
): price is ReportPriceObservation & { readonly unitPriceCents: number } {
  return (
    price.unitPriceCents !== null &&
    price.unitPriceCents > 0 &&
    price.unavailableReason === null
  );
}

function estimatedCandidates(
  rows: FullRunReport['rows'],
): import('../domain/types.js').AdjustmentCandidate[] {
  return rows.flatMap((row) => {
    if (
      row.purchase.purchaseChannel !== 'warehouse' ||
      row.status !== 'estimated_opportunity' ||
      row.sameDayWarehouseEstimateCents === null ||
      row.sameDayEstimatedDeltaCents === null ||
      row.daysRemaining === null
    ) {
      return [];
    }
    return [
      {
        comparisonChannel: 'same_day',
        currentUnitCents: row.sameDayWarehouseEstimateCents,
        daysRemaining: row.daysRemaining,
        estimated: true,
        observation: {
          itemNumber: row.purchase.itemNumber,
          warehouseNumber: row.purchase.warehouseNumber,
          observedAt: row.prices.sameDay.observedAt ?? row.purchase.purchasedAt,
          source: row.prices.sameDay.source ?? 'costco_same_day_estimate',
          unitPriceCents: row.sameDayWarehouseEstimateCents,
          unresolvedReason: null,
        },
        purchase: {
          ...row.purchase,
          id: `${row.purchase.id}:same_day_estimate`,
        },
        savingsCents: row.sameDayEstimatedDeltaCents * row.purchase.quantity,
      },
    ];
  });
}

function laterReceiptEvidence(
  purchase: Purchase,
  purchases: readonly Purchase[],
): ReportPriceObservation {
  const purchasedAt = Date.parse(purchase.purchasedAt);
  const later = purchases
    .filter(
      (candidate) =>
        candidate.purchaseChannel === 'warehouse' &&
        candidate.itemNumber === purchase.itemNumber &&
        candidate.warehouseNumber === purchase.warehouseNumber &&
        Date.parse(candidate.purchasedAt) > purchasedAt,
    )
    .sort(
      (left, right) =>
        Date.parse(right.purchasedAt) - Date.parse(left.purchasedAt),
    )[0];
  return later
    ? {
        channel: 'receipt_history',
        observedAt: later.purchasedAt,
        promotionText: null,
        source: 'receipt_history',
        unavailableReason: null,
        unitPriceCents: later.paidUnitCents,
      }
    : unavailableReportPrice('receipt_history', 'no_later_receipt');
}

function fallbackPriceEvidence(
  observations: readonly PriceObservation[],
  observedAt: string,
): ReportPriceEvidenceResult {
  return {
    items: observations.map((observation) => ({
      itemNumber: observation.itemNumber,
      purchaseChannel: 'warehouse',
      warehouseNumber: observation.warehouseNumber,
      prices: {
        warehouse: reportWarehouseObservation(observation),
        warehouseSavings: unavailableReportPrice(
          'warehouse_savings',
          'source_not_configured',
        ),
        costcoCom: unavailableReportPrice(
          'costco_com',
          'source_not_configured',
        ),
        sameDay: unavailableReportPrice('same_day', 'source_not_configured'),
      },
    })),
    diagnostics: [
      sourceDiagnostic(
        'warehouse',
        'warehouse-price-api',
        observations.some(
          (observation) => observation.unresolvedReason === 'batch_failed',
        )
          ? 'error'
          : 'ok',
        observedAt,
        'Warehouse price lookup completed.',
      ),
    ],
  };
}

function toWarehouseObservation(
  item: ReportPriceEvidenceResult['items'][number],
  fallbackObservedAt: string,
): PriceObservation {
  const price = item.prices.warehouse;
  return {
    itemNumber: item.itemNumber,
    warehouseNumber: item.warehouseNumber,
    observedAt: price.observedAt ?? fallbackObservedAt,
    source: price.source ?? 'price_sources',
    unitPriceCents: price.unitPriceCents,
    unresolvedReason: price.unavailableReason,
  };
}

function reportWarehouseObservation(
  observation: PriceObservation | null,
): ReportPriceObservation {
  if (!observation) {
    return unavailableReportPrice('warehouse', 'warehouse_price_missing');
  }
  return {
    channel: 'warehouse',
    observedAt: observation.observedAt,
    promotionText: null,
    source: observation.source,
    unavailableReason: observation.unresolvedReason,
    unitPriceCents: observation.unitPriceCents,
  };
}

function unavailableReportPrice(
  channel: ReportPriceObservation['channel'],
  unavailableReason: string,
): ReportPriceObservation {
  return {
    channel,
    observedAt: null,
    promotionText: null,
    source: null,
    unavailableReason,
    unitPriceCents: null,
  };
}

function sourceDiagnostic(
  channel: ReportSourceDiagnostic['channel'],
  source: string,
  status: ReportSourceDiagnostic['status'],
  observedAt: string,
  message: string,
): ReportSourceDiagnostic {
  return { channel, message, observedAt, source, status };
}

function sanitizeSourceDiagnostic(
  diagnostic: ReportSourceDiagnostic,
  status?: ReportSourceDiagnostic['status'],
): ReportSourceDiagnostic {
  return {
    ...diagnostic,
    message: sanitizeDiagnosticText(diagnostic.message),
    ...(status === undefined ? {} : { status }),
  };
}

function priceKey(value: {
  readonly itemNumber: string;
  readonly purchaseChannel: PurchaseChannel;
  readonly warehouseNumber: string;
}): string {
  return `${value.purchaseChannel}\u0000${value.itemNumber}\u0000${value.warehouseNumber}`;
}

function onlineUnresolvedPriceCount(
  requests: readonly PriceRequest[],
  evidence: ReportPriceEvidenceResult,
): number {
  const evidenceByKey = new Map(
    evidence.items.map((item) => [priceKey(item), item]),
  );
  return requests.filter((request) => {
    if (request.purchaseChannel !== 'costco_com') return false;
    const item = evidenceByKey.get(priceKey(request));
    return item === undefined || !isUsableOnlinePrice(item.prices.costcoCom);
  }).length;
}

async function authRequiredSummary(
  notifier: LocalNotifier,
  startedAt: string,
  now: () => Date,
): Promise<RunSummary> {
  const local = await sendAuthRequired(notifier);
  return emptySummary(startedAt, now().toISOString(), 'auth_required', {
    email: notAttempted(),
    local,
  });
}

function selectionsForChannel(
  database: RunDatabase,
  channel: AlertChannel,
  candidates: Parameters<typeof selectAlerts>[0],
): AlertSelection[] {
  const states = candidates.flatMap((candidate) => {
    const state = database.getChannelAlertState(channel, candidate.purchase.id);
    return state ? [state] : [];
  });
  return selectAlerts(candidates, states);
}

async function deliverLocal(
  dependencies: LockedRunDependencies,
  selections: readonly AlertSelection[],
  deliveredPurchaseIds: Set<string>,
): Promise<NotificationChannelResult> {
  if (selections.length === 0) return notAttempted();
  try {
    await dependencies.localNotifier.send(
      ALERT_TITLE,
      renderCompactReport({
        candidates: selections.map((selection) => selection.candidate),
      }),
    );
  } catch (error) {
    return { attempted: true, delivered: 0, error: errorMessage(error) };
  }
  addDelivered(deliveredPurchaseIds, selections);
  return { attempted: true, delivered: selections.length, error: null };
}

async function deliverEmail(
  dependencies: LockedRunDependencies,
  selections: readonly AlertSelection[],
  deliveredPurchaseIds: Set<string>,
): Promise<NotificationChannelResult> {
  if (selections.length === 0) return notAttempted();
  try {
    const recipient =
      dependencies.config.emailRecipient ??
      (await dependencies.mailNotifier.resolveSelfRecipient());
    await dependencies.mailNotifier.send(
      recipient,
      ALERT_TITLE,
      renderTextReport({
        candidates: selections.map((selection) => selection.candidate),
      }),
    );
  } catch (error) {
    return { attempted: true, delivered: 0, error: errorMessage(error) };
  }
  addDelivered(deliveredPurchaseIds, selections);
  return { attempted: true, delivered: selections.length, error: null };
}

async function sendAuthRequired(
  notifier: LocalNotifier,
): Promise<NotificationChannelResult> {
  try {
    await notifier.send(
      AUTH_TITLE,
      'Costco authentication is required. Run `costco login` and try again.',
    );
    return { attempted: true, delivered: 1, error: null };
  } catch (error) {
    return { attempted: true, delivered: 0, error: errorMessage(error) };
  }
}

function persistSelections(
  database: RunDatabase,
  channel: AlertChannel,
  selections: readonly AlertSelection[],
): void {
  for (const { state } of selections) {
    database.saveChannelAlertState(channel, state);
  }
}

function addDelivered(
  purchaseIds: Set<string>,
  selections: readonly AlertSelection[],
): void {
  for (const selection of selections) {
    purchaseIds.add(selection.state.purchaseId);
  }
}

function uniquePriceRequests(
  purchases: readonly {
    description?: string;
    itemNumber: string;
    purchaseChannel: import('../domain/types.js').PurchaseChannel;
    warehouseNumber: string;
  }[],
): PriceRequest[] {
  const requests = new Map<string, PriceRequest>();
  for (const purchase of purchases) {
    const key = `${purchase.purchaseChannel}\u0000${purchase.itemNumber}\u0000${purchase.warehouseNumber}`;
    const description =
      purchase.description?.trim() || requests.get(key)?.description;
    requests.set(key, {
      ...(description === undefined ? {} : { description }),
      itemNumber: purchase.itemNumber,
      purchaseChannel: purchase.purchaseChannel,
      warehouseNumber: purchase.warehouseNumber,
    });
  }
  return [...requests.values()];
}

function scheduledFreshnessMilliseconds(intervalDays: number): number {
  return intervalDays * 24 * HOUR_MILLISECONDS - 4 * HOUR_MILLISECONDS;
}

function isFresh(
  lastSuccess: RunSummary | null,
  now: Date,
  freshnessMilliseconds: number,
): boolean {
  if (!lastSuccess) return false;
  const finishedAt = Date.parse(lastSuccess.finishedAt);
  if (!Number.isFinite(finishedAt)) return false;
  const age = now.getTime() - finishedAt;
  return age >= 0 && age < freshnessMilliseconds;
}

function dateDaysBefore(now: Date, days: number): string {
  const date = new Date(0);
  date.setUTCFullYear(now.getFullYear(), now.getMonth(), now.getDate() - days);
  date.setUTCHours(0, 0, 0, 0);
  return formattedDate(
    date.getUTCFullYear(),
    date.getUTCMonth() + 1,
    date.getUTCDate(),
  );
}

function datePart(date: Date): string {
  return formattedDate(date.getFullYear(), date.getMonth() + 1, date.getDate());
}

function formattedDate(year: number, month: number, day: number): string {
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function emptySummary(
  startedAt: string,
  finishedAt: string,
  outcome: RunSummary['outcome'],
  notifications: NotificationResults,
  diagnostic?: string,
): RunSummary {
  return {
    alertsSent: 0,
    candidatesFound: 0,
    finishedAt,
    notifications,
    observationsRecorded: 0,
    outcome,
    purchasesProcessed: 0,
    startedAt,
    unresolvedPrices: 0,
    ...(diagnostic === undefined ? {} : { diagnostic }),
  };
}

function emptyNotificationResults(): NotificationResults {
  return { email: notAttempted(), local: notAttempted() };
}

function notAttempted(): NotificationChannelResult {
  return { attempted: false, delivered: 0, error: null };
}

function errorMessage(error: unknown): string {
  return sanitizeDiagnosticText(
    error instanceof Error ? error.message : 'Unknown notification error',
  );
}

function timeoutSignal(dependencies: LockedRunDependencies): AbortSignal {
  return (dependencies.createTimeoutSignal ?? defaultTimeoutSignal)(
    EXTERNAL_REQUEST_TIMEOUT_MILLISECONDS,
  );
}

function defaultTimeoutSignal(timeoutMilliseconds: number): AbortSignal {
  return AbortSignal.timeout(timeoutMilliseconds);
}

function failureDiagnostic(prefix: string, error: unknown): string {
  const message = error instanceof Error ? error.message : 'Unexpected error';
  return `${prefix}: ${sanitizeDiagnosticText(message)}`;
}
