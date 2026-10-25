import type { AppConfig } from '../config/config.js';
import type { RunSummary } from '../domain/types.js';
import { errorSummary } from '../lib/diagnostics.js';

/** Most recent local receipt trigger, including a trigger missed during sleep. */
export function receiptScheduleDue(
  config: AppConfig,
  last: RunSummary | null,
  now: Date,
): boolean {
  if (last !== null && Date.parse(last.finishedAt) > now.getTime()) return true;
  const due = new Date(now);
  due.setHours(config.scheduledHour, config.scheduledMinute, 0, 0);
  if (due > now) due.setDate(due.getDate() - 1);
  if (config.scheduledWeekday !== null) {
    while (due.getDay() !== config.scheduledWeekday)
      due.setDate(due.getDate() - 1);
  }
  return last === null || Date.parse(last.finishedAt) < due.getTime();
}
export interface ScheduledSummary extends RunSummary {
  readonly watchCheck?: string;
  readonly watchFailed?: boolean;
}
/** Each callback acquires/releases the same flock. Never overlap profile lifecycles. */
export async function dispatchScheduledChecks(
  watch: () => Promise<{ status: string; text: string }>,
  receipts: () => Promise<RunSummary>,
): Promise<ScheduledSummary> {
  let watchCheck: string;
  let watchFailed = false;
  try {
    const result = await watch();
    watchCheck = result.text;
    watchFailed = result.status === 'failure';
  } catch (error) {
    watchCheck = errorSummary(error, 'scheduled watch check');
    watchFailed = true;
  }
  // Receipt failures cannot stop a watch attempt, and watch failures cannot stop receipts.
  return { ...(await receipts()), watchCheck, watchFailed };
}
