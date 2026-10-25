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
import { renderDrops, type MailSender } from './email.js';
import { errorSummary, sanitizeDiagnosticText } from '../lib/diagnostics.js';
import type { FailureDetails, FailureStage } from '../scheduler/failure.js';
import { AuthRequiredError } from '../costco/errors.js';

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
  failure?: FailureDetails;
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
  let stage: FailureStage = 'watch sources';
  let failure: FailureDetails | undefined;
  try {
    stage = 'storage';
    const warehouseLows = new Map<number, Low>();
    for (const item of items) {
      const low = store.low(item.id, 'warehouse');
      if (low) warehouseLows.set(item.id, low);
    }
    stage = 'watch sources';
    source = items.length ? await fetcher(items, warehouseLows) : empty;
    diagnostics.push(...source.diagnostics.map(sanitizeDiagnosticText));
    stage = 'watch validation';
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
    if (failed) failure = { stage: 'watch sources' };
    stage = 'storage';
    store.transaction(() => {
      if (!options.dryRun) {
        for (const item of items) {
          const name = source.productNames?.get(item.id)?.trim();
          if (name && store.fillName(item, name)) item.name = name;
        }
      }
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
    failure = { stage, loginRequired: error instanceof AuthRequiredError };
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
      failure ??= { stage: 'email delivery' };
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
    } else if (source.session === 'signed_out')
      store.setState('sessionExpired', 'true');
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
  return {
    status,
    drops,
    source,
    diagnostics,
    ...(failure
      ? {
          failure: {
            ...failure,
            loginRequired:
              failure.loginRequired || source.session === 'signed_out',
          },
        }
      : {}),
  };
}
