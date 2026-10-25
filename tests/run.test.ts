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
  Purchase,
  ReportPriceObservation,
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
  transactionBarcode: '0000000000000000000002',
  transactionDateTime: '2026-08-10T18:30:00.000Z',
  transactionNumber: '4567',
  transactionType: 'Purchase',
  warehouseNumber: '129',
};

const ONLINE_PURCHASE: Purchase = {
  couponCents: 0,
  description: 'Costco.com Coffee',
  grossUnitCents: 2_000,
  id: 'online-purchase-1',
  itemNumber: '200001',
  paidUnitCents: 2_000,
  purchaseChannel: 'costco_com',
  purchasedAt: '2026-08-11T18:30:00.000Z',
  quantity: 1,
  receiptId: 'costco.com:ORDER-1',
  warehouseNumber: '847',
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
    html?: string;
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

  async send(
    recipient: string,
    subject: string,
    text: string,
    html?: string,
  ): Promise<void> {
    if (this.error) throw this.error;
    this.messages.push({ recipient, subject, text, ...(html ? { html } : {}) });
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

function availableReportPrice(
  channel: ReportPriceObservation['channel'],
  unitPriceCents: number,
): ReportPriceObservation {
  return {
    channel,
    observedAt: NOW.toISOString(),
    promotionText: null,
    source:
      channel === 'warehouse' ? 'warehouse-price-api' : 'costco_product_api',
    unavailableReason: null,
    unitPriceCents,
  };
}

function unavailableReportPrice(
  channel: ReportPriceObservation['channel'],
  unavailableReason = 'not_applicable',
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

function dependencies(
  options: {
    config?: AppConfig;
    database?: Database;
    fetchPrices?: RunDependencies['fetchWarehousePrices'];
    fetchOnlineOrders?: RunDependencies['fetchOnlineOrderPurchases'];
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
    fetchOnlineOrderPurchases:
      options.fetchOnlineOrders ??
      (async () => ({
        diagnostic: {
          channel: null,
          message: 'Costco.com order import completed with 0 purchases.',
          observedAt: NOW.toISOString(),
          source: 'costco_online_orders',
          status: 'ok',
        },
        failedDetailBatches: 0,
        purchases: [],
      })),
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
  it('emails a weekly report when no price drop is found', async () => {
    const deps = dependencies({
      config: { ...DEFAULT_CONFIG, emailEveryRun: true },
      fetchReceipts: async () => [],
    });

    const summary = await runPriceCheck(deps, { now: () => NOW });

    expect(summary.outcome).toBe('success');
    expect(deps.mailNotifier.messages).toEqual([
      expect.objectContaining({
        recipient: 'self@example.com',
        subject: 'Costco Genie weekly report',
        text: expect.stringContaining('Items considered: 0'),
        html: expect.stringContaining('<h2>Overall stats</h2>'),
      }),
    ]);
    expect(deps.localNotifier.messages).toEqual([]);
    deps.database.close();
  });

  it('starts both purchase imports after one token read with the same configured window', async () => {
    const tokens = { clientId: 'shared-client', idToken: 'shared-token' };
    const calls: Array<{
      endDate: string;
      source: 'online' | 'receipts';
      startDate: string;
      tokens: typeof tokens;
    }> = [];
    let onlineStarted = false;
    let tokenReads = 0;
    const deps = dependencies({
      fetchOnlineOrders: async (receivedTokens, startDate, endDate) => {
        onlineStarted = true;
        calls.push({
          endDate,
          source: 'online',
          startDate,
          tokens: receivedTokens,
        });
        return {
          diagnostic: {
            channel: null,
            message: 'Costco.com order import completed with 0 purchases.',
            observedAt: NOW.toISOString(),
            source: 'costco_online_orders',
            status: 'ok',
          },
          failedDetailBatches: 0,
          purchases: [],
        };
      },
      fetchPrices: async () => [],
      fetchReceipts: async (receivedTokens, startDate, endDate) => {
        calls.push({
          endDate,
          source: 'receipts',
          startDate,
          tokens: receivedTokens,
        });
        await Promise.resolve();
        expect(onlineStarted).toBe(true);
        return [];
      },
      readTokens: async () => {
        tokenReads += 1;
        return tokens;
      },
    });

    const summary = await runPriceCheck(deps, { now: () => NOW });

    expect(tokenReads).toBe(1);
    expect(calls).toEqual([
      {
        endDate: '2026-08-18',
        source: 'receipts',
        startDate: '2026-07-14',
        tokens,
      },
      {
        endDate: '2026-08-18',
        source: 'online',
        startDate: '2026-07-14',
        tokens,
      },
    ]);
    expect(summary.outcome).toBe('success');
    deps.database.close();
  });

  it('imports, persists, prices, and counts warehouse and Costco.com purchases by channel', async () => {
    const reports: FullRunReport[] = [];
    let priceRequests: unknown;
    const deps = dependencies({
      fetchEvidence: async (requests) => {
        priceRequests = requests;
        return {
          diagnostics: [],
          items: requests.map((request) => ({
            ...request,
            prices:
              request.purchaseChannel === 'warehouse'
                ? {
                    warehouse: availableReportPrice('warehouse', 799),
                    warehouseSavings: unavailableReportPrice(
                      'warehouse_savings',
                      'item_not_advertised',
                    ),
                    costcoCom: unavailableReportPrice(
                      'costco_com',
                      'product_not_found',
                    ),
                    sameDay: unavailableReportPrice(
                      'same_day',
                      'source_not_configured',
                    ),
                  }
                : {
                    warehouse: unavailableReportPrice('warehouse'),
                    warehouseSavings:
                      unavailableReportPrice('warehouse_savings'),
                    costcoCom: availableReportPrice('costco_com', 1_500),
                    sameDay: unavailableReportPrice('same_day'),
                  },
          })),
        };
      },
      fetchOnlineOrders: async () => ({
        diagnostic: {
          channel: null,
          message: 'Costco.com order import completed with 1 purchase.',
          observedAt: NOW.toISOString(),
          source: 'costco_online_orders',
          status: 'ok',
        },
        failedDetailBatches: 0,
        purchases: [ONLINE_PURCHASE],
      }),
      writeReport: async (report) => {
        reports.push(report);
        return {
          htmlFile: '/reports/mixed.html',
          csvFile: '/reports/mixed.csv',
          jsonFile: '/reports/mixed.json',
        };
      },
    });

    const summary = await runPriceCheck(deps, { now: () => NOW });

    expect(priceRequests).toEqual([
      {
        description: 'Kirkland Trail Mix',
        paidUnitCents: 899,
        itemNumber: '100978861',
        purchaseChannel: 'warehouse',
        warehouseNumber: '129',
      },
      {
        description: 'Costco.com Coffee',
        paidUnitCents: 2000,
        itemNumber: '200001',
        purchaseChannel: 'costco_com',
        warehouseNumber: '847',
      },
    ]);
    expect(summary).toMatchObject({
      alertsSent: 2,
      candidatesFound: 2,
      onlinePurchasesProcessed: 1,
      outcome: 'success',
      purchasesProcessed: 2,
      warehousePurchasesProcessed: 1,
    });
    expect(summary.notifications).toEqual({
      email: { attempted: true, delivered: 2, error: null },
      local: { attempted: true, delivered: 2, error: null },
    });
    expect(
      deps.database
        .recentPurchases('2026-08-01T00:00:00.000Z')
        .map(({ purchaseChannel }) => purchaseChannel),
    ).toEqual(['warehouse', 'costco_com']);
    expect(reports[0]?.rows).toHaveLength(2);
    expect(reports[0]?.schemaVersion).toBe(3);
    expect(
      reports[0]?.rows.find(
        ({ purchase }) => purchase.purchaseChannel === 'warehouse',
      ),
    ).toMatchObject({
      comparisonChannel: 'warehouse',
      comparisonDeltaCents: 100,
      comparisonUnitCents: 799,
      potentialSavingsCents: 200,
    });
    expect(
      reports[0]?.rows.find(
        ({ purchase }) => purchase.purchaseChannel === 'costco_com',
      ),
    ).toMatchObject({
      comparisonChannel: 'costco_com',
      comparisonDeltaCents: 500,
      comparisonUnitCents: 1_500,
      potentialSavingsCents: 500,
      prices: {
        costcoCom: { unitPriceCents: 1_500 },
        receiptHistory: {
          unavailableReason: 'not_applicable',
          unitPriceCents: null,
        },
      },
      status: 'candidate',
    });
    deps.database.close();
  });

  it('pairs evidence by channel when warehouse and Costco.com share an item and scope', async () => {
    const reports: FullRunReport[] = [];
    const sharedOnlinePurchase = { ...ONLINE_PURCHASE, warehouseNumber: '123' };
    const warehouseReceipt = {
      ...LIVE_RECEIPT,
      couponArray: [],
      itemArray: [
        {
          amount: '30.00',
          itemDescription01: 'Warehouse Coffee',
          itemNumber: sharedOnlinePurchase.itemNumber,
          unit: '1',
        },
      ],
      warehouseNumber: sharedOnlinePurchase.warehouseNumber,
    };
    const deps = dependencies({
      fetchEvidence: async (requests) => ({
        diagnostics: [],
        items: requests.map((request) => ({
          ...request,
          prices:
            request.purchaseChannel === 'warehouse'
              ? {
                  warehouse: availableReportPrice('warehouse', 2_500),
                  warehouseSavings: unavailableReportPrice('warehouse_savings'),
                  costcoCom: unavailableReportPrice(
                    'costco_com',
                    'product_not_found',
                  ),
                  sameDay: unavailableReportPrice('same_day'),
                }
              : {
                  warehouse: availableReportPrice('warehouse', 100),
                  warehouseSavings: availableReportPrice(
                    'warehouse_savings',
                    200,
                  ),
                  costcoCom: availableReportPrice('costco_com', 1_500),
                  sameDay: availableReportPrice('same_day', 300),
                },
        })),
      }),
      fetchOnlineOrders: async () => ({
        diagnostic: {
          channel: null,
          message: 'Costco.com order import completed with 1 purchase.',
          observedAt: NOW.toISOString(),
          source: 'costco_online_orders',
          status: 'ok',
        },
        failedDetailBatches: 0,
        purchases: [sharedOnlinePurchase],
      }),
      fetchReceipts: async () => [warehouseReceipt],
      writeReport: async (report) => {
        reports.push(report);
        return {
          htmlFile: '/reports/shared-key.html',
          csvFile: '/reports/shared-key.csv',
          jsonFile: '/reports/shared-key.json',
        };
      },
    });

    const summary = await runPriceCheck(deps, { now: () => NOW });

    expect(summary.candidatesFound).toBe(2);
    expect(reports[0]?.rows).toEqual([
      expect.objectContaining({
        prices: expect.objectContaining({
          warehouse: expect.objectContaining({ unitPriceCents: 2_500 }),
        }),
        purchase: expect.objectContaining({ purchaseChannel: 'warehouse' }),
      }),
      expect.objectContaining({
        comparisonChannel: 'costco_com',
        prices: expect.objectContaining({
          costcoCom: expect.objectContaining({ unitPriceCents: 1_500 }),
          receiptHistory: expect.objectContaining({
            unavailableReason: 'not_applicable',
          }),
          sameDay: expect.objectContaining({
            unavailableReason: 'not_applicable',
            unitPriceCents: null,
          }),
          warehouse: expect.objectContaining({
            unavailableReason: 'not_applicable',
            unitPriceCents: null,
          }),
          warehouseSavings: expect.objectContaining({
            unavailableReason: 'not_applicable',
            unitPriceCents: null,
          }),
        }),
        purchase: expect.objectContaining({ purchaseChannel: 'costco_com' }),
      }),
    ]);
    deps.database.close();
  });

  it('delivers an exact lower Costco.com price once per notification channel', async () => {
    const deps = dependencies({
      fetchEvidence: async (requests) => ({
        diagnostics: [],
        items: requests.map((request) => ({
          ...request,
          prices: {
            warehouse: unavailableReportPrice('warehouse'),
            warehouseSavings: unavailableReportPrice('warehouse_savings'),
            costcoCom: availableReportPrice('costco_com', 1_500),
            sameDay: unavailableReportPrice('same_day'),
          },
        })),
      }),
      fetchOnlineOrders: async () => ({
        diagnostic: {
          channel: null,
          message: 'Costco.com order import completed with 1 purchase.',
          observedAt: NOW.toISOString(),
          source: 'costco_online_orders',
          status: 'ok',
        },
        failedDetailBatches: 0,
        purchases: [ONLINE_PURCHASE],
      }),
      fetchReceipts: async () => [],
    });

    const first = await runPriceCheck(deps, { now: () => NOW });
    const repeated = await runPriceCheck(deps, {
      now: () => new Date('2026-08-18T17:00:00.000Z'),
    });

    expect(first).toMatchObject({ alertsSent: 1, candidatesFound: 1 });
    expect(first.notifications).toEqual({
      email: { attempted: true, delivered: 1, error: null },
      local: { attempted: true, delivered: 1, error: null },
    });
    expect(repeated.alertsSent).toBe(0);
    expect(deps.localNotifier.messages).toHaveLength(1);
    expect(deps.mailNotifier.messages).toHaveLength(1);
    expect(
      deps.database.getChannelAlertState('local', ONLINE_PURCHASE.id),
    ).toMatchObject({ lastNotifiedPriceCents: 1_500 });
    expect(
      deps.database.getChannelAlertState('email', ONLINE_PURCHASE.id),
    ).toMatchObject({ lastNotifiedPriceCents: 1_500 });
    deps.database.close();
  });

  it('reports below-threshold Costco.com savings without creating a candidate', async () => {
    const reports: FullRunReport[] = [];
    const deps = dependencies({
      config: { ...DEFAULT_CONFIG, minimumSavingsCents: 10 },
      fetchEvidence: async (requests) => ({
        diagnostics: [],
        items: requests.map((request) => ({
          ...request,
          prices: {
            warehouse: unavailableReportPrice('warehouse'),
            warehouseSavings: unavailableReportPrice('warehouse_savings'),
            costcoCom: availableReportPrice('costco_com', 1_995),
            sameDay: unavailableReportPrice('same_day'),
          },
        })),
      }),
      fetchOnlineOrders: async () => ({
        diagnostic: {
          channel: null,
          message: 'Costco.com order import completed with 1 purchase.',
          observedAt: NOW.toISOString(),
          source: 'costco_online_orders',
          status: 'ok',
        },
        failedDetailBatches: 0,
        purchases: [ONLINE_PURCHASE],
      }),
      fetchReceipts: async () => [],
      writeReport: async (report) => {
        reports.push(report);
        return {
          htmlFile: '/reports/below-threshold.html',
          csvFile: '/reports/below-threshold.csv',
          jsonFile: '/reports/below-threshold.json',
        };
      },
    });

    const summary = await runPriceCheck(deps, { now: () => NOW });

    expect(summary.candidatesFound).toBe(0);
    expect(reports[0]?.rows[0]).toMatchObject({
      comparisonChannel: 'costco_com',
      comparisonDeltaCents: 5,
      comparisonUnitCents: 1_995,
      potentialSavingsCents: 5,
      reason: 'below_savings_threshold',
      status: 'not_eligible',
    });
    deps.database.close();
  });

  it('reports a valid Costco.com price that is not lower with zero potential savings', async () => {
    const reports: FullRunReport[] = [];
    const deps = dependencies({
      fetchEvidence: async (requests) => ({
        diagnostics: [],
        items: requests.map((request) => ({
          ...request,
          prices: {
            warehouse: unavailableReportPrice('warehouse'),
            warehouseSavings: unavailableReportPrice('warehouse_savings'),
            costcoCom: availableReportPrice('costco_com', 2_100),
            sameDay: unavailableReportPrice('same_day'),
          },
        })),
      }),
      fetchOnlineOrders: async () => ({
        diagnostic: {
          channel: null,
          message: 'Costco.com order import completed with 1 purchase.',
          observedAt: NOW.toISOString(),
          source: 'costco_online_orders',
          status: 'ok',
        },
        failedDetailBatches: 0,
        purchases: [ONLINE_PURCHASE],
      }),
      fetchReceipts: async () => [],
      writeReport: async (report) => {
        reports.push(report);
        return {
          htmlFile: '/reports/not-lower.html',
          csvFile: '/reports/not-lower.csv',
          jsonFile: '/reports/not-lower.json',
        };
      },
    });

    const summary = await runPriceCheck(deps, { now: () => NOW });

    expect(summary.candidatesFound).toBe(0);
    expect(reports[0]?.rows[0]).toMatchObject({
      comparisonChannel: 'costco_com',
      comparisonDeltaCents: -100,
      comparisonUnitCents: 2_100,
      potentialSavingsCents: 0,
      reason: 'no_price_drop',
      status: 'not_eligible',
    });
    deps.database.close();
  });

  it('uses only current Costco.com coverage when receipt import fails', async () => {
    const reports: FullRunReport[] = [];
    const database = createDatabase();
    database.upsertPurchases([
      {
        couponCents: 0,
        id: 'stale-warehouse',
        itemNumber: '333333',
        paidUnitCents: 1_000,
        purchaseChannel: 'warehouse',
        purchasedAt: '2026-08-12T09:00:00.000Z',
        quantity: 1,
        receiptId: 'stale-receipt',
        warehouseNumber: '129',
      },
    ]);
    let priceRequests: unknown;
    const deps = dependencies({
      database,
      fetchEvidence: async (requests) => {
        priceRequests = requests;
        return {
          diagnostics: [],
          items: requests.map((request) => ({
            ...request,
            prices: {
              warehouse: unavailableReportPrice('warehouse'),
              warehouseSavings: unavailableReportPrice('warehouse_savings'),
              costcoCom: availableReportPrice('costco_com', 2_000),
              sameDay: unavailableReportPrice('same_day'),
            },
          })),
        };
      },
      fetchOnlineOrders: async () => ({
        diagnostic: {
          channel: null,
          message: 'Costco.com order import completed with 1 purchase.',
          observedAt: NOW.toISOString(),
          source: 'costco_online_orders',
          status: 'ok',
        },
        failedDetailBatches: 0,
        purchases: [ONLINE_PURCHASE],
      }),
      fetchReceipts: async () => {
        throw new Error('receipt failed token=receipt-secret');
      },
      writeReport: async (report) => {
        reports.push(report);
        return {
          htmlFile: '/reports/online-only.html',
          csvFile: '/reports/online-only.csv',
          jsonFile: '/reports/online-only.json',
        };
      },
    });

    const summary = await runPriceCheck(deps, { now: () => NOW });

    expect(summary).toMatchObject({
      onlinePurchasesProcessed: 1,
      outcome: 'partial_failure',
      purchasesProcessed: 1,
      warehousePurchasesProcessed: 0,
    });
    expect(summary.diagnostic).toMatch(/receipt retrieval failed/i);
    expect(summary.diagnostic).not.toContain('receipt-secret');
    expect(priceRequests).toEqual([
      expect.objectContaining({
        itemNumber: ONLINE_PURCHASE.itemNumber,
        purchaseChannel: 'costco_com',
      }),
    ]);
    expect(reports[0]?.rows).toEqual([
      expect.objectContaining({
        purchase: expect.objectContaining({ purchaseChannel: 'costco_com' }),
      }),
    ]);
    expect(reports[0]?.sourceDiagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          message: expect.not.stringContaining('receipt-secret'),
          source: 'costco_receipts',
          status: 'error',
        }),
        expect.objectContaining({
          source: 'costco_online_orders',
          status: 'ok',
        }),
      ]),
    );
    database.close();
  });

  it('uses only current warehouse coverage when Costco.com import fails', async () => {
    const reports: FullRunReport[] = [];
    const database = createDatabase();
    database.upsertPurchases([ONLINE_PURCHASE]);
    let priceRequests: unknown;
    const deps = dependencies({
      database,
      fetchEvidence: async (requests) => {
        priceRequests = requests;
        return {
          diagnostics: [],
          items: requests.map((request) => ({
            ...request,
            prices: {
              warehouse: availableReportPrice('warehouse', 899),
              warehouseSavings: unavailableReportPrice(
                'warehouse_savings',
                'item_not_advertised',
              ),
              costcoCom: unavailableReportPrice(
                'costco_com',
                'product_not_found',
              ),
              sameDay: unavailableReportPrice(
                'same_day',
                'source_not_configured',
              ),
            },
          })),
        };
      },
      fetchOnlineOrders: async () => {
        throw new Error('online failed access_token=online-secret');
      },
      writeReport: async (report) => {
        reports.push(report);
        return {
          htmlFile: '/reports/warehouse-only.html',
          csvFile: '/reports/warehouse-only.csv',
          jsonFile: '/reports/warehouse-only.json',
        };
      },
    });

    const summary = await runPriceCheck(deps, { now: () => NOW });

    expect(summary).toMatchObject({
      onlinePurchasesProcessed: 0,
      outcome: 'partial_failure',
      purchasesProcessed: 1,
      warehousePurchasesProcessed: 1,
    });
    expect(summary.diagnostic).toMatch(/Costco\.com order retrieval failed/i);
    expect(summary.diagnostic).not.toContain('online-secret');
    expect(priceRequests).toEqual([
      expect.objectContaining({
        itemNumber: '100978861',
        purchaseChannel: 'warehouse',
      }),
    ]);
    expect(reports[0]?.rows).toEqual([
      expect.objectContaining({
        purchase: expect.objectContaining({ purchaseChannel: 'warehouse' }),
      }),
    ]);
    expect(reports[0]?.sourceDiagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          message: expect.not.stringContaining('online-secret'),
          source: 'costco_online_orders',
          status: 'error',
        }),
      ]),
    );
    database.close();
  });

  it('returns auth-required when both purchase imports fail and authentication is implicated', async () => {
    let priceCalls = 0;
    const deps = dependencies({
      fetchOnlineOrders: async () => {
        throw new AuthRequiredError();
      },
      fetchPrices: async () => {
        priceCalls += 1;
        return [];
      },
      fetchReceipts: async () => {
        throw new Error('receipt transport failed');
      },
    });

    const summary = await runPriceCheck(deps, { now: () => NOW });

    expect(summary.outcome).toBe('auth_required');
    expect(priceCalls).toBe(0);
    expect(deps.localNotifier.messages).toEqual([
      expect.objectContaining({
        body: expect.stringContaining('costco login'),
      }),
    ]);
    deps.database.close();
  });

  it('returns failure when both purchase imports fail without an auth error', async () => {
    const reports: FullRunReport[] = [];
    let priceCalls = 0;
    const deps = dependencies({
      fetchOnlineOrders: async () => {
        throw new Error('online unavailable');
      },
      fetchPrices: async () => {
        priceCalls += 1;
        return [];
      },
      fetchReceipts: async () => {
        throw new Error('receipts unavailable');
      },
      writeReport: async (report) => {
        reports.push(report);
        return {
          htmlFile: '/reports/import-failure.html',
          csvFile: '/reports/import-failure.csv',
          jsonFile: '/reports/import-failure.json',
        };
      },
    });

    const summary = await runPriceCheck(deps, { now: () => NOW });

    expect(summary.outcome).toBe('failure');
    expect(priceCalls).toBe(0);
    expect(reports[0]?.rows).toEqual([]);
    expect(reports[0]?.sourceDiagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ source: 'costco_receipts', status: 'error' }),
        expect.objectContaining({
          source: 'costco_online_orders',
          status: 'error',
        }),
      ]),
    );
    deps.database.close();
  });

  it('uses successful Costco.com detail lines and marks failed detail batches partial', async () => {
    const reports: FullRunReport[] = [];
    const deps = dependencies({
      fetchEvidence: async (requests) => ({
        diagnostics: [],
        items: requests.map((request) => ({
          ...request,
          prices: {
            warehouse: unavailableReportPrice('warehouse'),
            warehouseSavings: unavailableReportPrice('warehouse_savings'),
            costcoCom: availableReportPrice('costco_com', 1_500),
            sameDay: unavailableReportPrice('same_day'),
          },
        })),
      }),
      fetchOnlineOrders: async () => ({
        diagnostic: {
          channel: null,
          message:
            'Costco.com order import completed with 1 purchase and 1 failed detail batch.',
          observedAt: NOW.toISOString(),
          source: 'costco_online_orders',
          status: 'error',
        },
        failedDetailBatches: 1,
        purchases: [ONLINE_PURCHASE],
      }),
      fetchReceipts: async () => [],
      writeReport: async (report) => {
        reports.push(report);
        return {
          htmlFile: '/reports/partial-detail.html',
          csvFile: '/reports/partial-detail.csv',
          jsonFile: '/reports/partial-detail.json',
        };
      },
    });

    const summary = await runPriceCheck(deps, { now: () => NOW });

    expect(summary).toMatchObject({
      alertsSent: 1,
      candidatesFound: 1,
      onlinePurchasesProcessed: 1,
      outcome: 'partial_failure',
      purchasesProcessed: 1,
    });
    expect(reports[0]?.rows).toHaveLength(1);
    expect(reports[0]?.sourceDiagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source: 'costco_online_orders',
          status: 'error',
        }),
      ]),
    );
    deps.database.close();
  });

  it('excludes a cached Costco.com line omitted by a successful current import', async () => {
    const reports: FullRunReport[] = [];
    const database = createDatabase();
    database.upsertPurchases([ONLINE_PURCHASE]);
    let priceRequests: unknown;
    const deps = dependencies({
      database,
      fetchEvidence: async (requests) => {
        priceRequests = requests;
        return {
          diagnostics: [],
          items: requests.map((request) => ({
            ...request,
            prices: {
              warehouse: unavailableReportPrice('warehouse'),
              warehouseSavings: unavailableReportPrice('warehouse_savings'),
              costcoCom: availableReportPrice('costco_com', 1_500),
              sameDay: unavailableReportPrice('same_day'),
            },
          })),
        };
      },
      fetchOnlineOrders: async () => ({
        diagnostic: {
          channel: null,
          message: 'Costco.com order import completed with 0 purchases.',
          observedAt: NOW.toISOString(),
          source: 'costco_online_orders',
          status: 'ok',
        },
        failedDetailBatches: 0,
        purchases: [],
      }),
      fetchReceipts: async () => [],
      writeReport: async (report) => {
        reports.push(report);
        return {
          htmlFile: '/reports/omitted-online.html',
          csvFile: '/reports/omitted-online.csv',
          jsonFile: '/reports/omitted-online.json',
        };
      },
    });

    const summary = await runPriceCheck(deps, { now: () => NOW });

    expect(priceRequests).toEqual([]);
    expect(summary).toMatchObject({
      alertsSent: 0,
      candidatesFound: 0,
      onlinePurchasesProcessed: 0,
      purchasesProcessed: 0,
    });
    expect(deps.localNotifier.messages).toEqual([]);
    expect(deps.mailNotifier.messages).toEqual([]);
    expect(
      database.getChannelAlertState('local', ONLINE_PURCHASE.id),
    ).toBeNull();
    expect(reports[0]?.rows).toEqual([]);
    expect(
      database.recentPurchases('2026-08-01T00:00:00.000Z').map(({ id }) => id),
    ).toContain(ONLINE_PURCHASE.id);
    database.close();
  });

  it('excludes cached Costco.com lines from failed detail batches while keeping current successful lines', async () => {
    const stalePurchase: Purchase = {
      ...ONLINE_PURCHASE,
      description: 'Stale Costco.com Tea',
      id: 'stale-online-purchase',
      itemNumber: '200002',
      receiptId: 'costco.com:STALE-ORDER',
    };
    const reports: FullRunReport[] = [];
    const database = createDatabase();
    database.upsertPurchases([stalePurchase]);
    let priceRequests: unknown;
    const deps = dependencies({
      database,
      fetchEvidence: async (requests) => {
        priceRequests = requests;
        return {
          diagnostics: [],
          items: requests.map((request) => ({
            ...request,
            prices: {
              warehouse: unavailableReportPrice('warehouse'),
              warehouseSavings: unavailableReportPrice('warehouse_savings'),
              costcoCom: availableReportPrice('costco_com', 1_500),
              sameDay: unavailableReportPrice('same_day'),
            },
          })),
        };
      },
      fetchOnlineOrders: async () => ({
        diagnostic: {
          channel: null,
          message:
            'Costco.com order import completed with 1 purchase and 1 failed detail batch.',
          observedAt: NOW.toISOString(),
          source: 'costco_online_orders',
          status: 'error',
        },
        failedDetailBatches: 1,
        purchases: [ONLINE_PURCHASE],
      }),
      fetchReceipts: async () => [],
      writeReport: async (report) => {
        reports.push(report);
        return {
          htmlFile: '/reports/partial-detail-stale.html',
          csvFile: '/reports/partial-detail-stale.csv',
          jsonFile: '/reports/partial-detail-stale.json',
        };
      },
    });

    const summary = await runPriceCheck(deps, { now: () => NOW });

    expect(priceRequests).toEqual([
      expect.objectContaining({
        itemNumber: ONLINE_PURCHASE.itemNumber,
        purchaseChannel: 'costco_com',
      }),
    ]);
    expect(summary).toMatchObject({
      alertsSent: 1,
      candidatesFound: 1,
      onlinePurchasesProcessed: 1,
      outcome: 'partial_failure',
      purchasesProcessed: 1,
    });
    expect(deps.localNotifier.messages).toHaveLength(1);
    expect(deps.localNotifier.messages[0]?.body).not.toContain(
      stalePurchase.description ?? '',
    );
    expect(deps.mailNotifier.messages).toHaveLength(1);
    expect(deps.mailNotifier.messages[0]?.text).not.toContain(
      stalePurchase.description ?? '',
    );
    expect(database.getChannelAlertState('local', stalePurchase.id)).toBeNull();
    expect(reports[0]?.rows.map(({ purchase }) => purchase.id)).toEqual([
      ONLINE_PURCHASE.id,
    ]);
    database.close();
  });

  it('isolates one Costco.com price failure while matching the other online item', async () => {
    const secondPurchase: Purchase = {
      ...ONLINE_PURCHASE,
      description: 'Costco.com Tea',
      id: 'online-purchase-2',
      itemNumber: '200002',
      receiptId: 'costco.com:ORDER-2',
    };
    const reports: FullRunReport[] = [];
    const deps = dependencies({
      fetchEvidence: async (requests) => ({
        diagnostics: [
          {
            channel: 'costco_com',
            message: 'One Costco.com price batch failed.',
            observedAt: NOW.toISOString(),
            source: 'costco_product_api',
            status: 'error',
          },
        ],
        items: requests.map((request) => ({
          ...request,
          prices: {
            warehouse: unavailableReportPrice('warehouse'),
            warehouseSavings: unavailableReportPrice('warehouse_savings'),
            costcoCom:
              request.itemNumber === ONLINE_PURCHASE.itemNumber
                ? unavailableReportPrice('costco_com', 'batch_failed')
                : availableReportPrice('costco_com', 1_500),
            sameDay: unavailableReportPrice('same_day'),
          },
        })),
      }),
      fetchOnlineOrders: async () => ({
        diagnostic: {
          channel: null,
          message: 'Costco.com order import completed with 2 purchases.',
          observedAt: NOW.toISOString(),
          source: 'costco_online_orders',
          status: 'ok',
        },
        failedDetailBatches: 0,
        purchases: [ONLINE_PURCHASE, secondPurchase],
      }),
      fetchReceipts: async () => [],
      writeReport: async (report) => {
        reports.push(report);
        return {
          htmlFile: '/reports/partial-price.html',
          csvFile: '/reports/partial-price.csv',
          jsonFile: '/reports/partial-price.json',
        };
      },
    });

    const summary = await runPriceCheck(deps, { now: () => NOW });

    expect(summary).toMatchObject({
      alertsSent: 1,
      candidatesFound: 1,
      onlineUnresolvedPrices: 1,
      outcome: 'partial_failure',
      purchasesProcessed: 2,
      unresolvedPrices: 1,
    });
    expect(reports[0]?.rows).toHaveLength(2);
    expect(deps.localNotifier.messages[0]?.body).toContain('Costco.com Tea');
    expect(deps.mailNotifier.messages[0]?.text).toContain('Costco.com Tea');
    deps.database.close();
  });

  it.each([
    ['source', { source: null }],
    ['observedAt', { observedAt: null }],
  ] as const)(
    'classifies a lower Costco.com price with null %s as unresolved evidence',
    async (_field, provenancePatch) => {
      const reports: FullRunReport[] = [];
      const deps = dependencies({
        fetchEvidence: async (requests) => ({
          diagnostics: [],
          items: requests.map((request) => ({
            ...request,
            prices: {
              warehouse: unavailableReportPrice('warehouse'),
              warehouseSavings: unavailableReportPrice('warehouse_savings'),
              costcoCom: {
                ...availableReportPrice('costco_com', 1_500),
                ...provenancePatch,
              },
              sameDay: unavailableReportPrice('same_day'),
            },
          })),
        }),
        fetchOnlineOrders: async () => ({
          diagnostic: {
            channel: null,
            message: 'Costco.com order import completed with 1 purchase.',
            observedAt: NOW.toISOString(),
            source: 'costco_online_orders',
            status: 'ok',
          },
          failedDetailBatches: 0,
          purchases: [ONLINE_PURCHASE],
        }),
        fetchReceipts: async () => [],
        writeReport: async (report) => {
          reports.push(report);
          return {
            htmlFile: '/reports/missing-provenance.html',
            csvFile: '/reports/missing-provenance.csv',
            jsonFile: '/reports/missing-provenance.json',
          };
        },
      });

      const summary = await runPriceCheck(deps, { now: () => NOW });

      expect(summary).toMatchObject({
        candidatesFound: 0,
        onlineUnresolvedPrices: 1,
        unresolvedPrices: 1,
      });
      expect(reports[0]?.rows).toEqual([
        expect.objectContaining({
          comparisonChannel: null,
          comparisonDeltaCents: null,
          comparisonUnitCents: null,
          potentialSavingsCents: null,
          reason: 'costco_com_price_unavailable',
          status: 'not_eligible',
        }),
      ]);
      deps.database.close();
    },
  );

  it('leaves malformed warehouse evidence unavailable instead of using Costco.com evidence', async () => {
    const reports: FullRunReport[] = [];
    const deps = dependencies({
      fetchEvidence: async (requests) => ({
        diagnostics: [],
        items: requests.map((request) => ({
          ...request,
          prices: {
            warehouse: {
              ...availableReportPrice('warehouse', 799),
              source: null,
            },
            warehouseSavings: unavailableReportPrice('warehouse_savings'),
            costcoCom: availableReportPrice('costco_com', 100),
            sameDay: unavailableReportPrice('same_day'),
          },
        })),
      }),
      writeReport: async (report) => {
        reports.push(report);
        return {
          htmlFile: '/reports/malformed-warehouse.html',
          csvFile: '/reports/malformed-warehouse.csv',
          jsonFile: '/reports/malformed-warehouse.json',
        };
      },
    });

    const summary = await runPriceCheck(deps, { now: () => NOW });

    expect(summary).toMatchObject({
      alertsSent: 0,
      candidatesFound: 0,
      unresolvedPrices: 1,
      warehouseUnresolvedPrices: 1,
    });
    expect(deps.localNotifier.messages).toEqual([]);
    expect(deps.mailNotifier.messages).toEqual([]);
    expect(reports[0]?.rows[0]).toMatchObject({
      comparisonChannel: null,
      comparisonDeltaCents: null,
      comparisonUnitCents: null,
      potentialSavingsCents: null,
      status: 'not_eligible',
    });
    deps.database.close();
  });

  it('rejects a Costco.com-channel value in the warehouse evidence slot before notification', async () => {
    const reports: FullRunReport[] = [];
    const deps = dependencies({
      fetchEvidence: async (requests) => ({
        diagnostics: [],
        items: requests.map((request) => ({
          ...request,
          prices: {
            warehouse: {
              ...availableReportPrice('warehouse', 799),
              channel: 'costco_com',
            },
            warehouseSavings: unavailableReportPrice('warehouse_savings'),
            costcoCom: availableReportPrice('costco_com', 100),
            sameDay: unavailableReportPrice('same_day'),
          },
        })),
      }),
      writeReport: async (report) => {
        reports.push(report);
        return {
          htmlFile: '/reports/warehouse-crossover.html',
          csvFile: '/reports/warehouse-crossover.csv',
          jsonFile: '/reports/warehouse-crossover.json',
        };
      },
    });

    const summary = await runPriceCheck(deps, { now: () => NOW });

    expect(summary).toMatchObject({
      alertsSent: 0,
      candidatesFound: 0,
      unresolvedPrices: 1,
      warehouseUnresolvedPrices: 1,
    });
    expect(deps.localNotifier.messages).toEqual([]);
    expect(deps.mailNotifier.messages).toEqual([]);
    expect(reports[0]?.rows[0]).toMatchObject({
      comparisonChannel: null,
      prices: {
        warehouse: {
          channel: 'warehouse',
          unavailableReason: 'invalid_warehouse_price_evidence',
          unitPriceCents: null,
        },
      },
      status: 'not_eligible',
    });
    deps.database.close();
  });

  it('rejects blank Costco.com provenance before notification', async () => {
    const reports: FullRunReport[] = [];
    const deps = dependencies({
      fetchEvidence: async (requests) => ({
        diagnostics: [],
        items: requests.map((request) => ({
          ...request,
          prices: {
            warehouse: unavailableReportPrice('warehouse'),
            warehouseSavings: unavailableReportPrice('warehouse_savings'),
            costcoCom: {
              ...availableReportPrice('costco_com', 1_500),
              source: '   ',
            },
            sameDay: unavailableReportPrice('same_day'),
          },
        })),
      }),
      fetchOnlineOrders: async () => ({
        diagnostic: {
          channel: null,
          message: 'Costco.com order import completed with 1 purchase.',
          observedAt: NOW.toISOString(),
          source: 'costco_online_orders',
          status: 'ok',
        },
        failedDetailBatches: 0,
        purchases: [ONLINE_PURCHASE],
      }),
      fetchReceipts: async () => [],
      writeReport: async (report) => {
        reports.push(report);
        return {
          htmlFile: '/reports/blank-online-source.html',
          csvFile: '/reports/blank-online-source.csv',
          jsonFile: '/reports/blank-online-source.json',
        };
      },
    });

    const summary = await runPriceCheck(deps, { now: () => NOW });

    expect(summary).toMatchObject({
      alertsSent: 0,
      candidatesFound: 0,
      onlineUnresolvedPrices: 1,
      unresolvedPrices: 1,
    });
    expect(deps.localNotifier.messages).toEqual([]);
    expect(deps.mailNotifier.messages).toEqual([]);
    expect(reports[0]?.rows[0]).toMatchObject({
      comparisonChannel: null,
      reason: 'costco_com_price_unavailable',
      status: 'not_eligible',
    });
    deps.database.close();
  });

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
            purchaseChannel: 'warehouse',
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
      comparisonChannel: 'warehouse',
      comparisonDeltaCents: 150,
      comparisonUnitCents: 749,
      potentialSavingsCents: 300,
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
      config: {
        ...DEFAULT_CONFIG,
        sameDayPostalCode: '10001',
        sameDayRepresentativeAddress: '123 Example St, Sample City, NY 10001',
      },
      fetchEvidence: async (_requests, options) => {
        expect(options.sameDayMarkupPercent).toBe(13.5);
        expect(options.sameDayPostalCode).toBe('10001');
        expect(options.sameDayRepresentativeAddress).toBe(
          '123 Example St, Sample City, NY 10001',
        );
        return {
          diagnostics: [],
          items: [
            {
              itemNumber: '100978861',
              purchaseChannel: 'warehouse',
              warehouseNumber: '129',
              prices: {
                warehouse: unavailable('warehouse'),
                warehouseSavings: unavailable('warehouse_savings'),
                costcoCom: unavailable('costco_com'),
                sameDay: {
                  channel: 'same_day',
                  observedAt: NOW.toISOString(),
                  promotionText: null,
                  source: 'costco_same_day_zip_10001',
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
      comparisonChannel: 'same_day',
      comparisonDeltaCents: 106,
      comparisonUnitCents: 793,
      potentialSavingsCents: 212,
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
        paidUnitCents: 899,
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
      subject: 'Costco Genie: potential price adjustments',
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
    expect(deps.database.getLastSuccessfulRun()).toMatchObject({
      alertsSent: summary.alertsSent,
      candidatesFound: summary.candidatesFound,
      observationsRecorded: summary.observationsRecorded,
      outcome: summary.outcome,
      purchasesProcessed: summary.purchasesProcessed,
      unresolvedPrices: summary.unresolvedPrices,
    });
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
        paidUnitCents: 1998,
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
    let reportWrites = 0;
    const deps = dependencies({
      fetchReceipts: async () => {
        throw new Error('receipt access must not happen');
      },
      writeReport: async () => {
        reportWrites += 1;
        throw new Error('a skipped run must preserve the latest report');
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
    expect(reportWrites).toBe(0);
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

  it('consumes a weekly trigger skipped for freshness instead of importing on a later daily watch trigger', async () => {
    const readTokens = vi.fn(async () => ({
      clientId: 'TEST',
      idToken: 'TEST',
    }));
    const deps = dependencies({
      config: { ...DEFAULT_CONFIG, scheduledWeekday: 5, scheduledHour: 16 },
      readTokens,
    });
    const prior: RunSummary = {
      startedAt: new Date(2026, 9, 23, 14, 59).toISOString(),
      finishedAt: new Date(2026, 9, 23, 15).toISOString(),
      outcome: 'success',
      purchasesProcessed: 0,
      observationsRecorded: 0,
      candidatesFound: 0,
      alertsSent: 0,
      unresolvedPrices: 0,
    };
    deps.database.finishRun(deps.database.beginRun(prior.startedAt), prior);
    for (const time of [
      new Date(2026, 9, 23, 16),
      new Date(2026, 9, 24, 8),
      new Date(2026, 9, 25, 8),
      new Date(2026, 9, 29, 17),
    ]) {
      expect(
        (await runPriceCheck(deps, { scheduled: true, now: () => time }))
          .outcome,
      ).toBe('skipped');
    }
    expect(readTokens).not.toHaveBeenCalled();
    expect(
      (
        await runPriceCheck(deps, {
          scheduled: true,
          now: () => new Date(2026, 9, 30, 16),
        })
      ).outcome,
    ).toBe('success');
    expect(readTokens).toHaveBeenCalledOnce();
    deps.database.close();
  });

  it.each(['auth_required', 'failure', 'partial_failure'] as const)(
    'does not retry a completed weekly %s on daily watch triggers, while manual failures do not consume a trigger',
    async (outcome) => {
      const config = {
        ...DEFAULT_CONFIG,
        scheduledWeekday: 5,
        scheduledHour: 16,
      };
      const readTokens = vi.fn(async () => {
        throw new AuthRequiredError();
      });
      const deps = dependencies({ config, readTokens });
      const completed: RunSummary = {
        startedAt: new Date(2026, 9, 23, 16).toISOString(),
        finishedAt: new Date(2026, 9, 23, 16, 1).toISOString(),
        outcome,
        purchasesProcessed: 0,
        observationsRecorded: 0,
        candidatesFound: 0,
        alertsSent: 0,
        unresolvedPrices: 0,
      };
      deps.database.finishRun(
        deps.database.beginRun(completed.startedAt, true),
        completed,
      );
      expect(
        (
          await runPriceCheck(deps, {
            scheduled: true,
            now: () => new Date(2026, 9, 24, 8),
          })
        ).outcome,
      ).toBe('skipped');
      expect(readTokens).not.toHaveBeenCalled();
      // A later manual failure must neither replace freshness nor consume next Friday.
      const manual = {
        ...completed,
        startedAt: new Date(2026, 9, 30, 15, 59).toISOString(),
        finishedAt: new Date(2026, 9, 30, 16, 1).toISOString(),
      };
      deps.database.finishRun(deps.database.beginRun(manual.startedAt), manual);
      expect(
        (
          await runPriceCheck(deps, {
            scheduled: true,
            now: () => new Date(2026, 9, 30, 16, 2),
          })
        ).outcome,
      ).toBe('auth_required');
      expect(readTokens).toHaveBeenCalledOnce();
      deps.database.close();
    },
  );

  it('catches up a missed weekly trigger after sleep without importing before Friday afternoon', async () => {
    const deps = dependencies({
      config: {
        ...DEFAULT_CONFIG,
        scheduledWeekday: 5,
        scheduledHour: 16,
      },
    });
    const prior: RunSummary = {
      startedAt: new Date(2026, 9, 16, 16).toISOString(),
      finishedAt: new Date(2026, 9, 16, 16, 1).toISOString(),
      outcome: 'success',
      purchasesProcessed: 0,
      observationsRecorded: 0,
      candidatesFound: 0,
      alertsSent: 0,
      unresolvedPrices: 0,
    };
    deps.database.finishRun(
      deps.database.beginRun(prior.startedAt, true),
      prior,
    );
    for (const time of [new Date(2026, 9, 22, 8), new Date(2026, 9, 23, 8)])
      expect(
        (await runPriceCheck(deps, { scheduled: true, now: () => time }))
          .outcome,
      ).toBe('skipped');
    // The Mac sleeps through Friday 16:00 and wakes on Saturday.
    expect(
      (
        await runPriceCheck(deps, {
          scheduled: true,
          now: () => new Date(2026, 9, 24, 11),
        })
      ).outcome,
    ).toBe('success');
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

  it('treats expired authorization across both purchase sources as auth-required', async () => {
    const deps = dependencies({
      fetchOnlineOrders: async () => {
        throw new AuthRequiredError();
      },
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

    expect(summary.outcome).toBe('partial_failure');
    expect(database.recentPurchases('2026-08-01T00:00:00.000Z')).toEqual([
      expect.objectContaining({ id: 'existing-purchase' }),
    ]);
    expect(deps.localNotifier.messages).toEqual([]);
    database.close();
  });

  it('writes an empty partial report when receipt retrieval fails but online import succeeds', async () => {
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
        outcome: 'partial_failure',
        rows: [],
        sourceDiagnostics: expect.arrayContaining([
          expect.objectContaining({
            source: 'costco_receipts',
            status: 'error',
          }),
        ]),
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

it('compares a reconciled booklet final with net receipt payment and carries evidence through DB, report and weekly email', async () => {
  const { fetchReportPriceEvidence } =
    await import('../src/costco/price-client.js');
  const reports: FullRunReport[] = [];
  const sameDayPriceFetcher = vi.fn(async () => []);
  const deps = dependencies({
    config: { ...DEFAULT_CONFIG, emailEveryRun: true },
    fetchEvidence: async (requests, options) =>
      fetchReportPriceEvidence(requests, {
        ...options,
        sameDayPriceFetcher,
        fetchFn: async (input) => {
          if (String(input).includes('/warehouse-savings'))
            return new Response(
              `<article data-item-number="${requests[0].itemNumber}" data-start-date="2026-08-01" data-end-date="2026-08-31" data-applicability="warehouse" data-final-price="6.99">$6.99 After $3.00 OFF</article>`,
            );
          if (String(input).includes('/display-price-lite'))
            return Response.json({
              priceData: requests.map((r) => ({
                id: r.itemNumber,
                displayPrice: [
                  {
                    warehouseNumber: r.warehouseNumber,
                    currency: 'USD',
                    onlinePrice: '9.99',
                    aggregatedDiscountAmt: 0,
                    deliveredPrice: '9.99',
                    uom: 'EA',
                  },
                ],
              })),
            });
          return Response.json({ data: { products: { catalogData: [] } } });
        },
      }),
    writeReport: async (report) => {
      reports.push(report);
      return {
        htmlFile: '/reports/synthetic.html',
        csvFile: '/reports/synthetic.csv',
        jsonFile: '/reports/synthetic.json',
      };
    },
  });
  const result = await runPriceCheck(deps, { now: () => NOW });
  expect(result.candidatesFound).toBe(1);
  expect(result.estimatedOpportunitiesFound ?? 0).toBe(0);
  expect(sameDayPriceFetcher).not.toHaveBeenCalled();
  expect(reports[0].rows[0]).toMatchObject({
    purchase: { grossUnitCents: 999, paidUnitCents: 899 },
    comparisonUnitCents: 699,
    comparisonDeltaCents: 200,
    potentialSavingsCents: 400,
    status: 'candidate',
    prices: {
      warehouse: {
        warehouseEvidence: {
          baseCents: 999,
          discountCents: 0,
          deliveredCents: 999,
          bookletFinalCents: 699,
        },
      },
    },
  });
  expect(
    deps.database.latestPriceObservations()[0].warehouseEvidence,
  ).toMatchObject({ baseCents: 999, bookletFinalCents: 699 });
  expect(deps.mailNotifier.messages[0].text).toContain('Base: $9.99');
  expect(deps.mailNotifier.messages[0].text).toContain('Booklet final: $6.99');
  expect(deps.mailNotifier.messages[0].html).toContain(
    'Promotion ends: 2026-08-31',
  );
  deps.database.close();
});

it.each([
  ['lb', 'warehouse_per_lb_not_comparable_to_receipt_package'],
  ['unknown', 'warehouse_possible_unit_mismatch'],
] as const)(
  'keeps unsafe %s display quotations out of verified candidates and shows %s in the weekly email',
  async (unitBasis, reason) => {
    const { resolveWarehousePriceEvidence } =
      await import('../src/costco/price-client.js');
    const reports: FullRunReport[] = [];
    const deps = dependencies({
      config: { ...DEFAULT_CONFIG, emailEveryRun: true },
      fetchEvidence: async (requests) => ({
        diagnostics: [],
        items: requests.map((request) => {
          const raw: ReportPriceObservation = {
            ...availableReportPrice('warehouse_display', 100),
            source: 'warehouse_display_price_api',
            warehouseEvidence: {
              warehouseNumber: request.warehouseNumber,
              unitBasis,
              baseCents: 100,
              discountCents: 0,
              deliveredCents: 100,
            },
          };
          return {
            ...request,
            prices: {
              warehouse: resolveWarehousePriceEvidence(
                request,
                raw,
                undefined,
                undefined,
              ),
              warehouseDisplay: raw,
              warehouseSavings: unavailableReportPrice('warehouse_savings'),
              costcoCom: unavailableReportPrice('costco_com'),
              sameDay: {
                ...availableReportPrice('same_day', 500),
                source: 'same_day_guest_storefront',
              },
            },
          };
        }),
      }),
      writeReport: async (report) => {
        reports.push(report);
        return {
          htmlFile: '/reports/synthetic.html',
          csvFile: '/reports/synthetic.csv',
          jsonFile: '/reports/synthetic.json',
        };
      },
    });
    const result = await runPriceCheck(deps, { now: () => NOW });
    expect(result.candidatesFound).toBe(0);
    expect(result.estimatedOpportunitiesFound).toBe(1);
    expect(deps.database.latestPriceObservations()).toEqual([]);
    expect(reports[0].rows[0]).toMatchObject({
      status: 'estimated_opportunity',
      comparisonChannel: 'same_day',
      prices: {
        warehouse: {
          unitPriceCents: null,
          warehouseEvidence: {
            unitBasis,
            unitReason: reason,
          },
        },
      },
    });
    expect(deps.mailNotifier.messages[0].text).toContain(reason);
    expect(deps.mailNotifier.messages[0].html).toContain(reason);
    deps.database.close();
  },
);

it.each([
  ['Synthetic packaged item', 600, null],
  ['Synthetic packaged item', 500, null],
  ['Synthetic packaged item', 499, 'warehouse_possible_unit_mismatch'],
  [
    'Synthetic roast avg wt 3 lbs',
    600,
    'warehouse_receipt_variable_weight_not_comparable_to_receipt_package',
  ],
] as const)(
  'uses normalized net receipt payment for unknown-unit quotation %s at %s cents',
  async (description, quotationCents, reason) => {
    const { fetchReportPriceEvidence } =
      await import('../src/costco/price-client.js');
    const sameDayPriceFetcher = vi.fn(async () => []);
    const reports: FullRunReport[] = [];
    const deps = dependencies({
      config: {
        ...DEFAULT_CONFIG,
        sameDayPostalCode: '10001',
        sameDayRepresentativeAddress:
          '123 Example Street, Sample City, NY 10001',
      },
      fetchReceipts: async () => [
        {
          ...LIVE_RECEIPT,
          warehouseNumber: '123',
          itemArray: [
            {
              itemNumber: '900991',
              itemDescription01: description,
              amount: '20.00',
              itemUnitPriceAmount: '20.00',
              unit: '1',
            },
          ],
          couponArray: [
            {
              amountCoupon: '-10.00',
              associatedItemNumber: '900991',
              unitCoupon: '1',
            },
          ],
        },
      ],
      fetchEvidence: (requests, options) =>
        fetchReportPriceEvidence(requests, {
          ...options,
          sameDayPriceFetcher,
          fetchFn: async (input) =>
            String(input).includes('/warehouse-savings')
              ? new Response('<p>No offers</p>')
              : Response.json({ data: { products: { catalogData: [] } } }),
          warehouseDisplayPriceFetcher: async (requests) =>
            requests.map((request) => ({
              ...request,
              ...availableReportPrice('warehouse_display', quotationCents),
              source: 'warehouse_display_price_api',
              warehouseEvidence: {
                warehouseNumber: request.warehouseNumber,
                unitBasis: 'unknown',
                baseCents: quotationCents,
                discountCents: 0,
                deliveredCents: quotationCents,
              },
            })),
        }),
      writeReport: async (report) => {
        reports.push(report);
        return {
          htmlFile: '/reports/synthetic.html',
          csvFile: '/reports/synthetic.csv',
          jsonFile: '/reports/synthetic.json',
        };
      },
    });
    const summary = await runPriceCheck(deps, { now: () => NOW });
    expect(summary.candidatesFound).toBe(reason ? 0 : 1);
    expect(summary.observationsRecorded).toBe(reason ? 0 : 1);
    expect(sameDayPriceFetcher).toHaveBeenCalledTimes(reason ? 1 : 0);
    expect(reports[0].rows[0]).toMatchObject({
      purchase: { grossUnitCents: 2000, paidUnitCents: 1000 },
      prices: {
        warehouse: {
          unitPriceCents: reason ? null : quotationCents,
          unavailableReason: reason,
          warehouseEvidence: { quotationCents, unitReason: reason },
        },
      },
    });
    if (!reason) {
      expect(reports[0].rows[0].potentialSavingsCents).toBe(
        1000 - quotationCents,
      );
      expect(
        deps.database.latestPriceObservations()[0].warehouseEvidence
          ?.comparisonBasis,
      ).toBe('assumed_package');
    }
    deps.database.close();
  },
);
