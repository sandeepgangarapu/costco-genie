import { Database } from '../storage/database.js';
import { parseArgs } from 'node:util';
import { existsSync } from 'node:fs';
import type { AppPaths } from '../config/paths.js';
import type { AppConfig } from '../config/config.js';
import type { RunLock } from '../app/run.js';
import { resolveProduct, parseItemInput } from '../costco/product.js';
import { check, type CheckResult, type SourceFetcher } from './check.js';
import { kindsFor, type Channel, type WatchItem } from './domain.js';
import { money, priceKindLabel, type MailSender } from './email.js';
import { Store } from './store.js';
import { formatPromoEnd } from '../lib/dates.js';

export interface WatchDependencies {
  paths: AppPaths;
  config: AppConfig;
  lock: RunLock;
  sources: SourceFetcher;
  mail: MailSender;
  now: () => Date;
  resolveProduct?: typeof resolveProduct;
}
export class WatchUsageError extends Error {}
export async function runWatchCli(
  args: readonly string[],
  deps: WatchDependencies,
): Promise<{ code: number; text: string }> {
  const [command, ...rest] = args;
  const definitions: Record<
    string,
    Record<string, { type: 'string' | 'boolean' }>
  > = {
    add: {
      channel: { type: 'string' },
      name: { type: 'string' },
      'no-check': { type: 'boolean' },
    },
    list: {},
    remove: {},
    history: {},
    check: { 'dry-run': { type: 'boolean' }, item: { type: 'string' } },
  };
  if (!command || !definitions[command])
    throw new WatchUsageError(
      'Use watch add, list, remove, history, or check; see ./costco help.',
    );
  let parsed;
  try {
    parsed = parseArgs({
      args: rest,
      options: definitions[command],
      allowPositionals: true,
      strict: true,
    });
  } catch {
    throw new WatchUsageError('Invalid watch options; see ./costco help.');
  }
  const { values, positionals } = parsed;
  const needsItem = ['add', 'remove', 'history'].includes(command);
  if (positionals.length !== (needsItem ? 1 : 0))
    throw new WatchUsageError(
      needsItem
        ? 'Specify exactly one item.'
        : 'Unexpected positional arguments.',
    );
  if (command === 'add') {
    try {
      parseItemInput(positionals[0]);
    } catch {
      throw new WatchUsageError(
        'Specify an item number or public Costco.com product URL.',
      );
    }
    if (
      !['both', 'warehouse', 'online'].includes(
        String(values.channel ?? 'both'),
      )
    )
      throw new WatchUsageError('channel must be online, warehouse, or both');
  } else if (
    (needsItem && !/^\d+$/u.test(positionals[0])) ||
    (values.item !== undefined && !/^\d+$/u.test(String(values.item)))
  )
    throw new WatchUsageError('Specify an item number.');
  const readonly =
    command === 'list' || command === 'history' || values['dry-run'] === true;
  if (readonly && !existsSync(deps.paths.databaseFile))
    return { code: 0, text: 'Watchlist is empty.' };
  if (values['dry-run'] === true) {
    const store = new Store(deps.paths.databaseFile, true);
    try {
      // Empty lists cannot visit the profile, and need no lock file creation.
      if (!store.items().length)
        return { code: 0, text: 'Watchlist is empty.' };
    } finally {
      store.close();
    }
  }
  const execute = async () => {
    if (!readonly) Database.open(deps.paths.databaseFile).close();
    const store = new Store(deps.paths.databaseFile, readonly);
    try {
      const lines: string[] = [];
      if (command === 'list') {
        for (const item of store.items()) {
          lines.push(`${item.itemNumber} | ${item.name} | ${item.channel}`);
          const history = store.history(item.id);
          for (const kind of kindsFor(item.channel)) {
            const current = history.find((o) => o.kind === kind);
            const low = store.low(item.id, kind);
            if (current && isNonErrorSkip(current.reason)) {
              lines.push(
                `  ${priceKindLabel(kind, current.evidence)}: ${reasonLabel(current.reason)}; checked ${current.observedAt}`,
              );
              continue;
            }
            lines.push(
              `  ${priceKindLabel(kind, current?.evidence)}: current ${money(current?.cents ?? null, current?.evidence.unitBasis)}${kind === 'warehouse_estimate' ? ` Same-Day; ${money(current?.estimateCents ?? null)} estimated warehouse` : ''}; low ${money(low?.lowCents ?? null, low?.unitBasis)}; checked ${current?.observedAt ?? 'never'}${current?.reason ? ` (${reasonLabel(current.reason)})` : ''}${current?.promoEnd ? ` | promo ends ${formatPromoEnd(current.promoEnd)}` : ''}${current?.evidence.unverifiedReason ? ` | unverified — check before buying: ${current.evidence.unverifiedReason}` : ''}`,
            );
          }
        }
        return { code: 0, text: lines.join('\n') || 'Watchlist is empty.' };
      }
      if (command === 'history') {
        const item = store.find(positionals[0]);
        if (!item) throw new Error('Item not found');
        return {
          code: 0,
          text:
            store
              .history(item.id)
              .map((o) => formatObservation(o, [item]))
              .join('\n') || 'No observations recorded.',
        };
      }
      if (command === 'remove')
        return {
          code: 0,
          text: store.remove(positionals[0])
            ? 'Item removed; history retained.'
            : 'Item not found.',
        };
      if (command === 'add') {
        const catalog = await (deps.resolveProduct ?? resolveProduct)(
          positionals[0],
        );
        const existing = store
          .items()
          .find((i) => i.itemNumber === catalog.itemNumber);
        const item = store.add({
          itemNumber: catalog.itemNumber,
          name: String(
            values.name ??
              (existing?.name.trim() &&
              existing.name !== `Item ${catalog.itemNumber}`
                ? existing.name
                : null) ??
              (catalog.name?.trim() || `Item ${catalog.itemNumber}`),
          ),
          url: catalog.url,
          channel: (values.channel ?? 'both') as Channel,
          addedAt: deps.now().toISOString(),
        });
        if (!values['no-check']) {
          const result = await check(
            store,
            deps.config,
            deps.sources,
            deps.mail,
            { itemNumber: item.itemNumber, baseline: true },
            deps.now,
          );
          lines.push(
            watchingLabel(store.find(item.itemNumber)!),
            formatCheck(result, store.items()),
            'Baseline recorded where usable; no email is sent when adding.',
          );
          return {
            code: result.status === 'failure' ? 1 : 0,
            text: lines.join('\n'),
          };
        }
        return { code: 0, text: watchingLabel(item) };
      }
      const result = await check(
        store,
        deps.config,
        deps.sources,
        deps.mail,
        {
          dryRun: values['dry-run'] === true,
          itemNumber: values.item as string | undefined,
        },
        deps.now,
      );
      return {
        code: result.status === 'failure' ? 1 : 0,
        text: formatCheck(result, store.items()),
      };
    } finally {
      store.close();
    }
  };
  // Dry runs also serialize access to the signed-in profile; read-only storage and notice state remain unchanged.
  return command === 'list' || command === 'history'
    ? execute()
    : deps.lock.runExclusive(execute);
}
const skipLabels: Record<string, string> = {
  skipped_verified_warehouse_price: 'not needed (verified warehouse price)',
  warehouse_only: 'not applicable (warehouse only)',
  not_online_buyable: 'not available online',
  warehouse_not_configured: 'not configured (warehouse)',
  same_day_location_or_markup_not_configured:
    'not configured (Same-Day location or markup)',
};
function isNonErrorSkip(reason: string | null | undefined): reason is string {
  return (
    !!reason &&
    (Object.hasOwn(skipLabels, reason) || reason.startsWith('skipped_'))
  );
}
export function reasonLabel(reason: string): string {
  return (
    skipLabels[reason] ??
    (reason.startsWith('skipped_')
      ? `skipped (${reason.slice(8).replaceAll('_', ' ')})`
      : reason)
  );
}
function watchingLabel(item: WatchItem): string {
  return `Watching ${item.itemNumber}: ${item.name} (${item.channel}).`;
}
function formatObservation(
  o: import('./domain.js').Observation,
  items: WatchItem[],
): string {
  const prefix = `${o.observedAt} | ${items.find((i) => i.id === o.itemId)?.itemNumber ?? o.itemId} | ${priceKindLabel(o.kind, o.evidence)}`;
  if (isNonErrorSkip(o.reason)) return `${prefix}: ${reasonLabel(o.reason)}`;
  return `${prefix} | ${money(o.cents, o.evidence.unitBasis)}${o.kind === 'warehouse_estimate' ? ` Same-Day; ${money(o.estimateCents)} estimated warehouse` : ''} | ${o.reason ? reasonLabel(o.reason) : o.source}${o.promoEnd ? ` | promo ends ${formatPromoEnd(o.promoEnd)}` : ''}${(o.evidence.unverifiedReason ?? o.evidence.conflictReason) ? ` | unverified — check before buying: ${o.evidence.unverifiedReason ?? o.evidence.conflictReason}` : ''}`;
}
export function formatCheck(result: CheckResult, items: WatchItem[]): string {
  return [
    `Watch check: ${result.status}; ${result.drops.length} new low(s).`,
    ...result.source.observations.map((o) => formatObservation(o, items)),
    ...result.diagnostics,
  ].join('\n');
}
