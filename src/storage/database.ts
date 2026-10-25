import Sqlite from 'better-sqlite3';
import { initializeWatchSchema } from '../watch/store.js';

import type {
  NotificationResults,
  PriceObservation,
  Purchase,
  PurchaseChannel,
  RunSummary,
} from '../domain/types.js';
import {
  hardenPrivateRegularFileIfPresent,
  inspectRegularFileWithoutMutation,
  preparePrivateRegularFile,
} from '../lib/filesystem.js';

export interface AlertState {
  readonly lastNotifiedPriceCents: number;
  readonly purchaseId: string;
  readonly urgencyBucket: string;
}

export type AlertChannel = 'email' | 'local';

interface PurchaseRow {
  coupon_cents: number;
  description: string | null;
  gross_unit_cents: number | null;
  id: string;
  item_number: string;
  paid_unit_cents: number;
  purchase_channel: unknown;
  purchased_at: string;
  quantity: number;
  receipt_id: string;
  warehouse_number: string;
}

interface ObservationRow {
  evidence_json: string | null;
  item_number: string;
  observed_at: string;
  source: string;
  unit_price_cents: number | null;
  unresolved_reason: string | null;
  warehouse_number: string;
}

interface RunRow {
  alerts_sent: number;
  candidates_found: number;
  estimated_opportunities_found: number;
  diagnostic: string | null;
  finished_at: string;
  observations_recorded: number;
  outcome: RunSummary['outcome'];
  purchases_processed: number;
  started_at: string;
  unresolved_prices: number;
  notification_results: string | null;
  report_files: string | null;
}

interface AlertStateRow {
  last_notified_price_cents: number;
  purchase_id: string;
  urgency_bucket: string;
}

export class Database {
  private readonly observationEvidenceSelection: string;
  private readonly purchaseChannelSelection: string;
  private readonly runDiagnosticSelection: string;
  private readonly runReportFilesSelection: string;
  private readonly runEstimatedOpportunitiesSelection: string;

