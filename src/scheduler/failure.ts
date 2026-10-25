import type { AppConfig } from '../config/config.js';
import type { LocalNotifier, MailNotifier } from '../app/run.js';
import { errorSummary } from '../lib/diagnostics.js';
import { localDay } from '../watch/check.js';
import { notice } from '../watch/email.js';

export type ScheduledJob = 'receipt' | 'watch';
export type FailureStage =
  | 'authentication'
  | 'session access'
  | 'purchase import'
  | 'price lookup'
  | 'storage'
  | 'run lock'
  | 'watch sources'
  | 'watch validation'
  | 'email delivery'
  | 'receipt check'
  | 'watch check';
export interface FailureDetails {
  readonly stage: FailureStage;
  readonly loginRequired?: boolean;
}
export interface ScheduledFailure extends FailureDetails {
  readonly job: ScheduledJob;
  readonly failedAt: string;
}
export interface FailureRecord extends ScheduledFailure {
  readonly localDay: string;
  readonly delivery: 'pending' | 'delivered' | 'failed';
  readonly deliveryError: string | null;
}
export interface FailureStore {
  claimScheduledFailure(record: FailureRecord): boolean;
  finishScheduledFailure(record: FailureRecord): void;
  close(): void;
}

const REASONS: Record<FailureStage, string> = {
  authentication:
    'The Costco session is expired, invalid, or requires sign-in.',
  'session access': 'The dedicated Costco browser session could not be read.',
  'purchase import': 'Receipt or Costco.com order import did not complete.',
  'price lookup': 'The receipt price lookup could not complete.',
  storage: 'Local run data could not be read or saved.',
  'run lock': 'The shared run lock could not be acquired.',
  'watch sources': 'Watch price sources failed or returned no usable prices.',
  'watch validation':
    'Watch price sources returned incomplete or invalid observations.',
  'email delivery': 'The check could not deliver its required email.',
  'receipt check':
    'The receipt callback failed, including possible lock, storage, or report errors.',
  'watch check':
    'The watch callback failed, including possible lock or storage errors.',
};

export function nextScheduledAttempt(
  job: ScheduledJob,
  config: AppConfig,
  failedAt: Date,
): Date {
  const next = new Date(failedAt);
  next.setHours(
    job === 'watch' ? config.watchScheduledHour : config.scheduledHour,
    job === 'watch' ? config.watchScheduledMinute : config.scheduledMinute,
    0,
    0,
  );
  // Calendar operations preserve wall-clock schedules across DST transitions.
  while (
    next <= failedAt ||
    (job === 'receipt' &&
      config.scheduledWeekday !== null &&
      next.getDay() !== config.scheduledWeekday)
  )
    next.setDate(next.getDate() + 1);
  return next;
}

export function renderScheduledFailure(
  failure: ScheduledFailure,
  config: AppConfig,
  logPath: string,
  attemptedAt = new Date(failure.failedAt),
) {
  const label = failure.job === 'receipt' ? 'receipt run' : 'watch check';
  const failedAt = new Date(failure.failedAt);
  const next = nextScheduledAttempt(failure.job, config, attemptedAt);
  const format = (date: Date) =>
    `${date.toLocaleString(undefined, {
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      timeZoneName: 'short',
    })} (local time)`;
  // Use fixed operational summaries rather than arbitrary service diagnostics:
  // redacting credentials alone cannot remove product names or purchase details.
  const reason = failure.loginRequired
    ? REASONS.authentication
    : REASONS[failure.stage];
  const action = failure.loginRequired
    ? 'run `./costco login`, sign in, close the dedicated Chrome window, then `./costco run`'
    : `run \`./costco doctor\` and inspect the log: ${logPath}`;
  return notice(
    `Costco Genie: ${label} failed`,
    [
      `The scheduled ${label} failed.`,
      `When: ${format(failedAt)}`,
      `Stage: ${failure.stage}`,
      `Reason: ${reason}`,
      `Next step: ${action}.`,
      `Next scheduled attempt: ${format(next)}.`,
      ...(failure.job === 'receipt' && config.scheduledWeekday !== null
        ? [
            'A completed failed weekly receipt run otherwise waits for the next configured weekday; daily watch triggers do not retry it.',
          ]
        : []),
      'Scheduled checks require the Mac to be running in your session; sleep can delay an attempt. Watches can also retry at load or wake.',
      ...(failure.job === 'receipt'
        ? [
            'If the failure prevented recording a completed receipt attempt, later dispatches may retry sooner.',
          ]
        : []),
    ].join('\n'),
  );
}

/** Reserve before sending: even a crash or failed delivery cannot spam this day. */
export async function notifyScheduledFailure(
  failure: ScheduledFailure,
  dependencies: {
    config: AppConfig;
    logPath: string;
    openStore: () => FailureStore;
    mail: () => MailNotifier;
    local: () => LocalNotifier;
    log: (message: string) => void;
    now: () => Date;
  },
): Promise<void> {
  let store: FailureStore | undefined;
  let fallbackAttempted = false;
  const attemptedAt = dependencies.now();
  let record: FailureRecord = {
    ...failure,
    localDay: localDay(attemptedAt),
    delivery: 'pending',
    deliveryError: null,
  };
  const message = renderScheduledFailure(
    failure,
    dependencies.config,
    dependencies.logPath,
    attemptedAt,
  );
  try {
    store = dependencies.openStore();
    if (!store.claimScheduledFailure(record)) return;
    try {
      const mail = dependencies.mail();
      const recipient =
        dependencies.config.emailRecipient ??
        (await mail.resolveSelfRecipient());
      if (dependencies.config.smtpConfigPath === null)
        await mail.send(recipient, message.subject, message.text);
      else
        await mail.send(recipient, message.subject, message.text, message.html);
      record = { ...record, delivery: 'delivered' };
    } catch (error) {
      record = {
        ...record,
        delivery: 'failed',
        deliveryError: errorSummary(
          error,
          `${failure.job} failure email delivery`,
        ),
      };
      dependencies.log(record.deliveryError!);
      await fallback();
    }
    store.finishScheduledFailure(record);
  } catch (error) {
    dependencies.log(
      errorSummary(error, 'scheduled failure notification state'),
    );
    // Without a durable reservation, sending mail could violate daily dedupe.
    await fallback();
  } finally {
    try {
      store?.close();
    } catch (error) {
      dependencies.log(errorSummary(error, 'close failure notification state'));
    }
  }
  async function fallback() {
    if (fallbackAttempted) return;
    fallbackAttempted = true;
    try {
      await dependencies.local().send(message.subject, message.text);
    } catch (error) {
      dependencies.log(errorSummary(error, 'failure local notification'));
    }
  }
}
