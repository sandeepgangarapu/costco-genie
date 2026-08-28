import {
  execFile as nodeExecFile,
  spawn as nodeSpawn,
} from 'node:child_process';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AppConfig } from '../src/config/config.js';
import { DEFAULT_CONFIG } from '../src/config/config.js';
import { AuthRequiredError } from '../src/costco/errors.js';
import type {
  FullRunReport,
  PriceObservation,
  RunSummary,
} from '../src/domain/types.js';
import { runPriceCheck, type RunDependencies } from '../src/app/run.js';
import { Database } from '../src/storage/database.js';
import { FileRunLock, RunOverlapError } from '../src/lib/process.js';

vi.mock('node:child_process', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:child_process')>();
  const childProcessError = () => {
    throw new Error('FileRunLock must not start a child/helper process');
  };

  return {
    ...original,
    execFile: vi.fn(childProcessError),
    spawn: vi.fn(childProcessError),
  };
});

const temporaryDirectories: string[] = [];
const NOW = new Date('2026-08-18T16:00:00.000Z');
const LIVE_RECEIPT = {
  couponArray: [
    {
      amountCoupon: '-2.00',
      associatedItemNumber: '100978861',
    },
  ],
  itemArray: [
    {
      amount: '19.98',
      itemDescription01: 'Kirkland Trail Mix',
      itemNumber: '100978861',
      unit: '2',
    },
  ],
  registerNumber: '7',
  transactionBarcode: '211290123456789',
  transactionDateTime: '2026-08-10T18:30:00.000Z',
  transactionNumber: '4567',
  transactionType: 'Purchase',
  warehouseNumber: '129',
};

class FakeLocalNotifier {
  readonly messages: Array<{ body: string; title: string }> = [];
  error: Error | null = null;

  async send(title: string, body: string): Promise<void> {
    if (this.error) throw this.error;
    this.messages.push({ body, title });
  }
}

class FakeMailNotifier {
  readonly messages: Array<{
    recipient: string;
    subject: string;
    text: string;
  }> = [];
  error: Error | null = null;
  resolveCalls = 0;

  async resolveSelfRecipient(): Promise<string> {
    this.resolveCalls += 1;
    return 'self@example.com';
  }

  async send(recipient: string, subject: string, text: string): Promise<void> {
    if (this.error) throw this.error;
    this.messages.push({ recipient, subject, text });
  }
}

function createDatabase(): Database {
  const directory = mkdtempSync(join(tmpdir(), 'costco-run-test-'));
  temporaryDirectories.push(directory);
  return Database.open(join(directory, 'costco.sqlite'));
}

function resolvedObservation(
  itemNumber = '100978861',
  unitPriceCents: number | null = 799,
): PriceObservation {
  return {
    itemNumber,
    observedAt: NOW.toISOString(),
    source: 'warehouse-price-api',
    unitPriceCents,
    unresolvedReason: unitPriceCents === null ? 'batch_failed' : null,
    warehouseNumber: '129',
  };
}

function dependencies(
  options: {
    config?: AppConfig;
    database?: Database;
    fetchPrices?: RunDependencies['fetchWarehousePrices'];
    fetchReceipts?: RunDependencies['fetchReceipts'];
    local?: FakeLocalNotifier;
    mail?: FakeMailNotifier;
    readTokens?: RunDependencies['readCostcoTokens'];
    fetchEvidence?: RunDependencies['fetchReportPriceEvidence'];
    writeReport?: RunDependencies['writeFullReport'];
    createTimeoutSignal?: (timeoutMilliseconds: number) => AbortSignal;
  } = {},
): RunDependencies & {
  database: Database;
  localNotifier: FakeLocalNotifier;
  mailNotifier: FakeMailNotifier;
} {
  const database = options.database ?? createDatabase();
  const localNotifier = options.local ?? new FakeLocalNotifier();
  const mailNotifier = options.mail ?? new FakeMailNotifier();

  return {
    config: options.config ?? DEFAULT_CONFIG,
    ...(options.createTimeoutSignal === undefined
      ? {}
      : { createTimeoutSignal: options.createTimeoutSignal }),
    database,
    fetchReceipts: options.fetchReceipts ?? (async () => [LIVE_RECEIPT]),
    fetchWarehousePrices:
      options.fetchPrices ?? (async () => [resolvedObservation()]),
    ...(options.fetchEvidence === undefined
      ? {}
      : { fetchReportPriceEvidence: options.fetchEvidence }),
    localNotifier,
    lock: {
      async runExclusive<T>(action: () => Promise<T>): Promise<T> {
        return action();
      },
    },
    mailNotifier,
    readCostcoTokens:
      options.readTokens ??
      (async () => ({ clientId: 'client-id', idToken: 'id-token' })),
    writeFullReport:
      options.writeReport ??
      (async () => ({
        htmlFile: '/reports/run.html',
        csvFile: '/reports/run.csv',
        jsonFile: '/reports/run.json',
      })),
  };
}

