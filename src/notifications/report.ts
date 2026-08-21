import type { AdjustmentCandidate } from '../domain/types.js';

export interface AdjustmentReportSummary {
  readonly candidates: readonly AdjustmentCandidate[];
}

const COMPACT_ITEM_LIMIT = 3;
const COMPACT_DESCRIPTION_LENGTH = 54;
const COMPACT_REPORT_LENGTH = 480;

export function renderCompactReport(summary: AdjustmentReportSummary): string {
  if (summary.candidates.length === 0) {
    return 'No potential Costco price adjustments found.';
  }

  const ordered = [...summary.candidates].sort(
    (left, right) =>
      left.daysRemaining - right.daysRemaining ||
      right.savingsCents - left.savingsCents ||
      left.purchase.itemNumber.localeCompare(right.purchase.itemNumber),
  );
  const totalSavings = summary.candidates.reduce(
    (total, candidate) => total + candidate.savingsCents,
    0,
  );
  const count = summary.candidates.length;
  const hidden = Math.max(0, count - COMPACT_ITEM_LIMIT);
  const footer = 'Verify at the original warehouse.';
  const lines = [
    `${String(count)} potential ${count === 1 ? 'adjustment' : 'adjustments'} • ${formatCents(totalSavings)} total potential savings`,
    ...ordered.slice(0, COMPACT_ITEM_LIMIT).map((candidate) => {
      const description = truncateText(
        escapeText(candidateDescription(candidate)),
        COMPACT_DESCRIPTION_LENGTH,
      );
      return `• ${description} (item ${escapeText(candidate.purchase.itemNumber)}, WH ${escapeText(candidate.purchase.warehouseNumber)}): ${formatCents(candidate.savingsCents)} • ${String(candidate.daysRemaining)}d left`;
    }),
    ...(hidden === 0 ? [] : [`+${String(hidden)} more`]),
  ];
  const body = lines.join('\n');
  const report = `${body}\n${footer}`;
  if (report.length <= COMPACT_REPORT_LENGTH) return report;
  return `${truncateText(
    body,
    COMPACT_REPORT_LENGTH - footer.length - 1,
  )}\n${footer}`;
}

export function renderTextReport(summary: AdjustmentReportSummary): string {
  if (summary.candidates.length === 0) {
    return [
      'Potential Costco price adjustments',
      '',
      'No potential price adjustments found.',
      'Verify any future potential adjustment at the original warehouse.',
    ].join('\n');
  }

  return [
    'Potential Costco price adjustments',
    'Verify this potential adjustment at the original warehouse.',
    '',
    ...summary.candidates.flatMap((candidate) => [
      candidateHeading(candidate),
      `Warehouse: ${escapeText(candidate.purchase.warehouseNumber)}`,
      `Paid: ${formatCents(candidate.purchase.paidUnitCents)}`,
      `Current: ${formatCents(candidate.currentUnitCents)}`,
      `Potential savings: ${formatCents(candidate.savingsCents)}`,
      `${candidate.daysRemaining} ${pluralizeDay(candidate.daysRemaining)} remaining`,
      '',
    ]),
  ]
    .join('\n')
    .trimEnd();
}

export function renderHtmlReport(summary: AdjustmentReportSummary): string {
  const items = summary.candidates
    .map(
      (candidate) => `
        <li>
          <p><strong>${escapeHtml(candidateDescription(candidate))}</strong></p>
          <p>Item: ${escapeHtml(candidate.purchase.itemNumber)}<br>
          Original warehouse: ${escapeHtml(candidate.purchase.warehouseNumber)}<br>
          Paid: ${formatCents(candidate.purchase.paidUnitCents)}<br>
          Current: ${formatCents(candidate.currentUnitCents)}<br>
          Potential savings: ${formatCents(candidate.savingsCents)}<br>
          ${candidate.daysRemaining} ${pluralizeDay(candidate.daysRemaining)} remaining</p>
        </li>`,
    )
    .join('');

  const body =
    summary.candidates.length === 0
      ? '<p>No potential price adjustments found.</p>'
      : `<ul>${items}\n      </ul>`;

  return `<!doctype html>
<html lang="en">
  <body>
    <h1>Potential Costco price adjustments</h1>
    <p>These are potential price adjustments. Verify each one at the original warehouse before requesting an adjustment.</p>
    ${body}
  </body>
</html>`;
}

function candidateHeading(candidate: AdjustmentCandidate): string {
  return `${escapeText(candidateDescription(candidate))} (item ${escapeText(candidate.purchase.itemNumber)})`;
}

function candidateDescription(candidate: AdjustmentCandidate): string {
  return candidate.purchase.description ?? 'Costco item';
}

function formatCents(cents: number): string {
  const sign = cents < 0 ? '-' : '';
  const absoluteCents = Math.abs(cents);
  const dollars = Math.floor(absoluteCents / 100).toLocaleString('en-US');
  const remainder = String(absoluteCents % 100).padStart(2, '0');

  return `${sign}$${dollars}.${remainder}`;
}

function pluralizeDay(days: number): string {
  return days === 1 ? 'day' : 'days';
}

function escapeText(value: string): string {
  return value.replace(/\p{Cc}/gu, ' ').replace(/\p{Cf}/gu, '');
}

function escapeHtml(value: string): string {
  return escapeText(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function truncateText(value: string, maximumLength: number): string {
  if (value.length <= maximumLength) return value;
  return `${value.slice(0, Math.max(0, maximumLength - 1)).trimEnd()}…`;
}
