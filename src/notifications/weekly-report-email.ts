import type { AdjustmentCandidate, FullReportRow } from '../domain/types.js';

export interface WeeklyReportEmail {
  readonly candidates: readonly AdjustmentCandidate[];
  readonly rows: readonly FullReportRow[];
  readonly startedAt: string;
}

interface WeeklySummary {
  readonly candidates: readonly AdjustmentCandidate[];
  readonly unavailableNames: readonly string[];
  readonly itemCount: number;
  readonly priceFoundCount: number;
  readonly verifiedPriceCount: number;
  readonly sameDayPriceCount: number;
  readonly verifiedCandidateCount: number;
  readonly estimateCandidateCount: number;
}

const pacificDateTime = new Intl.DateTimeFormat('en-US', {
  day: 'numeric',
  hour: 'numeric',
  hour12: true,
  minute: '2-digit',
  month: 'long',
  timeZone: 'America/Los_Angeles',
  timeZoneName: 'short',
  weekday: 'long',
  year: 'numeric',
});

const purchaseDate = new Intl.DateTimeFormat('en-US', {
  day: 'numeric',
  month: 'short',
  timeZone: 'UTC',
  year: 'numeric',
});

export function renderWeeklyReportEmail(report: WeeklyReportEmail): string {
  const summary = summarize(report);
  const lines = [
    `Checked: ${pacificDateTime.format(new Date(report.startedAt))}`,
    '',
    'Potential adjustments',
    summary.candidates.length === 0
      ? 'None found.'
      : renderTextTable(summary.candidates),
    ...(summary.estimateCandidateCount === 0
      ? []
      : [
          '',
          'Same-Day prices are estimated warehouse equivalents. Verify at the original warehouse.',
        ]),
    '',
    'Overall stats',
    ...statLines(summary),
    unavailableLine(summary),
  ];
  return lines.join('\n');
}

export function renderWeeklyReportHtml(report: WeeklyReportEmail): string {
  const summary = summarize(report);
  const checkedAt = escapeHtml(
    pacificDateTime.format(new Date(report.startedAt)),
  );
  const rows = summary.candidates
    .map((candidate) => {
      const cells = candidateCells(candidate)
        .map(
          (cell, index) =>
            `<td style="border:1px solid #d1d5db;padding:8px;vertical-align:top">${index === 0 ? htmlItemCell(candidate) : escapeHtml(cell)}</td>`,
        )
        .join('');
      return `<tr>${cells}</tr>`;
    })
    .join('\n');
  const table =
    summary.candidates.length === 0
      ? '<p>None found.</p>'
      : `<table style="border-collapse:collapse;font-family:Arial,sans-serif;font-size:13px;width:100%">
  <thead><tr>${[
    'Item / name',
    'Paid / unit',
    'Current / unit',
    'Savings total',
    'Purchased',
    'Days left',
    'Source',
  ]
    .map(
      (heading) =>
        `<th scope="col" style="background:#f3f4f6;border:1px solid #d1d5db;padding:8px;text-align:left">${heading}</th>`,
    )
    .join('')}</tr></thead>
  <tbody>${rows}</tbody>
</table>`;
  const stats = statLines(summary)
    .map((line) => `<li>${escapeHtml(line)}</li>`)
    .join('');
  return `<!doctype html>
<html lang="en">
  <body style="color:#111827;font-family:Arial,sans-serif;font-size:14px">
    <p>Checked: ${checkedAt}</p>
    <h2>Potential adjustments</h2>
    ${table}
    ${summary.estimateCandidateCount === 0 ? '' : '<p>Same-Day prices are estimated warehouse equivalents. Verify at the original warehouse.</p>'}
    <h2>Overall stats</h2>
    <ul>${stats}</ul>
    <p>${escapeHtml(unavailableLine(summary))}</p>
  </body>
</html>`;
}

function summarize(report: WeeklyReportEmail): WeeklySummary {
  const candidates = [...report.candidates].sort(
    (left, right) =>
      left.daysRemaining - right.daysRemaining ||
      right.savingsCents - left.savingsCents,
  );
  const unavailableNames = [
    ...new Set(
      report.rows
        .filter((row) => !hasCurrentPrice(row))
        .map(
          (row) =>
            safeText(row.purchase.description?.trim() || '') ||
            `Item ${safeText(row.purchase.itemNumber)}`,
        ),
    ),
  ].sort((left, right) => left.localeCompare(right));
  const verifiedCandidateCount = candidates.filter(
    (candidate) => !isEstimate(candidate),
  ).length;
  return {
    candidates,
    unavailableNames,
    itemCount: report.rows.length,
    priceFoundCount: report.rows.filter(hasCurrentPrice).length,
    verifiedPriceCount: report.rows.filter(hasVerifiedPrice).length,
    sameDayPriceCount: report.rows.filter(
      (row) =>
        row.purchase.purchaseChannel === 'warehouse' &&
        !hasVerifiedPrice(row) &&
        row.prices.sameDay.unitPriceCents !== null,
    ).length,
    verifiedCandidateCount,
    estimateCandidateCount: candidates.length - verifiedCandidateCount,
  };
}