  private constructor(
    private readonly sqlite: ReturnType<typeof Sqlite>,
    initializeSchema: boolean,
  ) {
    this.sqlite.pragma('foreign_keys = ON');
    if (!initializeSchema) {
      this.observationEvidenceSelection = this.hasColumn(
        'price_observations',
        'evidence_json',
      )
        ? 'evidence_json'
        : 'NULL AS evidence_json';
      this.purchaseChannelSelection = this.hasColumn(
        'purchases',
        'purchase_channel',
      )
        ? 'purchase_channel'
        : "'warehouse' AS purchase_channel";
      this.runDiagnosticSelection = this.hasColumn('runs', 'diagnostic')
        ? 'diagnostic'
        : 'NULL AS diagnostic';
      this.runReportFilesSelection = this.hasColumn('runs', 'report_files')
        ? 'report_files'
        : 'NULL AS report_files';
      this.runEstimatedOpportunitiesSelection = this.hasColumn(
        'runs',
        'estimated_opportunities_found',
      )
        ? 'estimated_opportunities_found'
        : '0 AS estimated_opportunities_found';
      return;
    }
    this.sqlite.exec(`
      CREATE TABLE IF NOT EXISTS purchases (
        id TEXT PRIMARY KEY,
        description TEXT,
        receipt_id TEXT NOT NULL,
        item_number TEXT NOT NULL,
        warehouse_number TEXT NOT NULL,
        purchase_channel TEXT NOT NULL DEFAULT 'warehouse',
        purchased_at TEXT NOT NULL,
        gross_unit_cents INTEGER,
        paid_unit_cents INTEGER NOT NULL,
        quantity INTEGER NOT NULL CHECK (quantity > 0),
        coupon_cents INTEGER NOT NULL CHECK (coupon_cents >= 0)
      );
      CREATE INDEX IF NOT EXISTS purchases_purchased_at_idx
        ON purchases (purchased_at);

      CREATE TABLE IF NOT EXISTS price_observations (
        id INTEGER PRIMARY KEY,
        item_number TEXT NOT NULL,
        warehouse_number TEXT NOT NULL,
        observed_at TEXT NOT NULL,
        unit_price_cents INTEGER,
        source TEXT NOT NULL,
        unresolved_reason TEXT
      );
      CREATE INDEX IF NOT EXISTS price_observations_lookup_idx
        ON price_observations (item_number, warehouse_number, observed_at DESC);

      CREATE TABLE IF NOT EXISTS alert_state (
        purchase_id TEXT PRIMARY KEY,
        last_notified_price_cents INTEGER NOT NULL,
        urgency_bucket TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS alert_delivery_state (
        channel TEXT NOT NULL CHECK (channel IN ('local', 'email')),
        purchase_id TEXT NOT NULL,
        last_notified_price_cents INTEGER NOT NULL,
        urgency_bucket TEXT NOT NULL,
        PRIMARY KEY (channel, purchase_id)
      );

      CREATE TABLE IF NOT EXISTS runs (
        id INTEGER PRIMARY KEY,
        started_at TEXT NOT NULL,
        finished_at TEXT,
        outcome TEXT,
        purchases_processed INTEGER,
        observations_recorded INTEGER,
        candidates_found INTEGER,
        estimated_opportunities_found INTEGER NOT NULL DEFAULT 0,
        alerts_sent INTEGER,
        unresolved_prices INTEGER,
        notification_results TEXT,
        report_files TEXT,
        diagnostic TEXT
      );
      CREATE INDEX IF NOT EXISTS runs_success_idx
        ON runs (outcome, finished_at DESC);
    `);
    initializeWatchSchema(this.sqlite);
    this.ensureColumn('price_observations', 'evidence_json', 'TEXT');
    this.observationEvidenceSelection = 'evidence_json';
    this.ensureColumn('purchases', 'description', 'TEXT');
    this.ensureColumn('purchases', 'gross_unit_cents', 'INTEGER');
    this.ensureColumn(
      'purchases',
      'purchase_channel',
      "TEXT NOT NULL DEFAULT 'warehouse'",
    );
    this.ensureColumn('runs', 'notification_results', 'TEXT');
    this.ensureColumn('runs', 'report_files', 'TEXT');
    this.ensureColumn('runs', 'diagnostic', 'TEXT');
    this.ensureColumn(
      'runs',
      'estimated_opportunities_found',
      'INTEGER NOT NULL DEFAULT 0',
    );
    this.runDiagnosticSelection = 'diagnostic';
    this.runReportFilesSelection = 'report_files';
    this.runEstimatedOpportunitiesSelection = 'estimated_opportunities_found';
    this.purchaseChannelSelection = 'purchase_channel';
    this.sqlite.exec(`
      INSERT OR IGNORE INTO alert_delivery_state (
        channel, purchase_id, last_notified_price_cents, urgency_bucket
      )
      SELECT 'local', purchase_id, last_notified_price_cents, urgency_bucket
      FROM alert_state;

      INSERT OR IGNORE INTO alert_delivery_state (
        channel, purchase_id, last_notified_price_cents, urgency_bucket
      )
      SELECT 'email', purchase_id, last_notified_price_cents, urgency_bucket
      FROM alert_state;
    `);
  }

  static open(path: string): Database {
    preparePrivateRegularFile(path);
    for (const suffix of ['-journal', '-shm', '-wal']) {
      hardenPrivateRegularFileIfPresent(`${path}${suffix}`);
    }
    const sqlite = new Sqlite(path);
    // Keep the personal database out of WAL mode so long-lived -wal/-shm
    // sidecars are not left alongside the owner-only main file.
    sqlite.pragma('journal_mode = DELETE');
    return new Database(sqlite, true);
  }

  static openReadOnly(path: string): Database {
    inspectRegularFileWithoutMutation(path);
    return new Database(
      new Sqlite(path, { fileMustExist: true, readonly: true }),
      false,
    );
  }

