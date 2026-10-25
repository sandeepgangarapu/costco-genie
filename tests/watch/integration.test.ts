import { evaluateLow } from '../../src/watch/domain.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import Sqlite from 'better-sqlite3';
import {
  chmodSync,
  existsSync,
  readFileSync,
  renameSync,
  rmSync,
} from 'node:fs';
import { join } from 'node:path';
import { Database } from '../../src/storage/database.js';
import { Store } from '../../src/watch/store.js';
import {
  DEFAULT_CONFIG,
  parseConfig,
  loadConfig,
} from '../../src/config/config.js';
import { appPaths } from '../../src/config/paths.js';
import { legacyDataDirectory } from '../../src/config/migrate.js';
import { makeSources } from '../../src/watch/sources.js';
import { displayReportPrice } from '../../src/costco/warehouse-display-client.js';
import { readWatchProductPricesLocked } from '../../src/costco/browser-session.js';
import { parseDisplayedPrice } from '../../src/costco/online-page.js';
import { runWatchCli } from '../../src/watch/cli.js';
import { createDefaultCliActions } from '../../src/cli/actions.js';
import { parseSetupOptions } from '../../src/cli/setup.js';
import {
  dispatchScheduledChecks,
  receiptScheduleDue,
} from '../../src/scheduler/dispatch.js';
import type {
  RunSummary,
  ReportPriceObservation,
} from '../../src/domain/types.js';
import { item, observation, temp } from './helpers.js';
const dirs: string[] = [];
const home = () => {
  const d = temp();
  dirs.push(d);
  return d;
};
afterEach(() =>
  dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })),
);
const now = () => new Date('2026-10-24T16:00:00Z');
const report: RunSummary = {
  startedAt: now().toISOString(),
  finishedAt: now().toISOString(),
  outcome: 'success',
  purchasesProcessed: 0,
  observationsRecorded: 0,
  candidatesFound: 0,
  alertsSent: 0,
  unresolvedPrices: 0,
};
const quote = (
  cents = 1499,
  unitBasis: 'each' | 'lb' | 'unknown' = 'unknown',
) =>
  displayReportPrice(
    {
      cents,
      reason: null,
      warehouseNumber: '222',
      baseCents: cents,
      discountCents: 0,
      deliveredCents: cents,
      currency: 'USD',
      unitBasis,
      promotions: [],
      promoEnd: null,
    },
    now().toISOString(),
  );
const sourceOptions = () => ({
  now,
  api: async () => new Map(),
  warehouseGraphql: async () => new Map<string, ReportPriceObservation>(),
  warehousePrice: async () => new Map([[item.itemNumber, quote()]]),
  publicPage: async () => null,
  savings: async () => null,
  signedIn: async () => ({ prices: new Map(), diagnostic: null }),
  fetchFn: vi.fn(async () => {
    throw new Error('TEST-network forbidden');
  }) as typeof fetch,
});
const config = {
  ...DEFAULT_CONFIG,
  watchWarehouseNumber: '222',
  sameDayPostalCode: '10001',
  sameDayRepresentativeAddress: '123 Example Street',
};

