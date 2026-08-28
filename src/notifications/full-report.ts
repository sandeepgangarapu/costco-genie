import { randomUUID } from 'node:crypto';
import { renameSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

import type { AppPaths } from '../config/paths.js';
import type {
  FullReportRow,
  FullReportFiles,
  FullRunReport,
  PriceChannel,
  ReportPriceChannels,
  ReportPriceObservation,
} from '../domain/types.js';
import {
  createPrivateTextFile,
  ensurePrivateDirectory,
  inspectRegularFileWithoutMutation,
  pathExistsWithoutFollowing,
} from '../lib/filesystem.js';

export type { FullReportFiles } from '../domain/types.js';

export interface FullReportFileOperations {
  readonly rename: (source: string, destination: string) => void;
}

const DEFAULT_FILE_OPERATIONS: FullReportFileOperations = {
  rename: renameSync,
};

const CSV_COLUMNS = [
  'record_type',
  'item_number',
  'item_name',
  'warehouse_number',
  'purchased_at',
  'quantity',
  'gross_unit_price',
  'receipt_discount_total',
  'net_paid_unit_price',
  'current_warehouse_price',
  'warehouse_source',
  'warehouse_observed_at',
  'warehouse_unavailable_reason',
  'historical_receipt_price',
  'historical_receipt_source',
  'historical_receipt_observed_at',
  'historical_receipt_unavailable_reason',
  'warehouse_savings_price',
  'warehouse_savings_promotion',
  'warehouse_savings_source',
  'warehouse_savings_observed_at',
  'warehouse_savings_unavailable_reason',
  'costco_com_price',
  'costco_com_source',
  'costco_com_observed_at',
  'costco_com_unavailable_reason',
  'same_day_price',
  'same_day_source',
  'same_day_observed_at',
  'same_day_unavailable_reason',
  'same_day_estimated_warehouse_price',
  'same_day_markup_percent',
  'same_day_estimated_delta',
  'warehouse_delta',
  'days_remaining',
  'status',
  'reason',
  'purchase_channel',
  'receipt_or_order',
  'comparison_channel',
  'comparison_price',
  'unit_delta',
  'potential_savings',
  'run_started_at',
  'run_finished_at',
  'run_outcome',
  'run_diagnostic',
  'warehouse_purchase_lines',
  'online_purchase_lines',
  'source_diagnostic_channel',
  'source_diagnostic_source',
  'source_diagnostic_status',
  'source_diagnostic_observed_at',
  'source_diagnostic_message',
] as const;

type CsvColumn = (typeof CSV_COLUMNS)[number];

export async function writeFullReport(
  paths: Pick<AppPaths, 'reportsDir'>,
  report: FullRunReport,
  operations: FullReportFileOperations = DEFAULT_FILE_OPERATIONS,
): Promise<FullReportFiles> {
  validateReport(report);
  ensurePrivateDirectory(paths.reportsDir);
  const stem = timestampStem(report.startedAt);
  const files: FullReportFiles = {
    htmlFile: join(paths.reportsDir, `${stem}.html`),
    csvFile: join(paths.reportsDir, `${stem}.csv`),
    jsonFile: join(paths.reportsDir, `${stem}.json`),
  };
  const rendered = {
    html: renderFullReportHtml(report),
    csv: renderFullReportCsv(report),
    json: `${JSON.stringify(report, null, 2)}\n`,
  };
  const manifest = `${JSON.stringify(
    {
      schemaVersion: report.schemaVersion,
      startedAt: report.startedAt,
      files: {
        html: `${stem}.html`,
        csv: `${stem}.csv`,
        json: `${stem}.json`,
      },
    },
    null,
    2,
  )}\n`;

  createPrivateTextFile(files.jsonFile, rendered.json);
  createPrivateTextFile(files.csvFile, rendered.csv);
  createPrivateTextFile(files.htmlFile, rendered.html);

  replaceLatestReports(paths.reportsDir, rendered, manifest, operations);
  return files;
}

function replaceLatestReports(
  reportsDir: string,
  rendered: Readonly<{ html: string; csv: string; json: string }>,
  manifest: string,
  operations: FullReportFileOperations,
): void {
  const replacements = [
    ...(['json', 'csv', 'html'] as const).map((extension) => ({
      contents: rendered[extension],
      destination: join(reportsDir, `latest.${extension}`),
      temporary: join(reportsDir, `.latest.${extension}.${randomUUID()}.tmp`),
    })),
    {
      contents: manifest,
      destination: join(reportsDir, 'latest-manifest.json'),
      temporary: join(reportsDir, `.latest-manifest.json.${randomUUID()}.tmp`),
    },
  ];

  try {
    for (const replacement of replacements) {
      if (pathExistsWithoutFollowing(replacement.destination)) {
        inspectRegularFileWithoutMutation(replacement.destination);
      }
      createPrivateTextFile(replacement.temporary, replacement.contents);
    }
    for (const replacement of replacements) {
      operations.rename(replacement.temporary, replacement.destination);
    }
  } catch (error) {
    for (const replacement of replacements) {
      try {
        unlinkSync(replacement.temporary);
      } catch (cleanupError) {
        void cleanupError;
      }
    }
    throw error;
  }
}

function renderFullReportCsv(report: FullRunReport): string {
  const coverage = reportCoverage(report);
  const runRow = csvRecord({
    record_type: 'run',
    run_started_at: report.startedAt,
    run_finished_at: report.finishedAt,
    run_outcome: report.outcome,
    run_diagnostic: report.diagnostic ?? '',
    warehouse_purchase_lines: String(coverage.warehouse),
    online_purchase_lines: String(coverage.costcoCom),
  });
  const purchaseRows = report.rows.map((row) => {
    const warehouse = row.prices.warehouse;
    const receiptHistory = row.prices.receiptHistory;
    const savings = row.prices.warehouseSavings;
    const online = row.prices.costcoCom;
    const sameDay = row.prices.sameDay;
    return csvRecord({
      record_type: 'purchase',
      item_number: row.purchase.itemNumber,
      item_name: row.purchase.description ?? 'Unavailable',
      warehouse_number: row.purchase.warehouseNumber,
      purchased_at: row.purchase.purchasedAt,
      quantity: String(row.purchase.quantity),
      gross_unit_price: formatOptionalCents(
        row.purchase.grossUnitCents ?? null,
      ),
      receipt_discount_total: formatCents(row.purchase.couponCents),
      net_paid_unit_price: formatCents(row.purchase.paidUnitCents),
      current_warehouse_price: formatOptionalCents(warehouse.unitPriceCents),
      warehouse_source: warehouse.source ?? 'Unavailable',
      warehouse_observed_at: warehouse.observedAt ?? 'Unavailable',
      warehouse_unavailable_reason: warehouse.unavailableReason ?? '',
      historical_receipt_price: formatOptionalCents(
        receiptHistory.unitPriceCents,
      ),
      historical_receipt_source: receiptHistory.source ?? 'Unavailable',
      historical_receipt_observed_at:
        receiptHistory.observedAt ?? 'Unavailable',
      historical_receipt_unavailable_reason:
        receiptHistory.unavailableReason ?? '',
      warehouse_savings_price: formatOptionalCents(savings.unitPriceCents),
      warehouse_savings_promotion: savings.promotionText ?? 'Unavailable',
      warehouse_savings_source: savings.source ?? 'Unavailable',
      warehouse_savings_observed_at: savings.observedAt ?? 'Unavailable',
      warehouse_savings_unavailable_reason: savings.unavailableReason ?? '',
      costco_com_price: formatOptionalCents(online.unitPriceCents),
      costco_com_source: online.source ?? 'Unavailable',
      costco_com_observed_at: online.observedAt ?? 'Unavailable',
      costco_com_unavailable_reason: online.unavailableReason ?? '',
      same_day_price: formatOptionalCents(sameDay.unitPriceCents),
      same_day_source: sameDay.source ?? 'Unavailable',
      same_day_observed_at: sameDay.observedAt ?? 'Unavailable',
      same_day_unavailable_reason: sameDay.unavailableReason ?? '',
      same_day_estimated_warehouse_price: formatOptionalCents(
        row.sameDayWarehouseEstimateCents,
      ),
      same_day_markup_percent: `${String(row.sameDayMarkupPercent)}%`,
      same_day_estimated_delta: formatOptionalCents(
        row.sameDayEstimatedDeltaCents,
      ),
      warehouse_delta: formatOptionalCents(row.warehouseDeltaCents),
      days_remaining:
        row.daysRemaining === null ? 'Unavailable' : String(row.daysRemaining),
      status: row.status,
      reason: row.reason ?? '',
      purchase_channel: row.purchase.purchaseChannel,
      receipt_or_order: row.purchase.receiptId,
      comparison_channel: row.comparisonChannel ?? '',
      comparison_price: formatOptionalCents(row.comparisonUnitCents),
      unit_delta: formatOptionalCents(row.comparisonDeltaCents),
      potential_savings: formatOptionalCents(row.potentialSavingsCents),
      run_started_at: report.startedAt,
      run_finished_at: report.finishedAt,
      run_outcome: report.outcome,
    });
  });
  const diagnosticRows = report.sourceDiagnostics.map((diagnostic) =>
    csvRecord({
      record_type: 'source_diagnostic',
      run_started_at: report.startedAt,
      run_finished_at: report.finishedAt,
      run_outcome: report.outcome,
      source_diagnostic_channel: diagnostic.channel ?? '',
      source_diagnostic_source: diagnostic.source,
      source_diagnostic_status: diagnostic.status,
      source_diagnostic_observed_at: diagnostic.observedAt,
      source_diagnostic_message: diagnostic.message,
    }),
  );

  return `${[CSV_COLUMNS, runRow, ...purchaseRows, ...diagnosticRows]
    .map((row) => row.map(csvField).join(','))
    .join('\n')}\n`;
}

function csvRecord(values: Partial<Record<CsvColumn, string>>): string[] {
  return CSV_COLUMNS.map((column) => values[column] ?? '');
}

function csvField(value: string): string {
  return /[",\r\n]/u.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}

function renderFullReportHtml(report: FullRunReport): string {
  const coverage = reportCoverage(report);
  const diagnostics = report.sourceDiagnostics
    .map(
      (diagnostic) =>
        `<li><strong>${escapeHtml(diagnostic.source)}</strong> (${escapeHtml(diagnostic.channel ?? 'run')}, ${escapeHtml(diagnostic.status)}): ${escapeHtml(diagnostic.message)} <time datetime="${escapeHtml(diagnostic.observedAt)}">${escapeHtml(diagnostic.observedAt)}</time></li>`,
    )
    .join('\n');
  const bodyRows = report.rows.map(renderHtmlRow).join('\n');
  const emptyMessage =
    report.rows.length === 0
      ? '<p>No purchase lines were available for this run.</p>'
      : '';

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Costco full price report</title>
  <style>
    :root { color-scheme: light; font-family: ui-sans-serif, system-ui, sans-serif; line-height: 1.45; }
    body { color: #172033; background: #f6f8fb; margin: 0; padding: 2rem; }
    main { max-width: 1500px; margin: auto; }
    h1, h2 { line-height: 1.15; }
    .card { background: white; border: 1px solid #dce2eb; border-radius: .75rem; padding: 1rem; margin: 1rem 0; }
    .table-wrap { overflow-x: auto; }
    table { border-collapse: collapse; width: 100%; font-size: .875rem; }
    caption { font-weight: 700; text-align: left; padding: 0 0 .75rem; }
    th, td { border-bottom: 1px solid #e4e8ef; padding: .65rem; text-align: left; vertical-align: top; }
    th { background: #f0f3f8; white-space: nowrap; }
    .candidate { color: #087443; font-weight: 700; }
    .estimated { color: #8a5a00; font-weight: 700; }
    .muted { color: #5c667a; }
  </style>
</head>
<body>
<main>
  <h1>Costco full price report</h1>
  <div class="card">
    <p><strong>Outcome:</strong> ${escapeHtml(report.outcome)}</p>
    <p><strong>Run:</strong> <time datetime="${escapeHtml(report.startedAt)}">${escapeHtml(report.startedAt)}</time> to <time datetime="${escapeHtml(report.finishedAt)}">${escapeHtml(report.finishedAt)}</time></p>
    <p><strong>Warehouse purchase lines:</strong> ${String(coverage.warehouse)} · <strong>Costco.com purchase lines:</strong> ${String(coverage.costcoCom)}</p>
    ${report.diagnostic === null ? '' : `<p><strong>Diagnostic:</strong> ${escapeHtml(report.diagnostic)}</p>`}
  </div>
  <section class="card table-wrap" aria-labelledby="purchase-lines-heading">
    <h2 id="purchase-lines-heading">Purchase lines</h2>
    ${emptyMessage}
    <table>
      <caption>Purchase-line price comparison</caption>
      <thead><tr>
        <th scope="col">Item</th><th scope="col">Name</th><th scope="col">Purchase channel</th><th scope="col">Receipt / order</th><th scope="col">Purchase location</th><th scope="col">Purchased</th><th scope="col">Active quantity</th><th scope="col">Gross unit</th><th scope="col">Receipt discount</th><th scope="col">Net paid unit</th><th scope="col">Comparison channel</th><th scope="col">Comparison price</th><th scope="col">Unit delta</th><th scope="col">Potential savings</th><th scope="col">Current warehouse</th><th scope="col">Historical receipt evidence</th><th scope="col">Warehouse Savings</th><th scope="col">Costco.com</th><th scope="col">Same-Day</th><th scope="col">Same-Day corrected warehouse estimate</th><th scope="col">Estimated delta</th><th scope="col">Warehouse delta</th><th scope="col">Days left</th><th scope="col">Status</th><th scope="col">Reason</th>
      </tr></thead>
      <tbody>${bodyRows}</tbody>
    </table>
  </section>
  <section class="card" aria-labelledby="diagnostics-heading">
    <h2 id="diagnostics-heading">Source diagnostics</h2>
    ${diagnostics === '' ? '<p>No source diagnostics.</p>' : `<ul>${diagnostics}</ul>`}
  </section>
</main>
</body>
</html>
`;
}

function renderHtmlRow(row: FullReportRow): string {
  return `<tr>
  <td>${escapeHtml(row.purchase.itemNumber)}</td>
  <td>${escapeHtml(row.purchase.description ?? 'Unavailable')}</td>
  <td>${comparisonChannelLabel(row.purchase.purchaseChannel)}</td>
  <td>${escapeHtml(row.purchase.receiptId)}</td>
  <td>${row.purchase.purchaseChannel === 'warehouse' ? `Warehouse ${escapeHtml(row.purchase.warehouseNumber)}` : 'Costco.com'}</td>
  <td><time datetime="${escapeHtml(row.purchase.purchasedAt)}">${escapeHtml(row.purchase.purchasedAt)}</time></td>
  <td>${String(row.purchase.quantity)}</td>
  <td>${formatOptionalCents(row.purchase.grossUnitCents ?? null)}</td>
  <td>${formatCents(row.purchase.couponCents)}</td>
  <td>${formatCents(row.purchase.paidUnitCents)}</td>
  <td>${row.comparisonChannel === null ? 'Unavailable' : comparisonChannelLabel(row.comparisonChannel)}</td>
  <td>${formatOptionalCents(row.comparisonUnitCents)}</td>
  <td>${formatOptionalCents(row.comparisonDeltaCents)}</td>
  <td>${formatOptionalCents(row.potentialSavingsCents)}</td>
  <td>${renderHtmlPrice(row.prices.warehouse)}</td>
  <td>${renderHtmlPrice(row.prices.receiptHistory)}</td>
  <td>${renderHtmlPrice(row.prices.warehouseSavings)}</td>
  <td>${renderHtmlPrice(row.prices.costcoCom)}</td>
  <td>${renderHtmlPrice(row.prices.sameDay)}</td>
  <td>${renderSameDayEstimate(row)}</td>
  <td>${formatOptionalCents(row.sameDayEstimatedDeltaCents)}</td>
  <td>${formatOptionalCents(row.warehouseDeltaCents)}</td>
  <td>${row.daysRemaining === null ? 'Unavailable' : String(row.daysRemaining)}</td>
  <td class="${row.status === 'candidate' ? 'candidate' : row.status === 'estimated_opportunity' ? 'estimated' : ''}">${escapeHtml(row.status)}</td>
  <td>${row.status === 'estimated_opportunity' ? 'Manual warehouse verification required — ' : ''}${escapeHtml(row.reason ?? '')}</td>
</tr>`;
}

function comparisonChannelLabel(
  channel: 'warehouse' | 'costco_com' | 'same_day',
): string {
  switch (channel) {
    case 'warehouse':
      return 'Warehouse';
    case 'costco_com':
      return 'Costco.com';
    case 'same_day':
      return 'Same-Day estimate';
  }
}

function reportCoverage(report: FullRunReport): {
  readonly costcoCom: number;
  readonly warehouse: number;
} {
  return report.rows.reduce(
    (coverage, row) => {
      if (row.purchase.purchaseChannel === 'warehouse') {
        coverage.warehouse += 1;
      } else {
        coverage.costcoCom += 1;
      }
      return coverage;
    },
    { costcoCom: 0, warehouse: 0 },
  );
}

function renderSameDayEstimate(row: FullReportRow): string {
  if (row.sameDayWarehouseEstimateCents === null) {
    return '<span class="muted">Unavailable</span>';
  }
  return `${formatCents(row.sameDayWarehouseEstimateCents)}<br><span class="muted">Same-Day corrected warehouse estimate (${String(row.sameDayMarkupPercent)}%); not a verified warehouse price</span>`;
}

function renderHtmlPrice(price: ReportPriceObservation): string {
  if (price.unitPriceCents === null) {
    const reason = price.unavailableReason ?? 'reason unavailable';
    if (price.promotionText === null) {
      return `<span class="muted">Unavailable — ${escapeHtml(reason)}</span>`;
    }
    const details = [
      `Promotion evidence: ${price.promotionText}`,
      price.source,
      price.observedAt,
    ]
      .filter((value): value is string => value !== null)
      .map(escapeHtml)
      .join('<br>');
    return `<span class="muted">Final price unavailable — ${escapeHtml(reason)}<br>${details}</span>`;
  }
  const details = [price.promotionText, price.source, price.observedAt]
    .filter((value): value is string => value !== null)
    .map(escapeHtml)
    .join('<br>');
  return `${formatCents(price.unitPriceCents)}${details === '' ? '' : `<br><span class="muted">${details}</span>`}`;
}

function formatOptionalCents(cents: number | null): string {
  return cents === null ? 'Unavailable' : formatCents(cents);
}

function formatCents(cents: number): string {
  const sign = cents < 0 ? '-' : '';
  const absolute = Math.abs(cents);
  return `${sign}$${String(Math.floor(absolute / 100))}.${String(absolute % 100).padStart(2, '0')}`;
}

function timestampStem(timestamp: string): string {
  const instant = new Date(timestamp);
  if (!Number.isFinite(instant.getTime())) {
    throw new TypeError('Report startedAt must be a valid timestamp.');
  }
  return instant.toISOString().replaceAll(':', '-').replace('.', '-');
}

function escapeHtml(value: string): string {
  return value
    .replace(/\p{Cc}/gu, ' ')
    .replace(/\p{Cf}/gu, '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

export const REPORT_PRICE_CHANNELS: readonly PriceChannel[] = [
  'warehouse',
  'receipt_history',
  'warehouse_savings',
  'costco_com',
  'same_day',
];

function validateReport(report: FullRunReport): void {
  if (report.schemaVersion !== 2) {
    throw new TypeError('Full report schema version 2 is required.');
  }
  const expectedChannels: ReadonlyArray<
    readonly [keyof ReportPriceChannels, PriceChannel]
  > = [
    ['warehouse', 'warehouse'],
    ['receiptHistory', 'receipt_history'],
    ['warehouseSavings', 'warehouse_savings'],
    ['costcoCom', 'costco_com'],
    ['sameDay', 'same_day'],
  ];

  for (const row of report.rows) {
    for (const [key, expectedChannel] of expectedChannels) {
      if (row.prices[key].channel !== expectedChannel) {
        throw new TypeError(
          `Report price field ${key} must use channel ${expectedChannel}.`,
        );
      }
    }
    if (row.purchase.purchaseChannel === 'costco_com') {
      validateOnlineRow(row);
    } else if (row.purchase.purchaseChannel === 'warehouse') {
      validateWarehouseRow(row);
    } else {
      throw new TypeError('A report row has an invalid purchase channel.');
    }
  }
}

function validateOnlineRow(row: FullReportRow): void {
  for (const price of [
    row.prices.warehouse,
    row.prices.receiptHistory,
    row.prices.warehouseSavings,
    row.prices.sameDay,
  ]) {
    if (
      price.unitPriceCents !== null ||
      price.unavailableReason !== 'not_applicable'
    ) {
      throw new TypeError(
        'Costco.com report evidence outside the Costco.com channel must be not_applicable.',
      );
    }
  }
  if (usableExactPrice(row.prices.costcoCom, 'costco_com')) {
    validateComparison(row, 'costco_com', row.prices.costcoCom.unitPriceCents);
  } else {
    validateUnavailableComparison(row, 'Costco.com');
  }
  if (
    row.status === 'candidate' &&
    (row.comparisonChannel !== 'costco_com' ||
      row.comparisonDeltaCents === null ||
      row.comparisonDeltaCents <= 0)
  ) {
    throw new TypeError(
      'A Costco.com candidate requires an exact lower Costco.com comparison.',
    );
  }
  if (row.status === 'estimated_opportunity') {
    throw new TypeError(
      'A Costco.com purchase cannot be a Same-Day estimated opportunity.',
    );
  }
}

function validateWarehouseRow(row: FullReportRow): void {
  if (usableExactPrice(row.prices.warehouse, 'warehouse')) {
    validateComparison(row, 'warehouse', row.prices.warehouse.unitPriceCents);
  } else if (row.status === 'estimated_opportunity') {
    if (
      !usableExactPrice(row.prices.sameDay, 'same_day') ||
      row.sameDayWarehouseEstimateCents === null ||
      row.sameDayEstimatedDeltaCents === null ||
      row.sameDayEstimatedDeltaCents <= 0
    ) {
      throw new TypeError(
        'An estimated opportunity requires no verified warehouse price and a positive Same-Day estimated delta.',
      );
    }
    validateComparison(row, 'same_day', row.sameDayWarehouseEstimateCents);
    if (row.comparisonDeltaCents !== row.sameDayEstimatedDeltaCents) {
      throw new TypeError(
        'A Same-Day report comparison must match its estimated delta.',
      );
    }
  } else {
    validateUnavailableComparison(row, 'warehouse');
  }
  if (
    row.status === 'candidate' &&
    (row.comparisonChannel !== 'warehouse' ||
      row.comparisonDeltaCents === null ||
      row.comparisonDeltaCents <= 0 ||
      row.warehouseDeltaCents !== row.comparisonDeltaCents)
  ) {
    throw new TypeError(
      'A warehouse candidate requires a verified current warehouse price and positive warehouse comparison delta.',
    );
  }
  if (
    row.status === 'estimated_opportunity' &&
    row.comparisonChannel !== 'same_day'
  ) {
    throw new TypeError(
      'An estimated opportunity requires a Same-Day comparison.',
    );
  }
}

function validateComparison(
  row: FullReportRow,
  expectedChannel: NonNullable<FullReportRow['comparisonChannel']>,
  expectedUnitCents: number,
): void {
  const expectedDeltaCents = row.purchase.paidUnitCents - expectedUnitCents;
  const expectedSavingsCents = Math.max(
    0,
    expectedDeltaCents * row.purchase.quantity,
  );
  if (
    !Number.isSafeInteger(row.purchase.paidUnitCents) ||
    row.purchase.paidUnitCents <= 0 ||
    !Number.isSafeInteger(row.purchase.quantity) ||
    row.purchase.quantity <= 0 ||
    !Number.isSafeInteger(expectedDeltaCents) ||
    !Number.isSafeInteger(expectedSavingsCents) ||
    row.comparisonChannel !== expectedChannel ||
    row.comparisonUnitCents !== expectedUnitCents ||
    row.comparisonDeltaCents !== expectedDeltaCents ||
    row.potentialSavingsCents !== expectedSavingsCents
  ) {
    const label =
      expectedChannel === 'costco_com'
        ? 'Costco.com'
        : expectedChannel === 'warehouse'
          ? 'warehouse'
          : 'Same-Day';
    throw new TypeError(
      `The ${label} comparison fields must match the relevant current price.`,
    );
  }
}

function validateUnavailableComparison(
  row: FullReportRow,
  purchaseLabel: string,
): void {
  if (
    row.comparisonChannel !== null ||
    row.comparisonUnitCents !== null ||
    row.comparisonDeltaCents !== null ||
    row.potentialSavingsCents !== null
  ) {
    throw new TypeError(
      `An unavailable ${purchaseLabel} comparison requires null comparison fields.`,
    );
  }
}

function usableExactPrice(
  price: ReportPriceObservation,
  channel: 'warehouse' | 'costco_com' | 'same_day',
): price is ReportPriceObservation & {
  readonly observedAt: string;
  readonly source: string;
  readonly unitPriceCents: number;
} {
  return (
    price.channel === channel &&
    price.unavailableReason === null &&
    price.observedAt !== null &&
    Number.isFinite(Date.parse(price.observedAt)) &&
    price.source !== null &&
    price.source.length > 0 &&
    price.unitPriceCents !== null &&
    Number.isSafeInteger(price.unitPriceCents) &&
    price.unitPriceCents > 0
  );
}