  private ensureColumn(table: string, column: string, type: string): void {
    if (!this.hasColumn(table, column)) {
      this.sqlite.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
    }
  }

  private hasColumn(table: string, column: string): boolean {
    return this.sqlite
      .prepare<[], { name: string }>(`PRAGMA table_info(${table})`)
      .all()
      .some((existing) => existing.name === column);
  }

  close(): void {
    this.sqlite.close();
  }

  upsertPurchases(purchases: readonly Purchase[]): void {
    const statement = this.sqlite.prepare(`
      INSERT INTO purchases (
        id, description, receipt_id, item_number, warehouse_number, purchased_at,
        gross_unit_cents, paid_unit_cents, quantity, coupon_cents, purchase_channel
      ) VALUES (
        @id, @description, @receiptId, @itemNumber, @warehouseNumber, @purchasedAt,
        @grossUnitCents, @paidUnitCents, @quantity, @couponCents, @purchaseChannel
      ) ON CONFLICT(id) DO UPDATE SET
        description = excluded.description,
        receipt_id = excluded.receipt_id,
        item_number = excluded.item_number,
        warehouse_number = excluded.warehouse_number,
        purchased_at = excluded.purchased_at,
        gross_unit_cents = excluded.gross_unit_cents,
        paid_unit_cents = excluded.paid_unit_cents,
        quantity = excluded.quantity,
        coupon_cents = excluded.coupon_cents,
        purchase_channel = excluded.purchase_channel
    `);
    const upsert = this.sqlite.transaction((items: readonly Purchase[]) => {
      for (const purchase of items) {
        const purchaseChannel = parsePurchaseChannel(purchase.purchaseChannel);
        statement.run({
          ...purchase,
          description: purchase.description ?? null,
          grossUnitCents: purchase.grossUnitCents ?? null,
          purchaseChannel,
        });
      }
    });

    upsert(purchases);
  }

  recordPriceObservations(observations: readonly PriceObservation[]): void {
    const statement = this.sqlite.prepare(`
      INSERT INTO price_observations (
        item_number, warehouse_number, observed_at, unit_price_cents, source,
        unresolved_reason, evidence_json
      ) VALUES (
        @itemNumber, @warehouseNumber, @observedAt, @unitPriceCents, @source,
        @unresolvedReason, @evidenceJson
      )
    `);
    const insert = this.sqlite.transaction(
      (items: readonly PriceObservation[]) => {
        for (const observation of items) {
          statement.run({
            ...observation,
            evidenceJson: observation.warehouseEvidence
              ? JSON.stringify(observation.warehouseEvidence)
              : null,
          });
        }
      },
    );

    insert(observations);
  }

  recentPurchases(since: string): Purchase[] {
    const rows = this.sqlite
      .prepare<[string], PurchaseRow>(
        `
        SELECT id, description, receipt_id, item_number, warehouse_number, purchased_at,
               gross_unit_cents, paid_unit_cents, quantity, coupon_cents,
               ${this.purchaseChannelSelection}
        FROM purchases
        WHERE purchased_at >= ?
        ORDER BY purchased_at ASC, id ASC
      `,
      )
      .all(since);

    return rows.map(toPurchase);
  }

  latestPriceObservations(): PriceObservation[] {
    const rows = this.sqlite
      .prepare<[], ObservationRow>(
        `
        SELECT item_number, warehouse_number, observed_at, unit_price_cents,
               source, unresolved_reason, evidence_json
        FROM (
          SELECT item_number, warehouse_number, observed_at, unit_price_cents,
                 source, unresolved_reason, ${this.observationEvidenceSelection},
                 ROW_NUMBER() OVER (
                   PARTITION BY item_number, warehouse_number
                   ORDER BY observed_at DESC, id DESC
                 ) AS observation_rank
          FROM price_observations
        )
        WHERE observation_rank = 1
        ORDER BY observed_at DESC
      `,
      )
      .all();

    return rows.map(toPriceObservation);
  }

