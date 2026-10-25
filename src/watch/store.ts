// SQLite/file hardening adapted from costco-genie/src/storage/database.ts.
import Database from 'better-sqlite3';
import { dirname } from 'node:path';
import {
  ensurePrivateDirectory,
  hardenPrivateRegularFileIfPresent,
  inspectRegularFileWithoutMutation,
  preparePrivateRegularFile,
} from '../lib/filesystem.js';
import type { Drop, Low, Observation, PriceKind, WatchItem } from './domain.js';

export interface PendingDrop {
  id: number;
  drop: Drop;
}
export class Store {
  readonly db: Database.Database;
  private lowsHaveUnit = false;
  readonly hasSchema: boolean;
  constructor(path: string, readonly = false) {
    if (path !== ':memory:') {
      if (readonly) inspectRegularFileWithoutMutation(path);
      else {
        ensurePrivateDirectory(dirname(path));
        preparePrivateRegularFile(path);
        for (const suffix of ['-journal', '-wal', '-shm'])
          hardenPrivateRegularFileIfPresent(path + suffix);
      }
    }
    this.db = new Database(path, { readonly, fileMustExist: readonly });
    this.db.pragma('foreign_keys = ON');
    this.db.pragma('busy_timeout = 5000');
    this.hasSchema =
      Boolean(
        this.db
          .prepare(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name='watch_items'",
          )
          .get(),
      ) || !readonly;
    if (readonly) {
      this.db.pragma('query_only = ON');
      this.lowsHaveUnit = (
        this.db.prepare('PRAGMA table_info(watch_lows)').all() as {
          name: string;
        }[]
      ).some((c) => c.name === 'unit_basis');
      return;
    }
    this.db.pragma('journal_mode = DELETE');
    initializeWatchSchema(this.db);
    this.lowsHaveUnit = true;
  }
  close(): void {
    this.db.close();
  }
  transaction<T>(action: () => T): T {
    return this.db.transaction(action)();
  }
  items(): WatchItem[] {
    if (!this.hasSchema) return [];
    return this.db
      .prepare(
        `SELECT id,item_number AS itemNumber,name,url,channel,added_at AS addedAt FROM watch_items WHERE active=1 ORDER BY id`,
      )
      .all() as WatchItem[];
  }
  find(input: string): WatchItem | undefined {
    if (!this.hasSchema) return undefined;
    return this.db
      .prepare(
        `SELECT id,item_number AS itemNumber,name,url,channel,added_at AS addedAt FROM watch_items WHERE item_number=? ORDER BY active DESC,id DESC LIMIT 1`,
      )
      .get(input) as WatchItem | undefined;
  }
  add(item: Omit<WatchItem, 'id'>): WatchItem {
    const existing = this.items().find((i) => i.itemNumber === item.itemNumber);
    if (existing) {
      this.db
        .prepare('UPDATE watch_items SET name=?,url=?,channel=? WHERE id=?')
        .run(item.name, item.url, item.channel, existing.id);
      return {
        ...existing,
        name: item.name,
        url: item.url,
        channel: item.channel,
      };
    }
    const result = this.db
      .prepare(
        'INSERT INTO watch_items(item_number,name,url,channel,added_at) VALUES(?,?,?,?,?)',
      )
      .run(item.itemNumber, item.name, item.url, item.channel, item.addedAt);
    return { ...item, id: Number(result.lastInsertRowid) };
  }
  remove(itemNumber: string): boolean {
    return this.transaction(() => {
      const item = this.items().find((i) => i.itemNumber === itemNumber);
      if (!item) return false;
      this.db
        .prepare('UPDATE watch_items SET active=0 WHERE id=?')
        .run(item.id);
      this.db
        .prepare('DELETE FROM watch_alerts WHERE item_id=? AND sent_at IS NULL')
        .run(item.id);
      return true;
    });
  }
  low(itemId: number, kind: PriceKind): Low | undefined {
    if (!this.hasSchema) return undefined;
    return this.db
      .prepare(
        `SELECT item_id AS itemId,kind,baseline_cents AS baselineCents,low_cents AS lowCents,${this.lowsHaveUnit ? 'unit_basis' : "'unknown'"} AS unitBasis FROM watch_lows WHERE item_id=? AND kind=?`,
      )
      .get(itemId, kind) as Low | undefined;
  }
  saveLow(low: Low): void {
    this.db
      .prepare(
        `INSERT INTO watch_lows(item_id,kind,baseline_cents,low_cents,unit_basis) VALUES(?,?,?,?,?) ON CONFLICT(item_id,kind) DO UPDATE SET low_cents=excluded.low_cents`,
      )
      .run(
        low.itemId,
        low.kind,
        low.baselineCents,
        low.lowCents,
        low.unitBasis ?? 'unknown',
      );
  }
  observe(runId: number, o: Observation): void {
    this.db
      .prepare(
        `INSERT INTO watch_observations(run_id,item_id,kind,observed_at,cents,estimate_cents,source,reason,promo_end,evidence) VALUES(?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        runId,
        o.itemId,
        o.kind,
        o.observedAt,
        o.cents,
        o.estimateCents,
        o.source,
        o.reason,
        o.promoEnd,
        JSON.stringify(o.evidence),
      );
  }
  history(itemId: number): Observation[] {
    if (!this.hasSchema) return [];
    const rows = this.db
      .prepare(
        `SELECT item_id AS itemId,kind,observed_at AS observedAt,cents,estimate_cents AS estimateCents,source,reason,promo_end AS promoEnd,evidence FROM watch_observations WHERE item_id=? ORDER BY id DESC`,
      )
      .all(itemId) as Array<
      Omit<Observation, 'evidence'> & { evidence: string }
    >;
    return rows.map((row) => ({
      ...row,
      evidence: JSON.parse(row.evidence) as Observation['evidence'],
    }));
  }
  startRun(
    started: string,
    day: string,
    scheduled: boolean,
    full: boolean,
  ): number {
    return Number(
      this.db
        .prepare(
          'INSERT INTO watch_runs(started_at,local_day,scheduled,full_check) VALUES(?,?,?,?)',
        )
        .run(started, day, Number(scheduled), Number(full)).lastInsertRowid,
    );
  }
  finishRun(
    id: number,
    finished: string,
    status: string,
    diagnostic: string | null,
  ): void {
    this.db
      .prepare(
        'UPDATE watch_runs SET finished_at=?,status=?,diagnostic=? WHERE id=?',
      )
      .run(finished, status, diagnostic, id);
  }
  succeededToday(day: string): boolean {
    if (!this.hasSchema) return false;
    return Boolean(
      this.db
        .prepare(
          "SELECT 1 FROM watch_runs WHERE local_day=? AND full_check=1 AND status='success' LIMIT 1",
        )
        .get(day),
    );
  }
  runs(): unknown[] {
    if (!this.hasSchema) return [];
    return this.db
      .prepare(
        'SELECT id,started_at,finished_at,status,scheduled,diagnostic FROM watch_runs ORDER BY id DESC LIMIT 5',
      )
      .all();
  }
  state(key: string): string | undefined {
    if (!this.hasSchema) return undefined;
    return (
      this.db.prepare('SELECT value FROM watch_state WHERE key=?').get(key) as
        { value: string } | undefined
    )?.value;
  }
  setState(key: string, value: string): void {
    this.db
      .prepare(
        'INSERT INTO watch_state(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
      )
      .run(key, value);
  }
  queue(runId: number, drop: Drop): void {
    this.db
      .prepare('INSERT INTO watch_alerts(run_id,item_id,payload) VALUES(?,?,?)')
      .run(runId, drop.item.id, JSON.stringify(drop));
  }
  pending(): PendingDrop[] {
    if (!this.hasSchema) return [];
    return (
      this.db
        .prepare(
          'SELECT id,payload FROM watch_alerts WHERE sent_at IS NULL ORDER BY id',
        )
        .all() as { id: number; payload: string }[]
    ).map((row) => ({ id: row.id, drop: JSON.parse(row.payload) as Drop }));
  }
  markSent(ids: number[], at: string): void {
    this.transaction(() => {
      for (const id of ids)
        this.db
          .prepare('UPDATE watch_alerts SET sent_at=? WHERE id=?')
          .run(at, id);
    });
  }
}

export function initializeWatchSchema(db: Database.Database): void {
  db.exec(`
      CREATE TABLE IF NOT EXISTS watch_items (
        id INTEGER PRIMARY KEY, item_number TEXT NOT NULL, name TEXT NOT NULL,
        url TEXT NOT NULL, channel TEXT NOT NULL, added_at TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1
      );
      CREATE UNIQUE INDEX IF NOT EXISTS watch_active_item ON watch_items(item_number) WHERE active=1;
      CREATE TABLE IF NOT EXISTS watch_runs (
        id INTEGER PRIMARY KEY, started_at TEXT NOT NULL, finished_at TEXT,
        local_day TEXT NOT NULL, scheduled INTEGER NOT NULL, full_check INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'running', diagnostic TEXT
      );
      CREATE TABLE IF NOT EXISTS watch_observations (
        id INTEGER PRIMARY KEY, run_id INTEGER REFERENCES watch_runs(id), item_id INTEGER NOT NULL REFERENCES watch_items(id),
        kind TEXT NOT NULL, observed_at TEXT NOT NULL, cents INTEGER, estimate_cents INTEGER,
        source TEXT NOT NULL, reason TEXT, promo_end TEXT, evidence TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS watch_item_observations ON watch_observations(item_id, kind, id DESC);
      CREATE TABLE IF NOT EXISTS watch_lows (
        item_id INTEGER REFERENCES watch_items(id), kind TEXT, baseline_cents INTEGER NOT NULL,
        low_cents INTEGER NOT NULL, PRIMARY KEY(item_id,kind)
      );
      CREATE TABLE IF NOT EXISTS watch_alerts (
        id INTEGER PRIMARY KEY, run_id INTEGER REFERENCES watch_runs(id), item_id INTEGER REFERENCES watch_items(id),
        payload TEXT NOT NULL, sent_at TEXT
      );
      CREATE TABLE IF NOT EXISTS watch_state (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    `);
  const columns = db.prepare('PRAGMA table_info(watch_lows)').all() as {
    name: string;
  }[];
  if (!columns.some((c) => c.name === 'unit_basis'))
    db.exec(
      "ALTER TABLE watch_lows ADD COLUMN unit_basis TEXT NOT NULL DEFAULT 'unknown'",
    );
}