afterEach(() => {
  vi.clearAllMocks();
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe('FileRunLock', () => {
  it('holds the lock in the parent process without starting a child/helper process', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'costco-run-lock-test-'));
    temporaryDirectories.push(directory);
    const lockPath = join(directory, 'run.lock');
    const calls: string[] = [];
    const operations = {
      async close(fd: number) {
        calls.push(`close:${String(fd)}`);
      },
      async flock(fd: number, operation: 'exnb' | 'un') {
        calls.push(`flock:${String(fd)}:${operation}`);
      },
      async open(path: string) {
        calls.push(`open:${path}`);
        return 42;
      },
    };

    const result = await new FileRunLock(lockPath, {
      operations,
    }).runExclusive(async () => {
      calls.push('action');
      return 'done';
    });

    expect(result).toBe('done');
    expect(calls).toEqual([
      `open:${lockPath}`,
      'flock:42:exnb',
      'action',
      'flock:42:un',
      'close:42',
    ]);
    expect(nodeSpawn).not.toHaveBeenCalled();
    expect(nodeExecFile).not.toHaveBeenCalled();
  });

  it('allows exactly one real nonblocking contender to start while the winner is held open', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'costco-run-lock-test-'));
    temporaryDirectories.push(directory);
    const lockPath = join(directory, 'run.lock');
    const lockA = new FileRunLock(lockPath);
    const lockB = new FileRunLock(lockPath);
    let executions = 0;
    let releaseWinner: (() => void) | undefined;
    const action = async () => {
      executions += 1;
      await new Promise<void>((resolve) => {
        releaseWinner = resolve;
      });
      return 'winner';
    };

    const contenders = [lockA.runExclusive(action), lockB.runExclusive(action)];
    const overlap = await Promise.race(
      contenders.map(async (contender) => {
        try {
          await contender;
          return null;
        } catch (error) {
          return error;
        }
      }),
    );

    expect(overlap).toBeInstanceOf(RunOverlapError);
    expect(executions).toBe(1);
    releaseWinner?.();

    const results = await Promise.allSettled(contenders);
    expect(
      results.filter((result) => result.status === 'fulfilled'),
    ).toHaveLength(1);
    const rejection = results.find((result) => result.status === 'rejected');
    expect(rejection).toMatchObject({
      reason: expect.any(RunOverlapError),
      status: 'rejected',
    });
  });

  it('reacquires sequentially while the stable lock file remains', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'costco-run-lock-test-'));
    temporaryDirectories.push(directory);
    const lockPath = join(directory, 'run.lock');
    const lock = new FileRunLock(lockPath);

    await expect(lock.runExclusive(async () => 'first')).resolves.toBe('first');
    expect(existsSync(lockPath)).toBe(true);
    await expect(lock.runExclusive(async () => 'second')).resolves.toBe(
      'second',
    );
    expect(existsSync(lockPath)).toBe(true);
  });

  it('creates and hardens the stable lock file to owner-only access', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'costco-run-lock-test-'));
    temporaryDirectories.push(directory);
    const lockPath = join(directory, 'run.lock');
    writeFileSync(lockPath, '', { mode: 0o666 });
    chmodSync(lockPath, 0o666);

    await new FileRunLock(lockPath).runExclusive(async () => undefined);

    expect(lstatSync(lockPath).mode & 0o777).toBe(0o600);
  });

  it('rejects symlink and wrong-type lock targets without following them', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'costco-run-lock-test-'));
    temporaryDirectories.push(directory);
    const target = join(directory, 'outside.lock');
    const symlink = join(directory, 'run.lock');
    const wrongType = join(directory, 'wrong.lock');
    writeFileSync(target, 'outside', { mode: 0o644 });
    chmodSync(target, 0o644);
    symlinkSync(target, symlink);
    mkdirSync(wrongType);
    let actions = 0;

    await expect(
      new FileRunLock(symlink).runExclusive(async () => {
        actions += 1;
      }),
    ).rejects.toThrow(/unsafe|symbolic link/i);
    await expect(
      new FileRunLock(wrongType).runExclusive(async () => {
        actions += 1;
      }),
    ).rejects.toThrow(/regular file|unsafe/i);
    expect(actions).toBe(0);
    expect(lstatSync(target).mode & 0o777).toBe(0o644);
  });

  it('releases the real lock when the protected action rejects', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'costco-run-lock-test-'));
    temporaryDirectories.push(directory);
    const lockPath = join(directory, 'run.lock');
    const actionError = new Error('protected action failed');

    await expect(
      new FileRunLock(lockPath).runExclusive(async () => {
        throw actionError;
      }),
    ).rejects.toBe(actionError);
    await expect(
      new FileRunLock(lockPath).runExclusive(async () => 'reacquired'),
    ).resolves.toBe('reacquired');
  });

  it.each(['EAGAIN', 'EWOULDBLOCK'])(
    'maps %s nonblocking contention to RunOverlapError without starting the action',
    async (code) => {
      const contention = Object.assign(new Error('lock is held'), { code });
      const calls: string[] = [];
      let actionStarted = false;
      const lock = new FileRunLock('/tmp/costco-run.lock', {
        operations: {
          async close(fd: number) {
            calls.push(`close:${String(fd)}`);
          },
          async flock(fd: number, operation: 'exnb' | 'un') {
            calls.push(`flock:${String(fd)}:${operation}`);
            if (operation === 'exnb') throw contention;
          },
          async open() {
            calls.push('open');
            return 7;
          },
        },
      });

      const result = lock.runExclusive(async () => {
        actionStarted = true;
      });

      await expect(result).rejects.toMatchObject({
        cause: contention,
        name: 'RunOverlapError',
      });
      expect(actionStarted).toBe(false);
      expect(calls).toEqual(['open', 'flock:7:exnb', 'close:7']);
    },
  );

  it('propagates a non-contention acquire error, closes the fd, and never starts the action', async () => {
    const acquireError = Object.assign(new Error('flock failed'), {
      code: 'EIO',
    });
    const closeError = new Error('close also failed');
    const calls: string[] = [];
    let actionStarted = false;
    const lock = new FileRunLock('/tmp/costco-run.lock', {
      operations: {
        async close(fd: number) {
          calls.push(`close:${String(fd)}`);
          throw closeError;
        },
        async flock(fd: number, operation: 'exnb' | 'un') {
          calls.push(`flock:${String(fd)}:${operation}`);
          throw acquireError;
        },
        async open() {
          calls.push('open');
          return 8;
        },
      },
    });

    const result = lock.runExclusive(async () => {
      actionStarted = true;
    });

    await expect(result).rejects.toBe(acquireError);
    expect(actionStarted).toBe(false);
    expect(calls).toEqual(['open', 'flock:8:exnb', 'close:8']);
  });

  it('propagates an open error without attempting acquisition or starting the action', async () => {
    const openError = new Error('open failed');
    const calls: string[] = [];
    let actionStarted = false;
    const lock = new FileRunLock('/tmp/costco-run.lock', {
      operations: {
        async close(fd: number) {
          calls.push(`close:${String(fd)}`);
        },
        async flock(fd: number, operation: 'exnb' | 'un') {
          calls.push(`flock:${String(fd)}:${operation}`);
        },
        async open() {
          calls.push('open');
          throw openError;
        },
      },
    });

    const result = lock.runExclusive(async () => {
      actionStarted = true;
    });

    await expect(result).rejects.toBe(openError);
    expect(actionStarted).toBe(false);
    expect(calls).toEqual(['open']);
  });

  it('does not mask an action error when unlock and close also fail', async () => {
    const actionError = new Error('action failed');
    const calls: string[] = [];
    const lock = new FileRunLock('/tmp/costco-run.lock', {
      operations: {
        async close(fd: number) {
          calls.push(`close:${String(fd)}`);
          throw new Error('close failed');
        },
        async flock(fd: number, operation: 'exnb' | 'un') {
          calls.push(`flock:${String(fd)}:${operation}`);
          if (operation === 'un') throw new Error('unlock failed');
        },
        async open() {
          calls.push('open');
          return 9;
        },
      },
    });

    const result = lock.runExclusive(async () => {
      calls.push('action');
      throw actionError;
    });

    await expect(result).rejects.toBe(actionError);
    expect(calls).toEqual([
      'open',
      'flock:9:exnb',
      'action',
      'flock:9:un',
      'close:9',
    ]);
  });

  it('reports an unlock error after a successful action and still closes the fd', async () => {
    const unlockError = new Error('unlock failed');
    const closeError = new Error('close failed');
    const calls: string[] = [];
    const lock = new FileRunLock('/tmp/costco-run.lock', {
      operations: {
        async close(fd: number) {
          calls.push(`close:${String(fd)}`);
          throw closeError;
        },
        async flock(fd: number, operation: 'exnb' | 'un') {
          calls.push(`flock:${String(fd)}:${operation}`);
          if (operation === 'un') throw unlockError;
        },
        async open() {
          calls.push('open');
          return 10;
        },
      },
    });

    const result = lock.runExclusive(async () => {
      calls.push('action');
      return 'done';
    });

    await expect(result).rejects.toBe(unlockError);
    expect(calls).toEqual([
      'open',
      'flock:10:exnb',
      'action',
      'flock:10:un',
      'close:10',
    ]);
  });

  it('reports a close error after a successful action and successful unlock', async () => {
    const closeError = new Error('close failed');
    const calls: string[] = [];
    const lock = new FileRunLock('/tmp/costco-run.lock', {
      operations: {
        async close(fd: number) {
          calls.push(`close:${String(fd)}`);
          throw closeError;
        },
        async flock(fd: number, operation: 'exnb' | 'un') {
          calls.push(`flock:${String(fd)}:${operation}`);
        },
        async open() {
          calls.push('open');
          return 11;
        },
      },
    });

    const result = lock.runExclusive(async () => {
      calls.push('action');
      return 'done';
    });

    await expect(result).rejects.toBe(closeError);
    expect(calls).toEqual([
      'open',
      'flock:11:exnb',
      'action',
      'flock:11:un',
      'close:11',
    ]);
  });
});