describe('shared database migration', () => {
  it('adds watch tables to the current receipt schema without changing purchases, evidence, alerts, or runs; reopens idempotently', () => {
    const path = join(home(), 'test.sqlite');
    const raw = new Sqlite(path);
    // Current pre-watch schema, synthetic rows only; no private database is read.
    raw.exec(`
      CREATE TABLE purchases (id TEXT PRIMARY KEY, description TEXT, receipt_id TEXT NOT NULL, item_number TEXT NOT NULL, warehouse_number TEXT NOT NULL, purchase_channel TEXT NOT NULL DEFAULT 'warehouse', purchased_at TEXT NOT NULL, gross_unit_cents INTEGER, paid_unit_cents INTEGER NOT NULL, quantity INTEGER NOT NULL CHECK(quantity>0), coupon_cents INTEGER NOT NULL CHECK(coupon_cents>=0));
      CREATE TABLE price_observations (id INTEGER PRIMARY KEY, item_number TEXT NOT NULL, warehouse_number TEXT NOT NULL, observed_at TEXT NOT NULL, unit_price_cents INTEGER, source TEXT NOT NULL, unresolved_reason TEXT, evidence_json TEXT);
      CREATE TABLE alert_state (purchase_id TEXT PRIMARY KEY, last_notified_price_cents INTEGER NOT NULL, urgency_bucket TEXT NOT NULL);
      CREATE TABLE alert_delivery_state (channel TEXT NOT NULL, purchase_id TEXT NOT NULL, last_notified_price_cents INTEGER NOT NULL, urgency_bucket TEXT NOT NULL, PRIMARY KEY(channel,purchase_id));
      CREATE TABLE runs (id INTEGER PRIMARY KEY, started_at TEXT NOT NULL, finished_at TEXT, outcome TEXT, purchases_processed INTEGER, observations_recorded INTEGER, candidates_found INTEGER, estimated_opportunities_found INTEGER NOT NULL DEFAULT 0, alerts_sent INTEGER, unresolved_prices INTEGER, notification_results TEXT, report_files TEXT, diagnostic TEXT);
      INSERT INTO purchases VALUES ('TEST-purchase','TEST-product','TEST-receipt','123456','222','warehouse','2026-10-20',1500,1400,1,100);
      INSERT INTO price_observations VALUES (1,'123456','222','2026-10-24',1300,'TEST-source',NULL,'{"unitBasis":"each"}');
      INSERT INTO alert_delivery_state VALUES ('email','TEST-purchase',1300,'normal');
      INSERT INTO runs VALUES (1,'2026-10-24','2026-10-24','success',1,1,1,0,1,0,NULL,NULL,NULL);
    `);
    const tables = [
      'purchases',
      'price_observations',
      'alert_delivery_state',
      'runs',
    ];
    const before = tables.map((t) => raw.prepare(`SELECT * FROM ${t}`).all());
    raw.close();
    const bytes = readFileSync(path);
    const legacyRead = new Store(path, true);
    expect(legacyRead.items()).toEqual([]);
    legacyRead.close();
    expect(readFileSync(path)).toEqual(bytes);
    Database.open(path).close();
    const store = new Store(path);
    store.add(item);
    store.close();
    Database.open(path).close();
    const migrated = new Sqlite(path, { readonly: true });
    expect(
      tables.map((t) => migrated.prepare(`SELECT * FROM ${t}`).all()),
    ).toEqual(before);
    expect(
      migrated
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'watch_%'",
        )
        .all(),
    ).toHaveLength(6);
    expect(
      migrated.prepare('SELECT COUNT(*) AS n FROM watch_items').get(),
    ).toEqual({ n: 1 });
    expect(migrated.pragma('foreign_key_check')).toEqual([]);
    migrated.close();
  });
});