  beginRun(startedAt: string): number {
    const result = this.sqlite
      .prepare<[string]>('INSERT INTO runs (started_at) VALUES (?)')
      .run(startedAt);
    return Number(result.lastInsertRowid);
  }

  finishRun(id: number, summary: RunSummary): void {
    this.sqlite
      .prepare<
        [
          string,
          RunSummary['outcome'],
          number,
          number,
          number,
          number,
          number,
          number,
          string | null,
          string | null,
          string | null,
          number,
        ]
      >(
        `
        UPDATE runs
        SET finished_at = ?, outcome = ?, purchases_processed = ?,
            observations_recorded = ?, candidates_found = ?,
            estimated_opportunities_found = ?, alerts_sent = ?,
            unresolved_prices = ?, notification_results = ?, diagnostic = ?,
            report_files = ?
        WHERE id = ?
      `,
      )
      .run(
        summary.finishedAt,
        summary.outcome,
        summary.purchasesProcessed,
        summary.observationsRecorded,
        summary.candidatesFound,
        summary.estimatedOpportunitiesFound ?? 0,
        summary.alertsSent,
        summary.unresolvedPrices,
        summary.notifications === undefined
          ? null
          : JSON.stringify(summary.notifications),
        summary.diagnostic ?? null,
        summary.reportFiles === undefined
          ? null
          : JSON.stringify(summary.reportFiles),
        id,
      );
  }

  getLastSuccessfulRun(): RunSummary | null {
    const row = this.sqlite
      .prepare<[], RunRow>(
        `
        SELECT started_at, finished_at, outcome, purchases_processed,
               observations_recorded, candidates_found,
               ${this.runEstimatedOpportunitiesSelection}, alerts_sent,
               unresolved_prices, notification_results,
               ${this.runDiagnosticSelection},
               ${this.runReportFilesSelection}
        FROM runs
        WHERE outcome = 'success'
        ORDER BY finished_at DESC, id DESC
        LIMIT 1
      `,
      )
      .get();

    return row ? toRunSummary(row) : null;
  }

  getLatestRun(): RunSummary | null {
    const row = this.sqlite
      .prepare<[], RunRow>(
        `
        SELECT started_at, finished_at, outcome, purchases_processed,
               observations_recorded, candidates_found,
               ${this.runEstimatedOpportunitiesSelection}, alerts_sent,
               unresolved_prices, notification_results,
               ${this.runDiagnosticSelection},
               ${this.runReportFilesSelection}
        FROM runs
        WHERE outcome IS NOT NULL
        ORDER BY id DESC
        LIMIT 1
      `,
      )
      .get();

    return row ? toRunSummary(row) : null;
  }

  getAlertState(purchaseId: string): AlertState | null {
    const row = this.sqlite
      .prepare<[string], AlertStateRow>(
        `
        SELECT purchase_id, last_notified_price_cents, urgency_bucket
        FROM alert_state
        WHERE purchase_id = ?
      `,
      )
      .get(purchaseId);

    return row ? toAlertState(row) : null;
  }

  saveAlertState(state: AlertState): void {
    this.sqlite
      .prepare<AlertState>(
        `
        INSERT INTO alert_state (
          purchase_id, last_notified_price_cents, urgency_bucket
        ) VALUES (
          @purchaseId, @lastNotifiedPriceCents, @urgencyBucket
        ) ON CONFLICT(purchase_id) DO UPDATE SET
          last_notified_price_cents = excluded.last_notified_price_cents,
          urgency_bucket = excluded.urgency_bucket
      `,
      )
      .run(state);
  }

  getChannelAlertState(
    channel: AlertChannel,
    purchaseId: string,
  ): AlertState | null {
    const row = this.sqlite
      .prepare<[AlertChannel, string], AlertStateRow>(
        `
        SELECT purchase_id, last_notified_price_cents, urgency_bucket
        FROM alert_delivery_state
        WHERE channel = ? AND purchase_id = ?
      `,
      )
      .get(channel, purchaseId);

    return row ? toAlertState(row) : null;
  }

