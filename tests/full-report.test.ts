import {
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { appPaths } from '../src/config/paths.js';
import type {
  FullReportRow,
  FullRunReport,
  ReportPriceChannels,
} from '../src/domain/types.js';
import { writeFullReport } from '../src/notifications/full-report.js';

const temporaryHomes: string[] = [];

function createTemporaryHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'costco-full-report-'));
  temporaryHomes.push(home);
  return home;
}

afterEach(() => {
  for (const home of temporaryHomes.splice(0)) {
    rmSync(home, { force: true, recursive: true });
  }
});

describe('writeFullReport', () => {
  it('writes equivalent timestamped JSON, CSV, and self-contained HTML with every price channel', async () => {
    const paths = appPaths(createTemporaryHome());
    const report = sampleReport();

    const files = await writeFullReport(paths, report);

    expect(basename(files.jsonFile)).toBe('2026-08-21T16-20-30-456Z.json');
    expect(basename(files.csvFile)).toBe('2026-08-21T16-20-30-456Z.csv');
    expect(basename(files.htmlFile)).toBe('2026-08-21T16-20-30-456Z.html');

    const json = JSON.parse(readFileSync(files.jsonFile, 'utf8')) as unknown;
    expect(json).toEqual(report);

    const csv = readFileSync(files.csvFile, 'utf8');
    expect(csv).toContain(
      'record_type,item_number,item_name,warehouse_number,purchased_at,quantity,gross_unit_price,receipt_discount_total,net_paid_unit_price,current_warehouse_price,warehouse_source,warehouse_observed_at,warehouse_unavailable_reason,historical_receipt_price,historical_receipt_source,historical_receipt_observed_at,historical_receipt_unavailable_reason,warehouse_savings_price,warehouse_savings_promotion,warehouse_savings_source,warehouse_savings_observed_at,warehouse_savings_unavailable_reason,costco_com_price,costco_com_source,costco_com_observed_at,costco_com_unavailable_reason,same_day_price,same_day_source,same_day_observed_at,same_day_unavailable_reason,warehouse_delta,days_remaining,status,reason,run_started_at,run_finished_at,run_outcome,run_diagnostic,source_diagnostic_channel,source_diagnostic_source,source_diagnostic_status,source_diagnostic_observed_at,source_diagnostic_message',
    );
    expect(csv).toContain(
      'purchase,1207907,"Kirkland, Premium ""Paper""",110,2026-08-14T18:02:03Z,2,$16.99,$2.00,$15.99,$14.99,verified_warehouse_api,2026-08-21T15:00:00Z,,$15.99,receipt_history,2026-08-14T18:02:03Z,,$14.49,"Save $3, warehouse only",warehouse_savings_page',
    );

    const html = readFileSync(files.htmlFile, 'utf8');
    expect(html).toContain('<!doctype html>');
    expect(html).toContain('<caption>Purchase-line price comparison</caption>');
    expect(html).toContain(
      '1 purchase line — Warehouse: $14.99 · Historical receipt: $15.99 · Warehouse Savings: $14.49 · Costco.com: $17.99 · Same-Day: Unavailable — not_available',
    );
    expect(html).toContain('Warehouse Savings');
    expect(html).toContain('Costco.com');
    expect(html).toContain('Same-Day');
    expect(html).toContain('Kirkland, Premium &quot;Paper&quot;');
    expect(html).not.toMatch(/<script|<link[^>]+href=/i);
    expect(html.match(/<\/html>/gu)).toHaveLength(1);

    expect(lstatSync(paths.reportsDir).mode & 0o777).toBe(0o700);
    for (const path of Object.values(files)) {
      expect(lstatSync(path).mode & 0o777).toBe(0o600);
    }
  });

  it('renders missing values as unavailable with their reason instead of borrowing an online price', async () => {
    const paths = appPaths(createTemporaryHome());
    const original = sampleReport({
      warehouse: unavailablePrice('warehouse', 'not_warehouse_price'),
      receiptHistory: availablePrice(
        'receipt_history',
        1_599,
        'receipt_history',
      ),
      warehouseSavings: unavailablePrice(
        'warehouse_savings',
        'item_not_advertised',
      ),
      costcoCom: availablePrice('costco_com', 1_099, 'costco.com'),
      sameDay: unavailablePrice('same_day', 'not_available'),
    });
    const row = original.rows[0];
    if (!row) throw new Error('fixture row missing');
    const report: FullRunReport = {
      ...original,
      rows: [
        {
          ...row,
          warehouseDeltaCents: null,
          status: 'not_eligible',
          reason: 'not_warehouse_price',
        },
      ],
    };

    const files = await writeFullReport(paths, report);

    const csv = readFileSync(files.csvFile, 'utf8');
    expect(csv).toContain(
      'Unavailable,Unavailable,Unavailable,not_warehouse_price,$15.99,receipt_history,2026-08-21T15:00:00Z,,Unavailable,Unavailable,Unavailable,Unavailable,item_not_advertised,$10.99,costco.com',
    );
    expect(csv).not.toContain('$10.99,costco.com,2026-08-21T15:06:00Z,,$10.99');

    const html = readFileSync(files.htmlFile, 'utf8');
    expect(html).toContain('Unavailable — not_warehouse_price');
    expect(html).toContain('$10.99');
  });

  it('keeps historical receipt evidence separate and refuses to report it as a candidate', async () => {
    const paths = appPaths(createTemporaryHome());
    const original = sampleReport({
      warehouse: unavailablePrice('warehouse', 'not_warehouse_price'),
      receiptHistory: availablePrice(
        'receipt_history',
        1_499,
        'receipt_history',
      ),
      warehouseSavings: unavailablePrice(
        'warehouse_savings',
        'item_not_advertised',
      ),
      costcoCom: unavailablePrice('costco_com', 'not_available'),
      sameDay: unavailablePrice('same_day', 'not_available'),
    });

    await expect(writeFullReport(paths, original)).rejects.toThrow(
      /candidate.*current warehouse/i,
    );
  });

  it('renders savings-only evidence when an advertised final price is unavailable', async () => {
    const paths = appPaths(createTemporaryHome());
    const prices = samplePriceChannels();
    const report = sampleReport({
      ...prices,
      warehouseSavings: {
        channel: 'warehouse_savings',
        unitPriceCents: null,
        source: 'warehouse_savings_page',
        observedAt: '2026-08-21T15:05:00Z',
        unavailableReason: 'final_price_not_listed',
        promotionText: 'Save $6 through August 24',
      },
    });

    const files = await writeFullReport(paths, report);

    const html = readFileSync(files.htmlFile, 'utf8');
    expect(html).toContain('Final price unavailable — final_price_not_listed');
    expect(html).toContain('Promotion evidence: Save $6 through August 24');
    expect(html).toContain('warehouse_savings_page');
    expect(html).toContain('2026-08-21T15:05:00Z');
  });

  it('quotes commas, quotes, and newlines in CSV and escapes untrusted HTML text', async () => {
    const paths = appPaths(createTemporaryHome());
    const original = sampleReport();
    const row = original.rows[0];
    if (!row) throw new Error('fixture row missing');
    const report: FullRunReport = {
      ...original,
      diagnostic: 'One source said "retry", then\nfailed',
      rows: [
        {
          ...row,
          purchase: {
            ...row.purchase,
            description: '<img src=x onerror="alert(1)">, line\ntwo',
          },
        },
      ],
    };

    const files = await writeFullReport(paths, report);

    const csv = readFileSync(files.csvFile, 'utf8');
    expect(csv).toContain('"<img src=x onerror=""alert(1)"">, line\ntwo"');
    const html = readFileSync(files.htmlFile, 'utf8');
    expect(html).toContain(
      '&lt;img src=x onerror=&quot;alert(1)&quot;&gt;, line two',
    );
    expect(html).not.toContain('<img src=x');
  });

  it('atomically replaces latest files while retaining timestamped reports', async () => {
    const paths = appPaths(createTemporaryHome());
    const first = sampleReport();
    const firstFiles = await writeFullReport(paths, first);
    const priorLatestInode = statSync(
      join(paths.reportsDir, 'latest.json'),
    ).ino;
    const second: FullRunReport = {
      ...first,
      startedAt: '2026-08-22T08:09:10.011Z',
      finishedAt: '2026-08-22T08:10:00.000Z',
      outcome: 'success',
      diagnostic: null,
    };

    await writeFullReport(paths, second);

    expect(JSON.parse(readFileSync(firstFiles.jsonFile, 'utf8'))).toEqual(
      first,
    );
    expect(
      JSON.parse(readFileSync(join(paths.reportsDir, 'latest.json'), 'utf8')),
    ).toEqual(second);
    expect(statSync(join(paths.reportsDir, 'latest.json')).ino).not.toBe(
      priorLatestInode,
    );
    expect(
      readdirSync(paths.reportsDir).some((name) => name.includes('.tmp')),
    ).toBe(false);
    expect(
      JSON.parse(
        readFileSync(join(paths.reportsDir, 'latest-manifest.json'), 'utf8'),
      ),
    ).toEqual({
      schemaVersion: 1,
      startedAt: second.startedAt,
      files: {
        html: '2026-08-22T08-09-10-011Z.html',
        csv: '2026-08-22T08-09-10-011Z.csv',
        json: '2026-08-22T08-09-10-011Z.json',
      },
    });
  });

  it('keeps the manifest on the prior complete snapshot when a latest rename fails', async () => {
    const paths = appPaths(createTemporaryHome());
    const first = sampleReport();
    await writeFullReport(paths, first);
    const manifestFile = join(paths.reportsDir, 'latest-manifest.json');
    const firstManifest = readFileSync(manifestFile, 'utf8');
    const second: FullRunReport = {
      ...first,
      startedAt: '2026-08-22T08:09:10.011Z',
      finishedAt: '2026-08-22T08:10:00.000Z',
    };
    let replacements = 0;

    await expect(
      writeFullReport(paths, second, {
        rename(source, destination) {
          replacements += 1;
          if (replacements === 2) {
            throw new Error('injected latest replacement failure');
          }
          renameSync(source, destination);
        },
      }),
    ).rejects.toThrow('injected latest replacement failure');

    expect(readFileSync(manifestFile, 'utf8')).toBe(firstManifest);
    expect(
      readdirSync(paths.reportsDir).some((name) => name.includes('.tmp')),
    ).toBe(false);
  });

  it('writes an empty auth-required report with diagnostics', async () => {
    const paths = appPaths(createTemporaryHome());
    const report: FullRunReport = {
      schemaVersion: 1,
      startedAt: '2026-08-21T16:20:30.456Z',
      finishedAt: '2026-08-21T16:20:31.000Z',
      outcome: 'auth_required',
      diagnostic: 'Costco sign-in is required.',
      rows: [],
      sourceDiagnostics: [
        {
          channel: null,
          source: 'costco_orders',
          status: 'error',
          observedAt: '2026-08-21T16:20:31.000Z',
          message: 'Authentication required',
        },
      ],
    };

    const files = await writeFullReport(paths, report);

    expect(existsSync(files.jsonFile)).toBe(true);
    const csvLines = readFileSync(files.csvFile, 'utf8').trim().split('\n');
    expect(csvLines).toHaveLength(3);
    expect(csvLines[1]).toContain('run,');
    expect(csvLines[1]).toContain('auth_required');
    expect(csvLines[1]).toContain('Costco sign-in is required.');
    expect(csvLines[2]).toContain('source_diagnostic,');
    expect(csvLines[2]).toContain('costco_orders,error');
    expect(csvLines[2]).toContain('Authentication required');
    expect(new Set(csvLines.map((line) => line.split(',').length))).toEqual(
      new Set([43]),
    );
    const html = readFileSync(files.htmlFile, 'utf8');
    expect(html).toContain('Authentication required');
    expect(html).toContain('No purchase lines were available for this run.');
  });
});