function renderTextTable(candidates: readonly AdjustmentCandidate[]): string {
  const headings = [
    'Item / name',
    'Paid / unit',
    'Current / unit',
    'Savings total',
    'Purchased',
    'Days left',
    'Source',
  ];
  const header = `| ${headings.join(' | ')} |`;
  const separator = `| ${headings.map(() => '---').join(' | ')} |`;
  const rows = candidates.map(
    (candidate) => `| ${candidateCells(candidate).map(textCell).join(' | ')} |`,
  );
  return [header, separator, ...rows].join('\n');
}

function candidateCells(candidate: AdjustmentCandidate): string[] {
  const estimate = isEstimate(candidate);
  const prefix = estimate ? '~' : '';
  return [
    textItemCell(candidate),
    formatCents(candidate.purchase.paidUnitCents),
    `${prefix}${formatCents(candidate.currentUnitCents)}`,
    `${prefix}${formatCents(candidate.savingsCents)}`,
    formatPurchaseDate(candidate.purchase.purchasedAt),
    formatDays(candidate.daysRemaining),
    estimate
      ? 'Same-Day estimate'
      : candidate.purchase.purchaseChannel === 'costco_com'
        ? 'Costco.com'
        : 'Costco warehouse',
  ];
}

function textItemCell(candidate: AdjustmentCandidate): string {
  const name = safeText(
    candidate.purchase.description?.trim() || 'Costco item',
  );
  const number = safeText(candidate.purchase.itemNumber);
  const warehouse =
    candidate.purchase.purchaseChannel === 'warehouse'
      ? `, WH ${safeText(candidate.purchase.warehouseNumber)}`
      : '';
  return `${name} (item #${number}${warehouse})`;
}

function htmlItemCell(candidate: AdjustmentCandidate): string {
  const name = escapeHtml(
    safeText(candidate.purchase.description?.trim() || 'Costco item'),
  );
  const number = escapeHtml(safeText(candidate.purchase.itemNumber));
  const warehouse =
    candidate.purchase.purchaseChannel === 'warehouse'
      ? ` · WH ${escapeHtml(safeText(candidate.purchase.warehouseNumber))}`
      : '';
  return `<strong>${name}</strong><br><span style="color:#4b5563">Item #${number}${warehouse}</span>`;
}

function statLines(summary: WeeklySummary): string[] {
  return [
    `Items considered: ${String(summary.itemCount)}`,
    `Prices found: ${String(summary.priceFoundCount)} of ${String(summary.itemCount)} (${String(summary.verifiedPriceCount)} verified; ${String(summary.sameDayPriceCount)} Same-Day)`,
    `Potential adjustments: ${String(summary.candidates.length)} (${String(summary.verifiedCandidateCount)} verified; ${String(summary.estimateCandidateCount)} Same-Day estimates)`,
  ];
}

function unavailableLine(summary: WeeklySummary): string {
  return `Current prices unavailable: (${summary.unavailableNames.join('; ') || 'none'})`;
}

function hasVerifiedPrice(row: FullReportRow): boolean {
  return row.purchase.purchaseChannel === 'warehouse'
    ? row.prices.warehouse.unitPriceCents !== null
    : row.prices.costcoCom.unitPriceCents !== null;
}

function hasCurrentPrice(row: FullReportRow): boolean {
  return (
    hasVerifiedPrice(row) ||
    (row.purchase.purchaseChannel === 'warehouse' &&
      row.prices.sameDay.unitPriceCents !== null)
  );
}

function isEstimate(candidate: AdjustmentCandidate): boolean {
  return (
    candidate.estimated === true || candidate.comparisonChannel === 'same_day'
  );
}

function formatPurchaseDate(timestamp: string): string {
  const date = new Date(`${timestamp.slice(0, 10)}T12:00:00.000Z`);
  return Number.isNaN(date.getTime())
    ? safeText(timestamp.slice(0, 10))
    : purchaseDate.format(date);
}

function formatCents(cents: number): string {
  return new Intl.NumberFormat('en-US', {
    currency: 'USD',
    style: 'currency',
  }).format(cents / 100);
}

function formatDays(days: number): string {
  return `${String(days)} ${days === 1 ? 'day' : 'days'}`;
}

function safeText(value: string): string {
  return value
    .replace(/\p{Cc}/gu, ' ')
    .replace(/\p{Cf}/gu, '')
    .replace(/\s+/gu, ' ')
    .trim();
}

function textCell(value: string): string {
  return value.replaceAll('|', '/');
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}