describe('matcher warehouse sources and Same-Day fallback', () => {
  it.each(['each', 'lb', 'unknown'] as const)(
    'baselines a verified %s rate without opening Same-Day and still refreshes coupons',
    async (unit) => {
      const sameDay = vi.fn(async () => []);
      const savings = vi.fn(async () => null);
      const run = makeSources(config, {
        ...sourceOptions(),
        warehousePrice: async () =>
          new Map([[item.itemNumber, quote(1499, unit)]]),
        savings,
        sameDay,
      });
      const result = await run([{ ...item, channel: 'warehouse' }]);
      expect(result.observations[0]).toMatchObject({
        cents: 1499,
        evidence: { unitBasis: unit },
      });
      expect(result.observations[1].reason).toBe(
        'skipped_verified_warehouse_price',
      );
      expect(sameDay).not.toHaveBeenCalled();
      expect(savings).toHaveBeenCalledOnce();
    },
  );
  it.each(['implausible', 'unit change', 'unavailable', 'conflict'])(
    'uses estimates for %s warehouse evidence, retries only transient failures once',
    async (mode) => {
      const display =
        mode === 'unavailable'
          ? new Map()
          : new Map([
              [
                item.itemNumber,
                quote(
                  mode === 'implausible' ? 400 : 1499,
                  mode === 'unit change' ? 'lb' : 'unknown',
                ),
              ],
            ]);
      const sameDay = vi.fn(async () => [
        {
          ...observation(null),
          itemNumber: item.itemNumber,
          warehouseNumber: '222',
          channel: 'same_day' as const,
          unitPriceCents: null,
          unavailableReason: 'search_failed',
          source: 'TEST',
          promotionText: null,
        },
      ]);
      sameDay.mockResolvedValueOnce([
        {
          itemNumber: item.itemNumber,
          warehouseNumber: '222',
          channel: 'same_day',
          unitPriceCents: null,
          unavailableReason: 'search_failed',
          source: 'TEST',
          observedAt: now().toISOString(),
          promotionText: null,
        },
      ]);
      sameDay.mockResolvedValueOnce([
        {
          itemNumber: item.itemNumber,
          warehouseNumber: '222',
          channel: 'same_day',
          unitPriceCents: 2000,
          unavailableReason: null,
          source: 'TEST',
          observedAt: now().toISOString(),
          promotionText: null,
        },
      ]);
      const savings =
        mode === 'conflict'
          ? async () =>
              `<article data-item-number="${item.itemNumber}" data-applicability="warehouse" data-start-date="2026-10-20" data-end-date="2026-11-15" data-final-price="10.99">$10.99 After $1 OFF</article>`
          : async () => null;
      const result = await makeSources(config, {
        ...sourceOptions(),
        warehousePrice: async () => display,
        savings,
        sameDay,
      })(
        [{ ...item, channel: 'warehouse' }],
        new Map([
          [
            1,
            {
              itemId: 1,
              kind: 'warehouse',
              lowCents: 1499,
              baselineCents: 1499,
              unitBasis: 'unknown',
            },
          ],
        ]),
      );
      expect(sameDay).toHaveBeenCalledTimes(2);
      expect(result.observations[1]).toMatchObject({
        cents: 2000,
        estimateCents: 1762,
        reason: null,
      });
      expect(sameDay.mock.calls[0][1]).toMatchObject({ timeout: 180000 });
    },
  );
  it('reconciles a missing API coupon once and quarantines online-only promotions', async () => {
    for (const scope of ['warehouse', 'online']) {
      const result = await makeSources(config, {
        ...sourceOptions(),
        savings: async () =>
          `<article data-item-number="${item.itemNumber}" data-applicability="${scope}" data-start-date="2026-10-20" data-end-date="2026-11-15" data-final-price="9.99">$9.99 After $5 OFF</article>`,
        sameDay: async () => [],
      })([{ ...item, channel: 'warehouse' }]);
      expect(result.observations[0].cents).toBe(
        scope === 'warehouse' ? 999 : null,
      );
    }
  });
});

