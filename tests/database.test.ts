import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Sqlite from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';

import type {
  PriceObservation,
  Purchase,
  RunSummary,
} from '../src/domain/types.js';
import { Database } from '../src/storage/database.js';

const temporaryDirectories: string[] = [];

function createTemporaryDirectory(): string {
  const directory = mkdtempSync(
    join(tmpdir(), 'costco-price-matcher-database-'),
  );
  temporaryDirectories.push(directory);
  return directory;
}

function createDatabase(): Database {
  const directory = createTemporaryDirectory();
  return Database.open(join(directory, 'costco.sqlite'));
}

const purchase: Purchase = {
  couponCents: 200,
  grossUnitCents: 1250,
  id: 'purchase-123',
  itemNumber: '100001',
  paidUnitCents: 1150,
  purchaseChannel: 'warehouse',
  purchasedAt: '2026-08-01T16:30:00.000Z',
  quantity: 2,
  receiptId: 'receipt-123',
  warehouseNumber: '123',
};

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe('Database', () => {
  it('opens an existing database read-only and refuses to create a missing one', () => {
    const directory = createTemporaryDirectory();
    const databasePath = join(directory, 'costco.sqlite');
    const database = Database.open(databasePath);
    database.close();

    const readOnly = Database.openReadOnly(databasePath);
    expect(readOnly.getLastSuccessfulRun()).toBeNull();
    readOnly.close();

    const missingPath = join(directory, 'missing.sqlite');
    expect(() => Database.openReadOnly(missingPath)).toThrow();
    expect(existsSync(missingPath)).toBe(false);
  });

  it('creates the SQLite file and supports an empty purchase query', () => {
    const directory = mkdtempSync(
      join(tmpdir(), 'costco-price-matcher-database-'),
    );
    temporaryDirectories.push(directory);
    const path = join(directory, 'costco.sqlite');
    const database = Database.open(path);

    expect(existsSync(path)).toBe(true);
    expect(lstatSync(path).mode & 0o777).toBe(0o600);
    expect(database.recentPurchases('2026-08-01T00:00:00.000Z')).toEqual([]);
    database.close();
  });

  it('hardens an existing owned database for writes but leaves read-only status access unchanged', () => {
    const directory = createTemporaryDirectory();
    const path = join(directory, 'costco.sqlite');
    Database.open(path).close();
    chmodSync(path, 0o644);

    Database.openReadOnly(path).close();
    expect(lstatSync(path).mode & 0o777).toBe(0o644);

    Database.open(path).close();
    expect(lstatSync(path).mode & 0o777).toBe(0o600);
  });

  it('rejects symlink and wrong-type database targets without following them', () => {
    const directory = createTemporaryDirectory();
    const target = join(directory, 'target.sqlite');
    const symlink = join(directory, 'symlink.sqlite');
    const wrongType = join(directory, 'directory.sqlite');
    Database.open(target).close();
    chmodSync(target, 0o644);
    symlinkSync(target, symlink);
    mkdirSync(wrongType);

    expect(() => Database.open(symlink)).toThrow(/unsafe|symbolic link/i);
    expect(() => Database.openReadOnly(symlink)).toThrow(
      /unsafe|symbolic link/i,
    );
    expect(() => Database.open(wrongType)).toThrow(/regular file|unsafe/i);
    expect(lstatSync(target).mode & 0o777).toBe(0o644);
  });

  it('upserts a receipt line idempotently and keeps identical item numbers from separate warehouses', () => {
    const database = createDatabase();
    const otherWarehousePurchase: Purchase = {
      ...purchase,
      id: 'purchase-456',
      warehouseNumber: '456',
    };

    database.upsertPurchases([purchase, purchase, otherWarehousePurchase]);

    expect(database.recentPurchases('2026-08-01T00:00:00.000Z')).toEqual([
      purchase,
      otherWarehousePurchase,
    ]);
    database.close();
  });

  it('round-trips a Costco.com purchase channel through an update', () => {
    const database = createDatabase();
    const onlinePurchase: Purchase = {
      ...purchase,
      id: 'online-purchase-123',
      purchaseChannel: 'costco_com',
      receiptId: 'online-order-123',
    };
    const updatedOnlinePurchase: Purchase = {
      ...onlinePurchase,
      paidUnitCents: 1100,
      quantity: 3,
    };

    database.upsertPurchases([onlinePurchase]);
    database.upsertPurchases([updatedOnlinePurchase]);

    expect(database.recentPurchases('2026-08-01T00:00:00.000Z')).toEqual([
      updatedOnlinePurchase,
    ]);
    database.close();
  });

  it('rejects unsupported purchase channels at the write boundary', () => {
    const database = createDatabase();
    const invalidPurchase = {
      ...purchase,
      purchaseChannel: 'invalid',
    } as unknown as Purchase;

    expect(() => database.upsertPurchases([invalidPurchase])).toThrow(
      /invalid purchase channel/i,
    );
    expect(database.recentPurchases('2026-08-01T00:00:00.000Z')).toEqual([]);
    database.close();
  });

  it('migrates legacy purchase rows to warehouse and reads them from legacy read-only databases', () => {
    const directory = createTemporaryDirectory();
    const path = join(directory, 'legacy.sqlite');
    const legacy = new Sqlite(path);
    legacy.exec(`
      CREATE TABLE purchases (
        id TEXT PRIMARY KEY, description TEXT, receipt_id TEXT NOT NULL,
        item_number TEXT NOT NULL, warehouse_number TEXT NOT NULL,
        purchased_at TEXT NOT NULL, gross_unit_cents INTEGER,
        paid_unit_cents INTEGER NOT NULL, quantity INTEGER NOT NULL,
        coupon_cents INTEGER NOT NULL
      );
      INSERT INTO purchases VALUES
        ('legacy-one', NULL, 'receipt-one', '100001', '123',
         '2026-08-02T00:00:00.000Z', 1250, 1150, 1, 0),
        ('legacy-two', NULL, 'receipt-two', '100002', '456',
         '2026-08-03T00:00:00.000Z', 1300, 1200, 1, 0);
    `);
    legacy.close();

    const readOnly = Database.openReadOnly(path);
    expect(
      readOnly
        .recentPurchases('2026-08-01T00:00:00.000Z')
        .map((legacyPurchase) => legacyPurchase.purchaseChannel),
    ).toEqual(['warehouse', 'warehouse']);
    readOnly.close();

    const database = Database.open(path);
    expect(
      database
        .recentPurchases('2026-08-01T00:00:00.000Z')
        .map((legacyPurchase) => legacyPurchase.purchaseChannel),
    ).toEqual(['warehouse', 'warehouse']);
    database.close();
  });

  it('rejects a corrupt persisted purchase channel', () => {
    const directory = createTemporaryDirectory();
    const path = join(directory, 'corrupt.sqlite');
    const corrupt = new Sqlite(path);
    corrupt.exec(`
      CREATE TABLE purchases (
        id TEXT PRIMARY KEY, description TEXT, receipt_id TEXT NOT NULL,
        item_number TEXT NOT NULL, warehouse_number TEXT NOT NULL,
        purchased_at TEXT NOT NULL, gross_unit_cents INTEGER,
        paid_unit_cents INTEGER NOT NULL, quantity INTEGER NOT NULL,
        coupon_cents INTEGER NOT NULL, purchase_channel TEXT NOT NULL
      );
      INSERT INTO purchases VALUES (
        'corrupt', NULL, 'receipt', '100001', '123',
        '2026-08-02T00:00:00.000Z', 1250, 1150, 1, 0, 'invalid'
      );
    `);
    corrupt.close();

    const database = Database.openReadOnly(path);
    expect(() => database.recentPurchases('2026-08-01T00:00:00.000Z')).toThrow(
      /invalid purchase channel/i,
    );
    database.close();
  });

  it('migrates gross receipt price while preserving null for legacy purchase rows', () => {
    const directory = createTemporaryDirectory();
    const path = join(directory, 'legacy.sqlite');
    const legacy = new Sqlite(path);
    legacy.exec(`
      CREATE TABLE purchases (
        id TEXT PRIMARY KEY, description TEXT, receipt_id TEXT NOT NULL,
        item_number TEXT NOT NULL, warehouse_number TEXT NOT NULL,
        purchased_at TEXT NOT NULL, paid_unit_cents INTEGER NOT NULL,
        quantity INTEGER NOT NULL, coupon_cents INTEGER NOT NULL
      );
      INSERT INTO purchases VALUES (
        'legacy', NULL, 'receipt', '100001', '123',
        '2026-08-02T00:00:00.000Z', 1150, 1, 0
      );
    `);
    legacy.close();

    const database = Database.open(path);
    database.upsertPurchases([purchase]);

    const rows = database.recentPurchases('2026-08-01T00:00:00.000Z');
    expect(rows[0]).toEqual(purchase);
    expect(rows[1]).toEqual(expect.objectContaining({ id: 'legacy' }));
    expect(rows[1]).not.toHaveProperty('grossUnitCents');
    database.close();
  });

  it('persists unresolved price observations', () => {
    const database = createDatabase();
    const observation: PriceObservation = {
      itemNumber: '100001',
      observedAt: '2026-08-18T09:00:00.000Z',
      source: 'warehouse-price-api',
      unitPriceCents: null,
      unresolvedReason: 'product_not_found',
      warehouseNumber: '123',
    };

    database.recordPriceObservations([observation]);

    expect(database.latestPriceObservations()).toEqual([observation]);
    database.close();
  });

  it('returns only the newest observation for each item and warehouse pair', () => {
    const database = createDatabase();
    const older: PriceObservation = {
      itemNumber: '100001',
      observedAt: '2026-08-18T09:00:00.000Z',
      source: 'warehouse-price-api',
      unitPriceCents: 1299,
      unresolvedReason: null,
      warehouseNumber: '123',
    };
    const newest: PriceObservation = {
      ...older,
      observedAt: '2026-08-18T10:00:00.000Z',
      unitPriceCents: 1199,
    };
    const otherWarehouse: PriceObservation = {
      ...newest,
      observedAt: '2026-08-18T11:00:00.000Z',
      unitPriceCents: 1099,
      warehouseNumber: '456',
    };
    const otherItem: PriceObservation = {
      ...newest,
      itemNumber: '200002',
      observedAt: '2026-08-18T12:00:00.000Z',
      unitPriceCents: 999,
    };

    database.recordPriceObservations([
      older,
      newest,
      otherWarehouse,
      otherItem,
    ]);

    expect(database.latestPriceObservations()).toEqual([
      otherItem,
      otherWarehouse,
      newest,
    ]);
    database.close();
  });

  it('records a successful run and returns the most recent one', () => {
    const database = createDatabase();
    const runId = database.beginRun('2026-08-18T09:00:00.000Z');
    const summary: RunSummary = {
      alertsSent: 1,
      candidatesFound: 2,
      finishedAt: '2026-08-18T09:02:00.000Z',
      observationsRecorded: 4,
      outcome: 'success',
      purchasesProcessed: 3,
      startedAt: '2026-08-18T09:00:00.000Z',
      unresolvedPrices: 1,
    };

    database.finishRun(runId, summary);

    expect(database.getLastSuccessfulRun()).toEqual(summary);
    database.close();
  });

  it('migrates and round-trips a safe run diagnostic', () => {
    const directory = createTemporaryDirectory();
    const path = join(directory, 'legacy.sqlite');
    const legacy = new Sqlite(path);
    legacy.exec(`
      CREATE TABLE runs (
        id INTEGER PRIMARY KEY,
        started_at TEXT NOT NULL,
        finished_at TEXT,
        outcome TEXT,
        purchases_processed INTEGER,
        observations_recorded INTEGER,
        candidates_found INTEGER,
        alerts_sent INTEGER,
        unresolved_prices INTEGER,
        notification_results TEXT
      );
    `);
    legacy.close();
    const database = Database.open(path);
    const runId = database.beginRun('2026-08-18T09:00:00.000Z');
    const summary: RunSummary = {
      alertsSent: 0,
      candidatesFound: 0,
      diagnostic: 'Receipt retrieval failed: request timed out',
      finishedAt: '2026-08-18T09:00:30.000Z',
      observationsRecorded: 0,
      outcome: 'failure',
      purchasesProcessed: 0,
      startedAt: '2026-08-18T09:00:00.000Z',
      unresolvedPrices: 0,
    };

    database.finishRun(runId, summary);

    expect(database.getLatestRun()).toEqual(summary);
    database.close();
  });

  it('round-trips alert state by purchase', () => {
    const database = createDatabase();

    expect(database.getAlertState('purchase-123')).toBeNull();
    database.saveAlertState({
      lastNotifiedPriceCents: 999,
      purchaseId: 'purchase-123',
      urgencyBucket: '3-days',
    });

    expect(database.getAlertState('purchase-123')).toEqual({
      lastNotifiedPriceCents: 999,
      purchaseId: 'purchase-123',
      urgencyBucket: '3-days',
    });
    database.close();
  });

  it('keeps successful local and email alert delivery state independent', () => {
    const database = createDatabase();
    const localState = {
      lastNotifiedPriceCents: 999,
      purchaseId: 'purchase-123',
      urgencyBucket: 'normal',
    };

    database.saveChannelAlertState('local', localState);

    expect(database.getChannelAlertState('local', 'purchase-123')).toEqual(
      localState,
    );
    expect(database.getChannelAlertState('email', 'purchase-123')).toBeNull();
    database.saveChannelAlertState('email', {
      ...localState,
      urgencyBucket: '3-days',
    });
    expect(database.getChannelAlertState('local', 'purchase-123')).toEqual(
      localState,
    );
    expect(database.getChannelAlertState('email', 'purchase-123')).toEqual({
      ...localState,
      urgencyBucket: '3-days',
    });
    database.close();
  });

  it('migrates legacy aggregate alert state to both channels idempotently', () => {
    const directory = mkdtempSync(
      join(tmpdir(), 'costco-price-matcher-database-'),
    );
    temporaryDirectories.push(directory);
    const path = join(directory, 'costco.sqlite');
    const legacy = new Sqlite(path);
    legacy.exec(`
      CREATE TABLE alert_state (
        purchase_id TEXT PRIMARY KEY,
        last_notified_price_cents INTEGER NOT NULL,
        urgency_bucket TEXT NOT NULL
      );
      INSERT INTO alert_state VALUES ('legacy-purchase', 899, '3-days');
    `);
    legacy.close();

    const expected = {
      lastNotifiedPriceCents: 899,
      purchaseId: 'legacy-purchase',
      urgencyBucket: '3-days',
    };
    const firstOpen = Database.open(path);
    expect(firstOpen.getChannelAlertState('local', 'legacy-purchase')).toEqual(
      expected,
    );
    expect(firstOpen.getChannelAlertState('email', 'legacy-purchase')).toEqual(
      expected,
    );
    firstOpen.saveChannelAlertState('local', {
      lastNotifiedPriceCents: 799,
      purchaseId: 'legacy-purchase',
      urgencyBucket: '1-day',
    });
    firstOpen.close();

    const secondOpen = Database.open(path);
    expect(secondOpen.getChannelAlertState('local', 'legacy-purchase')).toEqual(
      {
        lastNotifiedPriceCents: 799,
        purchaseId: 'legacy-purchase',
        urgencyBucket: '1-day',
      },
    );
    expect(secondOpen.getChannelAlertState('email', 'legacy-purchase')).toEqual(
      expected,
    );
    secondOpen.close();
  });
});
