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
    const report = mixedReport();

    const files = await writeFullReport(paths, report);

    expect(basename(files.jsonFile)).toBe('2026-08-21T16-20-30-456Z.json');
    expect(basename(files.csvFile)).toBe('2026-08-21T16-20-30-456Z.csv');
    expect(basename(files.htmlFile)).toBe('2026-08-21T16-20-30-456Z.html');

    const json = JSON.parse(readFileSync(files.jsonFile, 'utf8')) as unknown;
    expect(json).toEqual(report);

    const csv = readFileSync(files.csvFile, 'utf8');
    const [csvHeader = ''] = csv.split('\n');
    expect(csvHeader.split(',')).toEqual(
      expect.arrayContaining([
        'purchase_channel',
        'receipt_or_order',
        'comparison_channel',
        'comparison_price',
        'unit_delta',
        'potential_savings',
        'warehouse_purchase_lines',
        'online_purchase_lines',
      ]),
    );
    expect(csv).toContain(
      'purchase,1207907,"Kirkland, Premium ""Paper""",110,2026-08-14T18:02:03Z,2,$16.99,$2.00,$15.99,$14.99,verified_warehouse_api,2026-08-21T15:00:00Z,,$15.99,receipt_history,2026-08-14T18:02:03Z,,$14.49,"Save $3, warehouse only",warehouse_savings_page',
    );
    expect(csv).toContain(
      'costco_com,costco.com:order-fixture-2,costco_com,$16.99,$3.00,$9.00',
    );

    const html = readFileSync(files.htmlFile, 'utf8');
    expect(html).toContain('<!doctype html>');
    expect(html).toContain('<caption>Purchase-line price comparison</caption>');
    expect(html).not.toContain('Unique item summary');
    expect(html).toContain('<strong>Warehouse purchase lines:</strong> 1');
    expect(html).toContain('<strong>Costco.com purchase lines:</strong> 1');
    expect(html).toContain('Purchase channel');
    expect(html).toContain('Receipt / order');
    expect(html).toContain('Comparison channel');
    expect(html).toContain('Comparison price');
    expect(html).toContain('Unit delta');
    expect(html).toContain('Potential savings');
    expect(html).toContain('Warehouse Savings');
    expect(html).toContain('Costco.com');
    expect(html).toContain('Same-Day');
    expect(html).toContain('Kirkland, Premium &quot;Paper&quot;');
    const onlineRow = htmlRowForItem(html, '200001');
    expect(onlineRow).toContain('<td>Costco.com</td>');
    expect(onlineRow).not.toContain('Warehouse 847');
    expect(onlineRow.match(/not_applicable/gu)).toHaveLength(4);
    expect(onlineRow).toContain('<td>$16.99</td>');
    expect(onlineRow).toContain('<td>$3.00</td>');
    expect(onlineRow).toContain('<td>$9.00</td>');
    const warehouseRow = htmlRowForItem(html, '1207907');
    expect(warehouseRow).toContain('<td>Warehouse</td>');
    expect(warehouseRow).toContain('Warehouse 110');
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
          comparisonChannel: null,
          comparisonUnitCents: null,
          comparisonDeltaCents: null,
          potentialSavingsCents: null,
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

  it('labels the inverse-markup Same-Day estimate as estimated, never verified warehouse pricing', async () => {
    const paths = appPaths(createTemporaryHome());
    const original = sampleReport({
      ...samplePriceChannels(),
      warehouse: unavailablePrice('warehouse', 'not_warehouse_price'),
      sameDay: availablePrice('same_day', 1_531, 'costco_same_day_zip_98029'),
    });
    const originalRow = original.rows[0];
    if (!originalRow) throw new Error('fixture row missing');
    const report: FullRunReport = {
      ...original,
      rows: [
        {
          ...originalRow,
          comparisonChannel: 'same_day',
          comparisonUnitCents: 1_349,
          comparisonDeltaCents: 250,
          potentialSavingsCents: 500,
          sameDayWarehouseEstimateCents: 1_349,
          sameDayMarkupPercent: 13.5,
          sameDayEstimatedDeltaCents: 250,
          warehouseDeltaCents: null,
          status: 'estimated_opportunity',
          reason: 'same_day_estimate_lower_manual_verification_required',
        },
      ],
    };

    const files = await writeFullReport(paths, report);
    const csv = readFileSync(files.csvFile, 'utf8');
    const html = readFileSync(files.htmlFile, 'utf8');

    expect(csv).toContain('$15.31,costco_same_day_zip_98029');
    expect(csv).toContain(
      '$13.49,13.5%,$2.50,Unavailable,23,estimated_opportunity',
    );
    expect(html).toContain('Same-Day corrected warehouse estimate (13.5%)');
    expect(html).toContain('$13.49');
    expect(html).toContain('estimated_opportunity');
    expect(html).toContain('Manual warehouse verification required');
    expect(html).toContain('Current warehouse');
    expect(html).toContain('Unavailable — not_warehouse_price');
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
    const originalRow = original.rows[0];
    if (!originalRow) throw new Error('fixture row missing');

    await expect(
      writeFullReport(paths, {
        ...original,
        rows: [
          {
            ...originalRow,
            comparisonChannel: null,
            comparisonUnitCents: null,
            comparisonDeltaCents: null,
            potentialSavingsCents: null,
          },
        ],
      }),
    ).rejects.toThrow(/candidate.*current warehouse/i);
  });

  it('accepts an online candidate only with an exact lower Costco.com comparison', async () => {
    const paths = appPaths(createTemporaryHome());
    const report = mixedReport();
    const onlineRow = report.rows[1];
    if (!onlineRow) throw new Error('online fixture row missing');

    await expect(
      writeFullReport(paths, { ...report, rows: [onlineRow] }),
    ).resolves.toBeDefined();
  });

  it('rejects a cross-channel online candidate comparison', async () => {
    const paths = appPaths(createTemporaryHome());
    const report = mixedReport();
    const onlineRow = report.rows[1];
    if (!onlineRow) throw new Error('online fixture row missing');

    await expect(
      writeFullReport(paths, {
        ...report,
        rows: [{ ...onlineRow, comparisonChannel: 'warehouse' }],
      }),
    ).rejects.toThrow(/Costco\.com.*comparison/i);
  });

  it('rejects a Costco.com comparison for a warehouse purchase', async () => {
    const paths = appPaths(createTemporaryHome());
    const report = sampleReport();
    const row = report.rows[0];
    if (!row) throw new Error('warehouse fixture row missing');

    await expect(
      writeFullReport(paths, {
        ...report,
        rows: [{ ...row, comparisonChannel: 'costco_com' }],
      }),
    ).rejects.toThrow(/warehouse.*comparison/i);
  });

  it('rejects obsolete report schema versions', async () => {
    const paths = appPaths(createTemporaryHome());
    const report = sampleReport();

    await expect(
      writeFullReport(paths, { ...report, schemaVersion: 1 as 2 }),
    ).rejects.toThrow(/schema version 2/i);
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
      schemaVersion: 2,
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
      schemaVersion: 2,
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
      new Set([csvLines[0]?.split(',').length]),
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
      purchaseChannel: 'warehouse',
    },
    prices,
    comparisonChannel: 'warehouse',
    comparisonUnitCents: 1_499,
    comparisonDeltaCents: 100,
    potentialSavingsCents: 200,
    sameDayWarehouseEstimateCents: null,
    sameDayMarkupPercent: 13.5,
    sameDayEstimatedDeltaCents: null,
    warehouseDeltaCents: 100,
    daysRemaining: 23,
    status: 'candidate',
    reason: null,
  };

  return {
    schemaVersion: 2,
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

function mixedReport(): FullRunReport {
  const warehouseReport = sampleReport();
  const onlineRow: FullReportRow = {
    purchase: {
      couponCents: 0,
      description: 'Costco.com Coffee',
      grossUnitCents: 1_999,
      id: 'online-purchase-fixture-2',
      itemNumber: '200001',
      paidUnitCents: 1_999,
      purchaseChannel: 'costco_com',
      purchasedAt: '2026-08-15T12:00:00Z',
      quantity: 3,
      receiptId: 'costco.com:order-fixture-2',
      warehouseNumber: '847',
    },
    prices: {
      warehouse: unavailablePrice('warehouse', 'not_applicable'),
      receiptHistory: unavailablePrice('receipt_history', 'not_applicable'),
      warehouseSavings: unavailablePrice('warehouse_savings', 'not_applicable'),
      costcoCom: availablePrice('costco_com', 1_699, 'costco_product_api'),
      sameDay: unavailablePrice('same_day', 'not_applicable'),
    },
    comparisonChannel: 'costco_com',
    comparisonUnitCents: 1_699,
    comparisonDeltaCents: 300,
    potentialSavingsCents: 900,
    sameDayWarehouseEstimateCents: null,
    sameDayMarkupPercent: 13.5,
    sameDayEstimatedDeltaCents: null,
    warehouseDeltaCents: null,
    daysRemaining: 17,
    status: 'candidate',
    reason: null,
  };
  return { ...warehouseReport, rows: [...warehouseReport.rows, onlineRow] };
}

function htmlRowForItem(html: string, itemNumber: string): string {
  const rows = html.match(/<tr>[\s\S]*?<\/tr>/gu) ?? [];
  const row = rows.find((candidate) => candidate.includes(`>${itemNumber}<`));
  if (!row) throw new Error(`HTML row missing for ${itemNumber}`);
  return row;
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
