import type { AppConfig } from '../config/config.js';
import type { RunSummary } from '../domain/types.js';
import { errorSummary } from '../lib/diagnostics.js';
import { AuthRequiredError } from '../costco/errors.js';
import { RunOverlapError } from '../lib/process.js';
import type { FailureDetails, ScheduledFailure } from './failure.js';

/** Most recent local receipt trigger, including a trigger missed during sleep. */
export function receiptScheduleDue(
  config: AppConfig,
  last: RunSummary | null,
  now: Date,
): boolean {
  if (last !== null && Date.parse(last.finishedAt) > now.getTime()) return true;
  if (last === null) {
    // RunAtLoad/daily watches must not invent a missed receipt trigger when
    // there is no history yet. The initial skip records a catch-up anchor.
    return (
      (config.scheduledWeekday === null ||
        now.getDay() === config.scheduledWeekday) &&
      now.getHours() * 60 + now.getMinutes() >=
        config.scheduledHour * 60 + config.scheduledMinute
    );
  }
  const due = new Date(now);
  due.setHours(config.scheduledHour, config.scheduledMinute, 0, 0);
  if (due > now) due.setDate(due.getDate() - 1);
  if (config.scheduledWeekday !== null) {
    while (due.getDay() !== config.scheduledWeekday)
      due.setDate(due.getDate() - 1);
  }
  return Date.parse(last.finishedAt) < due.getTime();
}
export interface ScheduledSummary extends RunSummary {
  readonly watchCheck?: string;
  readonly watchFailed?: boolean;
}
/** Each callback acquires/releases the same flock. Never overlap profile lifecycles. */
export async function dispatchScheduledChecks(
  watch: () => Promise<{
    status: string;
    text: string;
    failure?: FailureDetails;
  }>,
  receipts: () => Promise<RunSummary>,
  now: () => Date = () => new Date(),
  onFailure?: (failure: ScheduledFailure) => Promise<void>,
): Promise<ScheduledSummary> {
  const startedAt = now().toISOString();
  let watchCheck: string;
  let watchFailed = false;
  const failures: ScheduledFailure[] = [];
  try {
    const result = await watch();
    watchCheck = result.text;
    watchFailed = result.status === 'failure';
    if (watchFailed)
      failures.push({
        job: 'watch',
        failedAt: now().toISOString(),
        ...(result.failure ?? { stage: 'watch check' }),
      });
  } catch (error) {
    watchCheck = errorSummary(error, 'scheduled watch check');
    watchFailed = true;
    failures.push({
      job: 'watch',
      failedAt: now().toISOString(),
      ...callbackFailure(error, 'watch check'),
    });
  }
  // Receipt failures cannot stop a watch attempt, and watch failures cannot stop receipts.
  let summary: ScheduledSummary;
  try {
    const receipt = await receipts();
    summary = { ...receipt, watchCheck, watchFailed };
    if (receipt.outcome === 'failure' || receipt.outcome === 'auth_required')
      failures.push({
        job: 'receipt',
        failedAt: receipt.finishedAt,
        ...(receipt.failure ?? {
          stage:
            receipt.outcome === 'auth_required'
              ? 'authentication'
              : 'receipt check',
          loginRequired: receipt.outcome === 'auth_required',
        }),
      });
  } catch (error) {
    // Storage/lock/report cleanup errors can escape the receipt runner. Keep the
    // completed watch outcome visible in launchd output even in that case.
    summary = {
      startedAt,
      finishedAt: now().toISOString(),
      outcome: 'failure',
      purchasesProcessed: 0,
      observationsRecorded: 0,
      candidatesFound: 0,
      alertsSent: 0,
      unresolvedPrices: 0,
      diagnostic: errorSummary(error, 'scheduled receipt check'),
      watchCheck,
      watchFailed,
    };
    failures.push({
      job: 'receipt',
      failedAt: summary.finishedAt,
      ...callbackFailure(error, 'receipt check'),
    });
  }
  // Deliver only after both jobs finish. A notification failure never changes
  // either job's outcome or prevents the other job from running.
  for (const failure of failures) {
    try {
      await onFailure?.(failure);
    } catch (error) {
      console.error(errorSummary(error, 'scheduled failure notification'));
    }
  }
  return summary;
}

function callbackFailure(
  error: unknown,
  stage: 'receipt check' | 'watch check',
): FailureDetails {
  if (error instanceof AuthRequiredError)
    return { stage: 'authentication', loginRequired: true };
  if (error instanceof RunOverlapError) return { stage: 'run lock' };
  if (error instanceof Error && error.name === 'SqliteError')
    return { stage: 'storage' };
  return { stage };
}
