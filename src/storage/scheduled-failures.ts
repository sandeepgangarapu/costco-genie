import type Sqlite from 'better-sqlite3';
import type { FailureRecord } from '../scheduler/failure.js';

export function initializeScheduledFailureSchema(db: Sqlite.Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS scheduled_failure_notifications (
    job TEXT NOT NULL CHECK (job IN ('receipt', 'watch')),
    local_day TEXT NOT NULL,
    failed_at TEXT NOT NULL,
    stage TEXT NOT NULL,
    login_required INTEGER NOT NULL,
    delivery TEXT NOT NULL CHECK (delivery IN ('pending', 'delivered', 'failed')),
    delivery_error TEXT,
    PRIMARY KEY (job, local_day)
  )`);
}

export function claimScheduledFailure(
  db: Sqlite.Database,
  record: FailureRecord,
): boolean {
  const claimed =
    db
      .prepare(
        `INSERT OR IGNORE INTO scheduled_failure_notifications
    (job, local_day, failed_at, stage, login_required, delivery, delivery_error)
    VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.job,
        record.localDay,
        record.failedAt,
        record.stage,
        Number(record.loginRequired === true),
        record.delivery,
        record.deliveryError,
      ).changes > 0;
  if (!claimed) {
    // Keep diagnostics current on repeated failures without changing the
    // original day's delivery reservation or retrying its email.
    db.prepare(
      `UPDATE scheduled_failure_notifications SET failed_at=?, stage=?, login_required=?
      WHERE job=? AND local_day=? AND failed_at<?`,
    ).run(
      record.failedAt,
      record.stage,
      Number(record.loginRequired === true),
      record.job,
      record.localDay,
      record.failedAt,
    );
  }
  return claimed;
}

export function finishScheduledFailure(
  db: Sqlite.Database,
  record: FailureRecord,
): void {
  db.prepare(
    `UPDATE scheduled_failure_notifications SET delivery=?, delivery_error=?
    WHERE job=? AND local_day=?`,
  ).run(record.delivery, record.deliveryError, record.job, record.localDay);
}

export function lastScheduledFailures(db: Sqlite.Database): FailureRecord[] {
  if (
    !db
      .prepare(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name='scheduled_failure_notifications'",
      )
      .get()
  )
    return [];
  const rows = db
    .prepare(
      `SELECT job, local_day AS localDay, failed_at AS failedAt, stage,
    login_required AS loginRequired, delivery, delivery_error AS deliveryError
    FROM scheduled_failure_notifications n WHERE local_day=(
      SELECT local_day FROM scheduled_failure_notifications WHERE job=n.job
      ORDER BY failed_at DESC, local_day DESC LIMIT 1
    ) ORDER BY job`,
    )
    .all() as FailureRecord[];
  return rows.map((row) => ({
    ...row,
    loginRequired: Boolean(row.loginRequired),
  }));
}