describe('runPriceCheck', () => {
  it('writes a full all-line report with separated live channels and historical receipt evidence', async () => {
    const reports: FullRunReport[] = [];
    const earlier = {
      ...LIVE_RECEIPT,
      transactionBarcode: 'earlier',
      transactionDateTime: '2026-08-10T18:30:00.000Z',
    };
    const later = {
      ...LIVE_RECEIPT,
      couponArray: [],
      itemArray: [
        {
          ...LIVE_RECEIPT.itemArray[0],
          amount: '15.98',
        },
      ],
      transactionBarcode: 'later',
      transactionDateTime: '2026-08-14T18:30:00.000Z',
    };
    const deps = dependencies({
      fetchEvidence: async () => ({
        diagnostics: [
          {
            channel: 'warehouse_savings',
            message: 'Warehouse Savings refreshed',
            observedAt: NOW.toISOString(),
            source: 'warehouse_savings_page',
            status: 'ok',
          },
        ],
        items: [
          {
            itemNumber: '100978861',
            warehouseNumber: '129',
            prices: {
              warehouse: {
                channel: 'warehouse',
                observedAt: NOW.toISOString(),
                promotionText: null,
                source: 'warehouse_savings_page',
                unavailableReason: null,
                unitPriceCents: 749,
              },
              warehouseSavings: {
                channel: 'warehouse_savings',
                observedAt: NOW.toISOString(),
                promotionText: '$7.49 after $2.50 off',
                source: 'warehouse_savings_page',
                unavailableReason: null,
                unitPriceCents: 749,
              },
              costcoCom: {
                channel: 'costco_com',
                observedAt: NOW.toISOString(),
                promotionText: null,
                source: 'costco_product_api',
                unavailableReason: null,
                unitPriceCents: 1099,
              },
              sameDay: {
                channel: 'same_day',
                observedAt: null,
                promotionText: null,
                source: null,
                unavailableReason: 'source_not_configured',
                unitPriceCents: null,
              },
            },
          },
        ],
      }),
      fetchReceipts: async () => [earlier, later],
      writeReport: async (report) => {
        reports.push(report);
        return {
          htmlFile: '/reports/full.html',
          csvFile: '/reports/full.csv',
          jsonFile: '/reports/full.json',
        };
      },
    });

    const summary = await runPriceCheck(deps, { now: () => NOW });

    expect(summary.reportFiles).toEqual({
      htmlFile: '/reports/full.html',
      csvFile: '/reports/full.csv',
      jsonFile: '/reports/full.json',
    });
    expect(reports).toHaveLength(1);
    expect(reports[0]?.rows).toHaveLength(2);
    expect(reports[0]?.rows[0]).toMatchObject({
      purchase: { grossUnitCents: 999, paidUnitCents: 899 },
      prices: {
        receiptHistory: {
          channel: 'receipt_history',
          unitPriceCents: 799,
          observedAt: '2026-08-14T18:30:00.000Z',
        },
        warehouse: { unitPriceCents: 749 },
        warehouseSavings: { unitPriceCents: 749 },
        costcoCom: { unitPriceCents: 1099 },
        sameDay: { unitPriceCents: null },
      },
      status: 'candidate',
    });
    expect(reports[0]?.rows[1]?.prices.receiptHistory).toMatchObject({
      unitPriceCents: null,
      unavailableReason: 'no_later_receipt',
    });
    deps.database.close();
  });

  it('requests receipt and eligibility windows from the injected Mac-local calendar day', async () => {
    const westCoastNow = new (class extends Date {
      override getFullYear() {
        return 2026;
      }
      override getMonth() {
        return 7;
      }
      override getDate() {
        return 18;
      }
    })('2026-08-19T06:30:00.000Z');
    let requestedDates: { endDate: string; startDate: string } | undefined;
    const deps = dependencies({
      fetchReceipts: async (_tokens, startDate, endDate) => {
        requestedDates = { endDate, startDate };
        return [];
      },
      fetchPrices: async () => [],
    });

    const summary = await runPriceCheck(deps, { now: () => westCoastNow });

    expect(requestedDates).toEqual({
      endDate: '2026-08-18',
      startDate: '2026-07-14',
    });
    expect(summary.outcome).toBe('success');
    deps.database.close();
  });

  it('alerts separately on a ZIP-localized Same-Day estimate when verified warehouse pricing is unavailable', async () => {
    const reports: FullRunReport[] = [];
    const unavailable = (
      channel: 'warehouse' | 'warehouse_savings' | 'costco_com',
    ) =>
      ({
        channel,
        observedAt: NOW.toISOString(),
        promotionText: null,
        source: channel === 'warehouse' ? 'warehouse-price-api' : null,
        unavailableReason: 'not_available',
        unitPriceCents: null,
      }) as const;
    const deps = dependencies({
      fetchEvidence: async (_requests, options) => {
        expect(options.sameDayMarkupPercent).toBe(13.5);
        expect(options.sameDayPostalCode).toBe('98029');
        expect(options.sameDayRepresentativeAddress).toBe(
          '2520 NE Park Dr, Issaquah, WA 98029',
        );
        return {
          diagnostics: [],
          items: [
            {
              itemNumber: '100978861',
              warehouseNumber: '129',
              prices: {
                warehouse: unavailable('warehouse'),
                warehouseSavings: unavailable('warehouse_savings'),
                costcoCom: unavailable('costco_com'),
                sameDay: {
                  channel: 'same_day',
                  observedAt: NOW.toISOString(),
                  promotionText: null,
                  source: 'costco_same_day_zip_98029',
                  unavailableReason: null,
                  unitPriceCents: 900,
                },
              },
            },
          ],
        };
      },
      writeReport: async (report) => {
        reports.push(report);
        return {
          htmlFile: '/reports/full.html',
          csvFile: '/reports/full.csv',
          jsonFile: '/reports/full.json',
        };
      },
    });

    const summary = await runPriceCheck(deps, { now: () => NOW });

    expect(summary).toMatchObject({
      candidatesFound: 0,
      estimatedOpportunitiesFound: 1,
      alertsSent: 1,
    });
    expect(deps.localNotifier.messages[0]?.body).toMatch(/estimated/i);
    expect(deps.localNotifier.messages[0]?.body).toMatch(/verify/i);
    expect(deps.mailNotifier.messages[0]?.text).toMatch(/estimated/i);
    expect(reports[0]?.rows[0]).toMatchObject({
      sameDayWarehouseEstimateCents: 793,
      sameDayMarkupPercent: 13.5,
      sameDayEstimatedDeltaCents: 106,
      warehouseDeltaCents: null,
      status: 'estimated_opportunity',
      reason: 'same_day_estimate_lower_manual_verification_required',
    });
    const storedPurchase = deps.database.recentPurchases('2026-01-01')[0];
    expect(storedPurchase).toBeDefined();
    expect(
      deps.database.getChannelAlertState(
        'local',
        `${storedPurchase?.id ?? ''}:same_day_estimate`,
      ),
    ).toMatchObject({ lastNotifiedPriceCents: 793 });
    expect(
      deps.database.getChannelAlertState('local', storedPurchase?.id ?? ''),
    ).toBeNull();
    deps.database.close();
  });

  it('adapts live receipts, checks their same-warehouse price, delivers both reports, and persists both channel states', async () => {
    let receivedRequests: unknown;
    let receivedBatchSize: unknown;
    const deps = dependencies({
      fetchPrices: async (requests, options) => {
        receivedRequests = requests;
        receivedBatchSize = options.batchSize;
        return [resolvedObservation()];
      },
    });

    const summary = await runPriceCheck(deps, { now: () => NOW });

    expect(receivedRequests).toEqual([
      {
        description: 'Kirkland Trail Mix',
        itemNumber: '100978861',
        purchaseChannel: 'warehouse',
        warehouseNumber: '129',
      },
    ]);
    expect(receivedBatchSize).toBe(25);
    expect(summary).toMatchObject({
      alertsSent: 1,
      candidatesFound: 1,
      observationsRecorded: 1,
      outcome: 'success',
      purchasesProcessed: 1,
      unresolvedPrices: 0,
    });
    expect(summary.notifications).toEqual({
      email: { attempted: true, delivered: 1, error: null },
      local: { attempted: true, delivered: 1, error: null },
    });
    expect(deps.localNotifier.messages[0]?.body).toContain(
      'Kirkland Trail Mix',
    );
    expect(deps.localNotifier.messages[0]?.body).toContain(
      '1 potential adjustment',
    );
    expect(deps.localNotifier.messages[0]?.body).not.toContain('Paid:');
    expect(deps.mailNotifier.messages[0]).toMatchObject({
      recipient: 'self@example.com',
      subject: 'Potential Costco price adjustments',
    });
    expect(deps.mailNotifier.messages[0]?.text).toContain('Kirkland Trail Mix');
    expect(deps.mailNotifier.messages[0]?.text).toContain('Paid: $8.99');
    expect(deps.mailNotifier.messages[0]?.text).not.toContain(
      '<!doctype html>',
    );
    const purchase = deps.database.recentPurchases(
      '2026-08-01T00:00:00.000Z',
    )[0];
    expect(purchase?.paidUnitCents).toBe(899);
    expect(
      deps.database.getChannelAlertState('local', purchase?.id ?? ''),
    ).toMatchObject({ lastNotifiedPriceCents: 799 });
    expect(
      deps.database.getChannelAlertState('email', purchase?.id ?? ''),
    ).toMatchObject({ lastNotifiedPriceCents: 799 });
    expect(deps.database.getLastSuccessfulRun()).toEqual(summary);
    deps.database.close();
  });

  it('keeps a usable receipt description when duplicate price requests are collapsed', async () => {
    let receivedRequests: unknown;
    const deps = dependencies({
      fetchPrices: async (requests) => {
        receivedRequests = requests;
        return [resolvedObservation('692731', 1_917)];
      },
      fetchReceipts: async () => [
        {
          ...LIVE_RECEIPT,
          couponArray: [],
          itemArray: [
            {
              amount: '19.98',
              itemDescription01: 'KS ORG EVOO',
              itemNumber: '692731',
              unit: '1',
            },
            {
              amount: '19.98',
              itemNumber: '692731',
              unit: '1',
            },
          ],
        },
      ],
    });

    await runPriceCheck(deps, { now: () => NOW });

    expect(receivedRequests).toEqual([
      {
        description: 'KS ORG EVOO',
        itemNumber: '692731',
        purchaseChannel: 'warehouse',
        warehouseNumber: '129',
      },
    ]);
    deps.database.close();
  });

  it('applies the 30-second application timeout policy to receipt and price boundaries', async () => {
    const requestedTimeouts: number[] = [];
    const signals: AbortSignal[] = [];
    let receiptSignal: AbortSignal | undefined;
    let priceTimeout: number | undefined;
    let priceSignalFactory:
      ((timeoutMilliseconds: number) => AbortSignal) | undefined;
    const createTimeoutSignal = (timeoutMilliseconds: number) => {
      requestedTimeouts.push(timeoutMilliseconds);
      const signal = new AbortController().signal;
      signals.push(signal);
      return signal;
    };
    const deps = dependencies({
      createTimeoutSignal,
      fetchPrices: async (_requests, options) => {
        priceTimeout = options.timeoutMilliseconds;
        priceSignalFactory = options.createTimeoutSignal;
        return [resolvedObservation()];
      },
      fetchReceipts: async (_tokens, _start, _end, signal) => {
        receiptSignal = signal;
        return [LIVE_RECEIPT];
      },
    });

    await runPriceCheck(deps, { now: () => NOW });

    expect(requestedTimeouts).toEqual([30_000]);
    expect(receiptSignal).toBe(signals[0]);
    expect(priceTimeout).toBe(30_000);
    expect(priceSignalFactory).toBe(createTimeoutSignal);
    deps.database.close();
  });

  it('skips a scheduled run when the previous success is less than 20 hours old', async () => {
    const deps = dependencies({
      fetchReceipts: async () => {
        throw new Error('receipt access must not happen');
      },
    });
    const prior = {
      alertsSent: 0,
      candidatesFound: 0,
      finishedAt: '2026-08-17T21:00:01.000Z',
      observationsRecorded: 0,
      outcome: 'success' as const,
      purchasesProcessed: 0,
      startedAt: '2026-08-17T21:00:00.000Z',
      unresolvedPrices: 0,
    };
    deps.database.finishRun(deps.database.beginRun(prior.startedAt), prior);

    const summary = await runPriceCheck(deps, {
      now: () => NOW,
      scheduled: true,
    });

    expect(summary.outcome).toBe('skipped');
    expect(deps.localNotifier.messages).toEqual([]);
    expect(deps.mailNotifier.messages).toEqual([]);
    deps.database.close();
  });

  it('runs at the exact 20-hour scheduled freshness boundary', async () => {
    const deps = dependencies();
    const prior = {
      alertsSent: 0,
      candidatesFound: 0,
      finishedAt: '2026-08-17T20:00:00.000Z',
      observationsRecorded: 0,
      outcome: 'success' as const,
      purchasesProcessed: 0,
      startedAt: '2026-08-17T19:59:00.000Z',
      unresolvedPrices: 0,
    };
    deps.database.finishRun(deps.database.beginRun(prior.startedAt), prior);

    const summary = await runPriceCheck(deps, {
      now: () => NOW,
      scheduled: true,
    });

    expect(summary.outcome).toBe('success');
    expect(summary.purchasesProcessed).toBe(1);
    deps.database.close();
  });

  it('skips a three-day-interval scheduled run until the freshness window elapses', async () => {
    const config = { ...DEFAULT_CONFIG, scheduledIntervalDays: 3 };
    const prior = {
      alertsSent: 0,
      candidatesFound: 0,
      finishedAt: '2026-08-15T21:00:01.000Z',
      observationsRecorded: 0,
      outcome: 'success' as const,
      purchasesProcessed: 0,
      startedAt: '2026-08-15T21:00:00.000Z',
      unresolvedPrices: 0,
    };

    const freshDeps = dependencies({ config });
    freshDeps.database.finishRun(
      freshDeps.database.beginRun(prior.startedAt),
      prior,
    );

    const skipped = await runPriceCheck(freshDeps, {
      now: () => new Date('2026-08-18T16:59:00.000Z'),
      scheduled: true,
    });

    expect(skipped.outcome).toBe('skipped');
    expect(freshDeps.localNotifier.messages).toEqual([]);
    freshDeps.database.close();

    const elapsedDeps = dependencies({ config });
    elapsedDeps.database.finishRun(
      elapsedDeps.database.beginRun(prior.startedAt),
      prior,
    );

    const ran = await runPriceCheck(elapsedDeps, {
      now: () => new Date('2026-08-18T17:00:01.000Z'),
      scheduled: true,
    });

    expect(ran.outcome).toBe('success');
    expect(ran.purchasesProcessed).toBe(1);
    elapsedDeps.database.close();
  });

  it('runs when the recorded successful finish time is in the future', async () => {
    const deps = dependencies();
    const prior = {
      alertsSent: 0,
      candidatesFound: 0,
      finishedAt: '2026-08-18T17:00:00.000Z',
      observationsRecorded: 0,
      outcome: 'success' as const,
      purchasesProcessed: 0,
      startedAt: '2026-08-18T16:59:00.000Z',
      unresolvedPrices: 0,
    };
    deps.database.finishRun(deps.database.beginRun(prior.startedAt), prior);

    const summary = await runPriceCheck(deps, {
      now: () => NOW,
      scheduled: true,
    });

    expect(summary.outcome).toBe('success');
    expect(summary.purchasesProcessed).toBe(1);
    deps.database.close();
  });

  it('records auth-required and sends only a local recovery notification before receipt access', async () => {
    let receiptCalls = 0;
    const reports: FullRunReport[] = [];
    const deps = dependencies({
      fetchReceipts: async () => {
        receiptCalls += 1;
        return [];
      },
      readTokens: async () => {
        throw new AuthRequiredError();
      },
      writeReport: async (report) => {
        reports.push(report);
        return {
          htmlFile: '/reports/auth.html',
          csvFile: '/reports/auth.csv',
          jsonFile: '/reports/auth.json',
        };
      },
    });

    const summary = await runPriceCheck(deps, { now: () => NOW });

    expect(summary.outcome).toBe('auth_required');
    expect(receiptCalls).toBe(0);
    expect(deps.localNotifier.messages).toEqual([
      expect.objectContaining({
        body: expect.stringContaining('costco login'),
      }),
    ]);
    expect(deps.mailNotifier.messages).toEqual([]);
    expect(summary.reportFiles?.htmlFile).toBe('/reports/auth.html');
    expect(reports).toEqual([
      expect.objectContaining({
        outcome: 'auth_required',
        rows: [],
        sourceDiagnostics: [
          expect.objectContaining({
            source: 'costco_orders',
            status: 'error',
          }),
        ],
      }),
    ]);
    deps.database.close();
  });

  it('treats an expired receipt session as auth-required and sends local login recovery', async () => {
    const deps = dependencies({
      fetchReceipts: async () => {
        throw new AuthRequiredError();
      },
    });

    const summary = await runPriceCheck(deps, { now: () => NOW });

    expect(summary.outcome).toBe('auth_required');
    expect(deps.localNotifier.messages).toEqual([
      expect.objectContaining({
        body: expect.stringContaining('costco login'),
      }),
    ]);
    expect(deps.mailNotifier.messages).toEqual([]);
    expect(deps.database.getLastSuccessfulRun()).toBeNull();
    deps.database.close();
  });

  it('records a failed price batch as unresolved while continuing usable observations', async () => {
    const secondItemReceipt = {
      ...LIVE_RECEIPT,
      itemArray: [
        ...LIVE_RECEIPT.itemArray,
        {
          amount: '10.00',
          itemDescription01: 'Unresolved item',
          itemNumber: '200002',
          unit: '1',
        },
      ],
    };
    const deps = dependencies({
      fetchReceipts: async () => [secondItemReceipt],
      fetchPrices: async () => [
        resolvedObservation(),
        resolvedObservation('200002', null),
      ],
    });

    const summary = await runPriceCheck(deps, { now: () => NOW });

    expect(summary).toMatchObject({
      candidatesFound: 1,
      observationsRecorded: 2,
      outcome: 'partial_failure',
      purchasesProcessed: 2,
      unresolvedPrices: 1,
    });
    expect(deps.database.latestPriceObservations()).toHaveLength(2);
    expect(deps.localNotifier.messages).toHaveLength(1);
    deps.database.close();
  });

  it('completes a no-op run without displaying a notification or sending mail', async () => {
    const deps = dependencies({
      fetchPrices: async () => [resolvedObservation('100978861', 899)],
    });

    const summary = await runPriceCheck(deps, { now: () => NOW });

    expect(summary).toMatchObject({
      alertsSent: 0,
      candidatesFound: 0,
      outcome: 'success',
    });
    expect(deps.localNotifier.messages).toEqual([]);
    expect(deps.mailNotifier.messages).toEqual([]);
    expect(deps.mailNotifier.resolveCalls).toBe(0);
    deps.database.close();
  });

  it('retries failed email without repeating a successful local delivery', async () => {
    const mail = new FakeMailNotifier();
    mail.error = new Error('Mail unavailable');
    const deps = dependencies({ mail });

    const first = await runPriceCheck(deps, { now: () => NOW });
    const purchaseId = deps.database.recentPurchases(
      '2026-08-01T00:00:00.000Z',
    )[0]?.id;

    expect(first.outcome).toBe('partial_failure');
    expect(
      deps.database.getChannelAlertState('local', purchaseId ?? ''),
    ).not.toBeNull();
    expect(
      deps.database.getChannelAlertState('email', purchaseId ?? ''),
    ).toBeNull();

    mail.error = null;
    const second = await runPriceCheck(deps, {
      now: () => new Date('2026-08-18T17:00:00.000Z'),
    });

    expect(second.notifications).toEqual({
      email: { attempted: true, delivered: 1, error: null },
      local: { attempted: false, delivered: 0, error: null },
    });
    expect(deps.localNotifier.messages).toHaveLength(1);
    expect(deps.mailNotifier.messages).toHaveLength(1);
    expect(
      deps.database.getChannelAlertState('email', purchaseId ?? ''),
    ).not.toBeNull();
    deps.database.close();
  });

  it('suppresses both channels after successful alert-state persistence', async () => {
    const deps = dependencies();

    await runPriceCheck(deps, { now: () => NOW });
    const repeated = await runPriceCheck(deps, {
      now: () => new Date('2026-08-18T17:00:00.000Z'),
    });

    expect(repeated.alertsSent).toBe(0);
    expect(deps.localNotifier.messages).toHaveLength(1);
    expect(deps.mailNotifier.messages).toHaveLength(1);
    deps.database.close();
  });

  it('retains existing purchases when receipt retrieval fails', async () => {
    const database = createDatabase();
    database.upsertPurchases([
      {
        couponCents: 0,
        id: 'existing-purchase',
        itemNumber: '333333',
        paidUnitCents: 1000,
        purchaseChannel: 'warehouse',
        purchasedAt: '2026-08-12T09:00:00.000Z',
        quantity: 1,
        receiptId: 'existing-receipt',
        warehouseNumber: '129',
      },
    ]);
    const deps = dependencies({
      database,
      fetchReceipts: async () => {
        throw new Error('Costco receipt API unavailable');
      },
    });

    const summary = await runPriceCheck(deps, { now: () => NOW });

    expect(summary.outcome).toBe('failure');
    expect(database.recentPurchases('2026-08-01T00:00:00.000Z')).toEqual([
      expect.objectContaining({ id: 'existing-purchase' }),
    ]);
    expect(deps.localNotifier.messages).toEqual([]);
    database.close();
  });

  it('writes an empty failure report when receipt retrieval fails', async () => {
    const reports: FullRunReport[] = [];
    const deps = dependencies({
      fetchReceipts: async () => {
        throw new Error('Costco receipt API unavailable');
      },
      writeReport: async (report) => {
        reports.push(report);
        return {
          htmlFile: '/reports/failure.html',
          csvFile: '/reports/failure.csv',
          jsonFile: '/reports/failure.json',
        };
      },
    });

    const summary = await runPriceCheck(deps, { now: () => NOW });

    expect(summary.reportFiles?.jsonFile).toBe('/reports/failure.json');
    expect(reports).toEqual([
      expect.objectContaining({
        outcome: 'failure',
        rows: [],
        sourceDiagnostics: [
          expect.objectContaining({
            source: 'costco_receipts',
            status: 'error',
          }),
        ],
      }),
    ]);
    deps.database.close();
  });

  it('sanitizes, records, and exposes a useful receipt failure diagnostic', async () => {
    const deps = dependencies({
      fetchReceipts: async () => {
        throw new Error(
          'upstream timeout Authorization: Basic receipt-secret access_token=access-secret payload={"rawReceipt":"member data","nested":{"refreshToken":"refresh-secret"}}',
        );
      },
    });

    const summary = await runPriceCheck(deps, { now: () => NOW });

    expect(summary.diagnostic).toMatch(/receipt retrieval failed.*timeout/i);
    expect(summary.diagnostic).not.toContain('receipt-secret');
    expect(summary.diagnostic).not.toContain('access-secret');
    expect(summary.diagnostic).not.toContain('refresh-secret');
    expect(summary.diagnostic).not.toContain('member data');
    expect(deps.database.getLatestRun()?.diagnostic).toBe(summary.diagnostic);
    deps.database.close();
  });

  it('records a safe top-level price failure diagnostic', async () => {
    const deps = dependencies({
      fetchPrices: async () => {
        throw new Error(
          'price provider failed token=price-secret [raw payload]',
        );
      },
    });

    const summary = await runPriceCheck(deps, { now: () => NOW });

    expect(summary.diagnostic).toMatch(/price check failed.*provider failed/i);
    expect(summary.diagnostic).not.toContain('price-secret');
    expect(summary.diagnostic).not.toContain('raw payload');
    expect(deps.database.getLatestRun()?.diagnostic).toBe(summary.diagnostic);
    deps.database.close();
  });

  it('sanitizes and records channel failure summaries', async () => {
    const local = new FakeLocalNotifier();
    const mail = new FakeMailNotifier();
    local.error = new Error('notification denied token=local-secret');
    mail.error = new Error('Mail denied {"raw":"mail-secret"}');
    const deps = dependencies({ local, mail });

    const summary = await runPriceCheck(deps, { now: () => NOW });

    expect(summary.outcome).toBe('partial_failure');
    expect(summary.diagnostic).toContain('Local notification failed');
    expect(summary.diagnostic).toContain('Email delivery failed');
    expect(JSON.stringify(summary)).not.toMatch(/local-secret|mail-secret/);
    expect(deps.database.getLatestRun()?.diagnostic).toBe(summary.diagnostic);
    deps.database.close();
  });

  it('does not downgrade an alert-state database failure to a channel error', async () => {
    const deps = dependencies();
    const failingDatabase = new Proxy(deps.database, {
      get(target, property, receiver) {
        if (property === 'saveChannelAlertState') {
          return () => {
            throw new Error('database disk failure');
          };
        }
        const value: unknown = Reflect.get(target, property, receiver);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });

    await expect(
      runPriceCheck({ ...deps, database: failingDatabase }, { now: () => NOW }),
    ).rejects.toThrow('database disk failure');
    deps.database.close();
  });

  it('does not persist delivered alert state when the terminal report writer fails', async () => {
    let writerFails = true;
    let writerCalls = 0;
    const writerError = new Error('report disk unavailable');
    const deps = dependencies({
      writeReport: async () => {
        writerCalls += 1;
        if (writerFails) throw writerError;
        return {
          htmlFile: '/reports/retry.html',
          csvFile: '/reports/retry.csv',
          jsonFile: '/reports/retry.json',
        };
      },
    });

    await expect(runPriceCheck(deps, { now: () => NOW })).rejects.toBe(
      writerError,
    );
    const purchaseId = deps.database.recentPurchases(
      '2026-08-01T00:00:00.000Z',
    )[0]?.id;
    expect(writerCalls).toBe(1);
    expect(
      deps.database.getChannelAlertState('local', purchaseId ?? ''),
    ).toBeNull();
    expect(
      deps.database.getChannelAlertState('email', purchaseId ?? ''),
    ).toBeNull();
    expect(deps.database.getLatestRun()).toBeNull();
    expect(deps.localNotifier.messages).toHaveLength(1);
    expect(deps.mailNotifier.messages).toHaveLength(1);

    writerFails = false;
    const retry = await runPriceCheck(deps, {
      now: () => new Date('2026-08-18T17:00:00.000Z'),
    });

    expect(retry.outcome).toBe('success');
    expect(deps.localNotifier.messages).toHaveLength(2);
    expect(deps.mailNotifier.messages).toHaveLength(2);
    expect(
      deps.database.getChannelAlertState('local', purchaseId ?? ''),
    ).not.toBeNull();
    expect(
      deps.database.getChannelAlertState('email', purchaseId ?? ''),
    ).not.toBeNull();
    deps.database.close();
  });

  it('returns a failure report after a non-auth token error', async () => {
    const deps = dependencies({
      readTokens: async () => {
        throw new Error('browser launch failed');
      },
    });
    const finished: Array<{ id: number; outcome: string }> = [];
    const database = new Proxy(deps.database, {
      get(target, property, receiver) {
        if (property === 'finishRun') {
          return (id: number, summary: RunSummary) => {
            finished.push({ id, outcome: summary.outcome });
            return target.finishRun(id, summary);
          };
        }
        const value: unknown = Reflect.get(target, property, receiver);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });

    const summary = await runPriceCheck(
      { ...deps, database },
      { now: () => NOW },
    );

    expect(summary).toMatchObject({
      outcome: 'failure',
      diagnostic: expect.stringContaining('browser launch failed'),
      reportFiles: {
        htmlFile: '/reports/run.html',
        csvFile: '/reports/run.csv',
        jsonFile: '/reports/run.json',
      },
    });
    expect(finished).toEqual([{ id: 1, outcome: 'failure' }]);
    deps.database.close();
  });

  it('uses a fresh clock reading for an unexpected failure finish time', async () => {
    const started = new Date('2026-08-18T16:00:00.000Z');
    const failed = new Date('2026-08-18T16:00:02.000Z');
    const clock = [started, failed];
    const deps = dependencies({
      readTokens: async () => {
        throw new Error('browser launch failed');
      },
    });

    const summary = await runPriceCheck(deps, {
      now: () => clock.shift() ?? failed,
    });

    expect(summary.outcome).toBe('failure');
    expect(deps.database.getLatestRun()?.startedAt).toBe(started.toISOString());
    expect(deps.database.getLatestRun()?.finishedAt).toBe(failed.toISOString());
    deps.database.close();
  });

  it('returns a failure report after an unexpected post-start failure', async () => {
    const deps = dependencies();
    const finished: Array<{ id: number; outcome: string }> = [];
    const database = new Proxy(deps.database, {
      get(target, property, receiver) {
        if (property === 'getChannelAlertState') {
          return () => {
            throw new Error('database read failed');
          };
        }
        if (property === 'finishRun') {
          return (id: number, summary: RunSummary) => {
            finished.push({ id, outcome: summary.outcome });
            return target.finishRun(id, summary);
          };
        }
        const value: unknown = Reflect.get(target, property, receiver);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });

    const summary = await runPriceCheck(
      { ...deps, database },
      { now: () => NOW },
    );

    expect(summary).toMatchObject({
      outcome: 'failure',
      diagnostic: expect.stringContaining('database read failed'),
      reportFiles: {
        htmlFile: '/reports/run.html',
        csvFile: '/reports/run.csv',
        jsonFile: '/reports/run.json',
      },
    });
    expect(finished).toEqual([{ id: 1, outcome: 'failure' }]);
    deps.database.close();
  });
});