  saveChannelAlertState(channel: AlertChannel, state: AlertState): void {
    this.sqlite
      .prepare<AlertState & { channel: AlertChannel }>(
        `
        INSERT INTO alert_delivery_state (
          channel, purchase_id, last_notified_price_cents, urgency_bucket
        ) VALUES (
          @channel, @purchaseId, @lastNotifiedPriceCents, @urgencyBucket
        ) ON CONFLICT(channel, purchase_id) DO UPDATE SET
          last_notified_price_cents = excluded.last_notified_price_cents,
          urgency_bucket = excluded.urgency_bucket
      `,
      )
      .run({ ...state, channel });
  }
}

function toPurchase(row: PurchaseRow): Purchase {
  return {
    couponCents: row.coupon_cents,
    ...(row.description === null ? {} : { description: row.description }),
    ...(row.gross_unit_cents === null
      ? {}
      : { grossUnitCents: row.gross_unit_cents }),
    id: row.id,
    itemNumber: row.item_number,
    paidUnitCents: row.paid_unit_cents,
    purchaseChannel: parsePurchaseChannel(row.purchase_channel),
    purchasedAt: row.purchased_at,
    quantity: row.quantity,
    receiptId: row.receipt_id,
    warehouseNumber: row.warehouse_number,
  };
}

function parsePurchaseChannel(value: unknown): PurchaseChannel {
  if (value === 'warehouse' || value === 'costco_com') {
    return value;
  }
  throw new TypeError('Invalid purchase channel.');
}

function toPriceObservation(row: ObservationRow): PriceObservation {
  return {
    ...(row.evidence_json === null
      ? {}
      : {
          warehouseEvidence: JSON.parse(row.evidence_json) as NonNullable<
            PriceObservation['warehouseEvidence']
          >,
        }),
    itemNumber: row.item_number,
    observedAt: row.observed_at,
    source: row.source,
    unitPriceCents: row.unit_price_cents,
    unresolvedReason: row.unresolved_reason,
    warehouseNumber: row.warehouse_number,
  };
}

function toRunSummary(row: RunRow): RunSummary {
  const notifications = parseNotificationResults(row.notification_results);
  const reportFiles = parseReportFiles(row.report_files);
  return {
    alertsSent: row.alerts_sent,
    candidatesFound: row.candidates_found,
    ...(row.estimated_opportunities_found === 0
      ? {}
      : {
          estimatedOpportunitiesFound: row.estimated_opportunities_found,
        }),
    finishedAt: row.finished_at,
    observationsRecorded: row.observations_recorded,
    outcome: row.outcome,
    purchasesProcessed: row.purchases_processed,
    startedAt: row.started_at,
    unresolvedPrices: row.unresolved_prices,
    ...(row.diagnostic === null ? {} : { diagnostic: row.diagnostic }),
    ...(notifications === null ? {} : { notifications }),
    ...(reportFiles === null ? {} : { reportFiles }),
  };
}

function parseReportFiles(
  value: string | null,
): RunSummary['reportFiles'] | null {
  if (value === null) return null;
  const parsed: unknown = JSON.parse(value);
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    !('htmlFile' in parsed) ||
    !('csvFile' in parsed) ||
    !('jsonFile' in parsed)
  ) {
    return null;
  }
  return parsed as NonNullable<RunSummary['reportFiles']>;
}

function parseNotificationResults(
  value: string | null,
): NotificationResults | null {
  if (value === null) return null;
  const parsed: unknown = JSON.parse(value);
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    !('email' in parsed) ||
    !('local' in parsed)
  ) {
    return null;
  }
  return parsed as NotificationResults;
}

function toAlertState(row: AlertStateRow): AlertState {
  return {
    lastNotifiedPriceCents: row.last_notified_price_cents,
    purchaseId: row.purchase_id,
    urgencyBucket: row.urgency_bucket,
  };
}