describe('watch CLI and session lifecycle', () => {
  function dependencies() {
    const paths = appPaths(home());
    const config = loadConfig(paths);
    Database.open(paths.databaseFile).close();
    let locked = false;
    const lock = {
      runExclusive: async <T>(action: () => Promise<T>) => {
        expect(locked).toBe(false);
        locked = true;
        try {
          return await action();
        } finally {
          locked = false;
        }
      },
    };
    const sources = vi.fn(async () => {
      expect(locked).toBe(true);
      return {
        observations: [observation(1000)],
        session: 'not_required' as const,
        diagnostics: [],
      };
    });
    return {
      paths,
      config,
      lock,
      sources,
      mail: vi.fn(async () => {}),
      now,
      resolveProduct: vi.fn(async () => ({
        itemNumber: item.itemNumber,
        name: 'TEST-product',
        url: item.url,
      })),
    };
  }
  it('defaults to both with --no-check, silently baselines an online add, lists history, and removes without deleting history', async () => {
    const deps = dependencies();
    await runWatchCli(['add', item.itemNumber, '--no-check'], deps);
    expect(deps.sources).not.toHaveBeenCalled();
    expect((await runWatchCli(['list'], deps)).text).toContain('both');
    await runWatchCli(['add', item.itemNumber, '--channel', 'online'], deps);
    expect(deps.mail).not.toHaveBeenCalled();
    expect(
      (await runWatchCli(['history', item.itemNumber], deps)).text,
    ).toContain('$10.00');
    await runWatchCli(['remove', item.itemNumber], deps);
    expect((await runWatchCli(['list'], deps)).text).toBe(
      'Watchlist is empty.',
    );
    expect(
      (await runWatchCli(['history', item.itemNumber], deps)).text,
    ).toContain('$10.00');
  });
  it('dry-run leaves database bytes and notices unchanged and sends no mail', async () => {
    const deps = dependencies();
    await runWatchCli(['add', item.itemNumber, '--channel', 'online'], deps);
    chmodSync(deps.paths.databaseFile, 0o600);
    const bytes = readFileSync(deps.paths.databaseFile);
    deps.sources.mockResolvedValue({
      observations: [observation(900)],
      session: 'signed_out',
      diagnostics: [],
    });
    await runWatchCli(['check', '--dry-run'], deps);
    expect(readFileSync(deps.paths.databaseFile)).toEqual(bytes);
    expect(deps.mail).not.toHaveBeenCalled();
  });
  it('closes the matcher product session on per-item lookup failures, and skips an empty request', async () => {
    const paths = appPaths(home());
    const close = vi.fn(async () => {});
    const open = vi.fn(async () => ({
      read: vi.fn(async () => {
        throw new Error('TEST');
      }),
      close,
    }));
    await readWatchProductPricesLocked(paths, [], open);
    expect(open).not.toHaveBeenCalled();
    const result = await readWatchProductPricesLocked(paths, [item], open);
    expect(open).toHaveBeenCalledWith(paths.browserProfileDir);
    expect(close).toHaveBeenCalledOnce();
    expect(result.diagnostic).toContain('1 item(s)');
  });
  it('accepts a scoped member price through the matcher session', async () => {
    const result = await readWatchProductPricesLocked(
      appPaths(home()),
      [item],
      async () => ({
        read: async () =>
          parseDisplayedPrice(
            `Item ${item.itemNumber}\nSign Out\nYour Price $14.99`,
            item.itemNumber,
          ),
        close: async () => {},
      }),
    );
    expect(result.prices.get(item.itemNumber)?.cents).toBe(1499);
  });
  it('validates the new settings and setup flag without changing existing choices', () => {
    expect(parseSetupOptions(['--watch-warehouse', '222'])).toEqual({
      watchWarehouseNumber: '222',
    });
    for (const value of [
      { watchWarehouseNumber: '847' },
      { watchWarehouseNumber: '0' },
      { watchWarehouseNumber: 'bad' },
      { watchScheduledHour: 24 },
      { watchScheduledMinute: 60 },
      { minimumDropCents: -1 },
    ])
      expect(() => parseConfig(value)).toThrow();
  });
});

