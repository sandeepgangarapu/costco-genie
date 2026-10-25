// Ported from Costco Price Drop Checker; integrated with matcher boundaries.
import {
  evaluateLow,
  kindsFor,
  usable,
  type Drop,
  type Low,
  type SourceResult,
  type WatchItem,
} from './domain.js';
import type { AppConfig } from '../config/config.js';
import { Store } from './store.js';
import { notice, renderDrops, type MailSender } from './email.js';
import { errorSummary, sanitizeDiagnosticText } from '../lib/diagnostics.js';

export type SourceFetcher = (
  items: WatchItem[],
  warehouseLows?: ReadonlyMap<number, Low>,
) => Promise<SourceResult>;
export interface CheckOptions {
  dryRun?: boolean;
  itemNumber?: string;
  scheduled?: boolean;
  baseline?: boolean;
}
export interface CheckResult {
  status: 'success' | 'failure' | 'skipped' | 'dry-run';
  drops: Drop[];
  source: SourceResult;
  diagnostics: string[];
}
export function localDay(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}
export async function check(
  store: Store,
  config: AppConfig,
  fetcher: SourceFetcher,
  mail: MailSender,
  options: CheckOptions = {},
  now = () => new Date(),
): Promise<CheckResult> {
  const started = now();
  const day = localDay(started);
  const empty: SourceResult = {
    observations: [],
    diagnostics: [],
    session: 'not_attempted',
  };
  if (options.scheduled && !options.dryRun && store.succeededToday(day))
    return {
      status: 'skipped',
      drops: [],
      source: empty,
      diagnostics: ['A full check already succeeded today.'],
    };
  const items = store
    .items()
    .filter(
      (item) => !options.itemNumber || item.itemNumber === options.itemNumber,
    );
  if (options.itemNumber && items.length === 0)
    throw new Error('Item is not active in the watchlist');
  const run = options.dryRun
    ? null
    : store.startRun(
        started.toISOString(),
        day,
        options.scheduled === true,
        !options.itemNumber && !options.baseline,
      );
  let source = empty;
  const diagnostics: string[] = [];
  const drops: Drop[] = [];
  let failed = false;
  let stage = 'fetch sources';
  try {
    const warehouseLows = new Map<number, Low>();
    for (const item of items) {
      const low = store.low(item.id, 'warehouse');
      if (low) warehouseLows.set(item.id, low);
    }
    source = items.length ? await fetcher(items, warehouseLows) : empty;
    diagnostics.push(...source.diagnostics.map(sanitizeDiagnosticText));
    stage = 'validate observations';
    const expected = new Set(
      items.flatMap((item) =>
        kindsFor(item.channel).map((kind) => `${item.id}:${kind}`),
      ),
    );
    const seen = new Set<string>();
    for (const o of source.observations) {
      const key = `${o.itemId}:${o.kind}`;
      if (!expected.has(key) || seen.has(key))
        throw new Error(
          'Price source returned an unexpected or duplicate observation',
        );
      seen.add(key);
    }
    if (seen.size !== expected.size)
      throw new Error('Price source omitted an expected observation');
    failed = items.length > 0 && !source.observations.some(usable);
    stage = 'record observations and evaluate lows';
    store.transaction(() => {
      for (const o of source.observations) {
        const old = store.low(o.itemId, o.kind);
        const evaluated = evaluateLow(old, o, config.minimumDropCents);
        if (evaluated.unverifiedReason)
          o.evidence.unverifiedReason = evaluated.unverifiedReason;
        if (evaluated.unverifiedReason)
          diagnostics.push(
            `Item ${o.itemId} (${o.kind}): unverified — check before buying. ${evaluated.unverifiedReason} Stored low unchanged.`,
          );
        // An unverified drop leaves the stored low unchanged, so remember the
        // lowest unverified price already alerted to avoid repeating it daily.
        const unverifiedKey = `unverifiedAlerted:${String(o.itemId)}:${o.kind}`;
        const unverifiedRepeat =
          evaluated.unverifiedReason !== undefined &&
          Number(store.state(unverifiedKey) ?? Infinity) <= o.cents!;
        if (
          evaluated.alert &&
          evaluated.unverifiedReason &&
          !unverifiedRepeat &&
          !options.dryRun &&
          !options.baseline
        )
          store.setState(unverifiedKey, String(o.cents));
        if (evaluated.alert && old && !options.baseline && !unverifiedRepeat)
          drops.push({
            item: items.find((i) => i.id === o.itemId)!,
            observation: o,
            previousLowCents: old.lowCents,
            baselineCents: old.baselineCents,
            ...(evaluated.unverifiedReason
              ? { unverifiedReason: evaluated.unverifiedReason }
              : {}),
          });
        if (!options.dryRun) {
          store.observe(run!, o);
          if (evaluated.low) store.saveLow(evaluated.low);
        }
      }
      if (!options.dryRun) for (const drop of drops) store.queue(run!, drop);
    });
  } catch (error) {
    failed = true;
    drops.length = 0;
    diagnostics.push(errorSummary(error, stage));
  }
  if (options.dryRun) return { status: 'dry-run', drops, source, diagnostics };
  if (!options.baseline) {
    try {
      const pending = store.pending();
      if (pending.length) {
        await mail(renderDrops(pending.map((p) => p.drop)));
        store.markSent(
          pending.map((p) => p.id),
          now().toISOString(),
        );
      }
    } catch (error) {
      failed = true;
      diagnostics.push(
        errorSummary(error, 'deliver price-drop email'),
        'Price-drop email failed; pending alerts will be retried on the next check.',
      );
    }
  }
  if (!options.baseline) {
    if (
      source.session === 'authenticated' ||
      source.session === 'not_required'
    ) {
      store.setState('sessionExpired', 'false');
      store.setState('sessionNotified', 'false');
    } else if (source.session === 'signed_out')
      store.setState('sessionExpired', 'true');
    if (
      source.session === 'signed_out' &&
      store.state('sessionExpired') === 'true' &&
      store.state('sessionNotified') !== 'true'
    ) {
      try {
        await mail(
          notice(
            'Costco Genie: Costco session expired — run ./costco login',
            'Run `./costco login` in costco-genie, sign in yourself, then close the dedicated Chrome window. Public price sources can continue working.',
          ),
        );
        store.setState('sessionNotified', 'true');
      } catch (error) {
        failed = true;
        diagnostics.push(
          errorSummary(error, 'deliver session-expiry email'),
          'Session-expiry email failed; the notice remains pending.',
        );
      }
    }
  }
  if (options.scheduled) {
    const streak = failed
      ? Number(store.state('scheduledFailures') ?? '0') + 1
      : 0;
    store.setState('scheduledFailures', String(streak));
    if (!failed) store.setState('failureNotified', 'false');
    if (streak >= 3 && store.state('failureNotified') !== 'true') {
      try {
        await mail(
          notice(
            'Costco Genie watchlist: 3 scheduled checks failed',
            'Three or more consecutive scheduled checks failed, or no source returned a usable price. Run ./costco doctor and ./costco watch check, and inspect the private logs.',
          ),
        );
        store.setState('failureNotified', 'true');
      } catch (error) {
        diagnostics.push(
          errorSummary(error, 'deliver operational email'),
          'Operational email failed; the notice will be retried.',
        );
      }
    }
  }
  const status = failed ? 'failure' : 'success';
  if (!failed && !options.baseline && !options.itemNumber)
    store.setState('lastSuccessfulCheck', now().toISOString());
  store.finishRun(
    run!,
    now().toISOString(),
    status,
    diagnostics.join(' ') || null,
  );
  return { status, drops, source, diagnostics };
}