function sampleReport(
  prices: ReportPriceChannels = samplePriceChannels(),
): FullRunReport {
  const row: FullReportRow = {
    purchase: {
      id: 'purchase-1',
      receiptId: 'receipt-1',
      itemNumber: '1207907',
      description: 'Kirkland, Premium "Paper"',
      warehouseNumber: '110',
      purchasedAt: '2026-08-14T18:02:03Z',
      quantity: 2,
      grossUnitCents: 1_699,
      couponCents: 200,
      paidUnitCents: 1_599,
    },
    prices,
    warehouseDeltaCents: 100,
    daysRemaining: 23,
    status: 'candidate',
    reason: null,
  };

  return {
    schemaVersion: 1,
    startedAt: '2026-08-21T16:20:30.456Z',
    finishedAt: '2026-08-21T16:21:00.000Z',
    outcome: 'partial_failure',
    diagnostic: 'Same-Day price was unavailable.',
    rows: [row],
    sourceDiagnostics: [
      {
        channel: 'same_day',
        source: 'same_day',
        status: 'unavailable',
        observedAt: '2026-08-21T16:20:50.000Z',
        message: 'Same-Day source unavailable',
      },
    ],
  };
}

function samplePriceChannels(): ReportPriceChannels {
  return {
    warehouse: availablePrice('warehouse', 1_499, 'verified_warehouse_api'),
    receiptHistory: {
      ...availablePrice('receipt_history', 1_599, 'receipt_history'),
      observedAt: '2026-08-14T18:02:03Z',
    },
    warehouseSavings: {
      ...availablePrice('warehouse_savings', 1_449, 'warehouse_savings_page'),
      observedAt: '2026-08-21T15:05:00Z',
      promotionText: 'Save $3, warehouse only',
    },
    costcoCom: {
      ...availablePrice('costco_com', 1_799, 'costco.com'),
      observedAt: '2026-08-21T15:06:00Z',
    },
    sameDay: unavailablePrice('same_day', 'not_available'),
  };
}

function availablePrice(
  channel:
    | 'warehouse'
    | 'receipt_history'
    | 'warehouse_savings'
    | 'costco_com'
    | 'same_day',
  unitPriceCents: number,
  source: string,
) {
  return {
    channel,
    unitPriceCents,
    source,
    observedAt: '2026-08-21T15:00:00Z',
    unavailableReason: null,
    promotionText: null,
  } as const;
}

function unavailablePrice(
  channel:
    | 'warehouse'
    | 'receipt_history'
    | 'warehouse_savings'
    | 'costco_com'
    | 'same_day',
  unavailableReason: string,
) {
  return {
    channel,
    unitPriceCents: null,
    source: null,
    observedAt: null,
    unavailableReason,
    promotionText: null,
  } as const;
}