describe('independent scheduled dispatch', () => {
  it('attempts receipts after watch failure and watches before receipt failure', async () => {
    const receipts = vi.fn(async () => report);
    expect(
      await dispatchScheduledChecks(async () => {
        throw new Error('TEST-watch');
      }, receipts),
    ).toMatchObject({ watchFailed: true, outcome: 'success' });
    expect(receipts).toHaveBeenCalledOnce();
    const watch = vi.fn(async () => ({
      status: 'success',
      text: 'TEST-watch',
    }));
    await expect(
      dispatchScheduledChecks(watch, async () => {
        throw new Error('TEST-receipts');
      }),
    ).rejects.toThrow('TEST-receipts');
    expect(watch).toHaveBeenCalledOnce();
  });
  it('preserves weekly receipt timing and catches up on a missed trigger', () => {
    const c = { ...DEFAULT_CONFIG, scheduledWeekday: 5, scheduledHour: 16 };
    const last = {
      ...report,
      finishedAt: new Date(2026, 9, 16, 16, 30).toISOString(),
    };
    expect(receiptScheduleDue(c, last, new Date(2026, 9, 23, 8))).toBe(false);
    expect(receiptScheduleDue(c, last, new Date(2026, 9, 23, 16))).toBe(true);
    expect(receiptScheduleDue(c, last, new Date(2026, 9, 24, 8))).toBe(true);
    expect(
      receiptScheduleDue(
        c,
        { ...last, finishedAt: new Date(2026, 9, 23, 16, 5).toISOString() },
        new Date(2026, 9, 24, 8),
      ),
    ).toBe(false);
  });
  it('holds the matcher lock sequentially for watches and receipts; skips successful watches today even when receipts need login', async () => {
    const h = home();
    let active = false;
    let acquired = 0;
    let ticks = 0;
    const watchSources = vi.fn(async () => {
      expect(active).toBe(true);
      return {
        observations: [observation(1000)],
        session: 'not_required' as const,
        diagnostics: [],
      };
    });
    const actions = createDefaultCliActions({
      homeDirectory: h,
      dependencies: {
        isLaunchAgentLoaded: async () => false,
        now: () => new Date(now().getTime() + ticks++),
        watchSources: () => watchSources,
        watchMail: () => vi.fn(async () => {}),
        createLock: () => ({
          runExclusive: async (action) => {
            expect(active).toBe(false);
            active = true;
            acquired++;
            try {
              return await action();
            } finally {
              active = false;
            }
          },
        }),
        readCostcoTokens: async () => {
          expect(active).toBe(true);
          throw new Error('TEST-login expired');
        },
      },
    });
    await actions.setup({ watchWarehouseNumber: '222' });
    const store = new Store(appPaths(h).databaseFile);
    store.add(item);
    store.close();
    // A final trigger from the legacy agent must migrate before dispatching both checks.
    renameSync(appPaths(h).dataDir, legacyDataDirectory(h));
    const first = await actions.run({ scheduled: true });
    expect(existsSync(legacyDataDirectory(h))).toBe(false);
    expect(first.outcome).toBe('failure');
    expect(first.watchFailed).toBe(false);
    expect(acquired).toBe(2);
    await actions.run({ scheduled: true });
    expect(watchSources).toHaveBeenCalledOnce();
    const status = await actions.status();
    expect(status).toContain('Watchlist active items: 1');
    expect(status).toContain('Watch schedule: daily 08:00');
  });
});

it('initializes the shared receipt schema when the first command is watch add --no-check', async () => {
  const h = home();
  const actions = createDefaultCliActions({
    homeDirectory: h,
    dependencies: {
      isLaunchAgentLoaded: async () => false,
    },
  });
  await actions.watch!(['add', item.itemNumber, '--no-check']);
  const db = Database.openReadOnly(appPaths(h).databaseFile);
  expect(db.getLastSuccessfulRun()).toBeNull();
  db.close();
  expect(await actions.status()).toContain('Watchlist active items: 1');
});

it('preserves a per-pound low across reopening and refuses a changed unit basis', () => {
  const path = join(home(), 'test.sqlite');
  const store = new Store(path);
  store.add(item);
  store.saveLow({
    itemId: 1,
    kind: 'warehouse',
    baselineCents: 1499,
    lowCents: 1199,
    unitBasis: 'lb',
  });
  store.close();
  const reopened = new Store(path, true);
  expect(reopened.low(1, 'warehouse')).toMatchObject({
    unitBasis: 'lb',
    lowCents: 1199,
  });
  const previous = reopened.low(1, 'warehouse');
  expect(
    evaluateLow(
      previous,
      observation(999, { kind: 'warehouse', evidence: { unitBasis: 'each' } }),
      1,
    ),
  ).toMatchObject({
    low: previous,
    alert: false,
    unverifiedReason: expect.stringContaining('Unit basis changed'),
  });
  expect(
    evaluateLow(
      previous,
      observation(999, { kind: 'warehouse', evidence: { unitBasis: 'lb' } }),
      1,
    ),
  ).toMatchObject({ alert: true, low: { lowCents: 999, unitBasis: 'lb' } });
  reopened.close();
});
