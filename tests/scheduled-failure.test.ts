import { mkdtempSync, rmSync, writeFileSync, lstatSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Sqlite from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createDefaultCliActions,
  type DefaultCliDependencies,
} from '../src/cli/actions.js';
import { runCli } from '../src/cli.js';
import { DEFAULT_CONFIG } from '../src/config/config.js';
import { appPaths } from '../src/config/paths.js';
import { AuthRequiredError } from '../src/costco/errors.js';
import { RunOverlapError } from '../src/lib/process.js';
import type { RunSummary } from '../src/domain/types.js';
import type { MailNotifier } from '../src/app/run.js';
import type { SourceFetcher } from '../src/watch/check.js';
import { dispatchScheduledChecks } from '../src/scheduler/dispatch.js';
import {
  notifyScheduledFailure,
  nextScheduledAttempt,
  type ScheduledFailure,
} from '../src/scheduler/failure.js';
import { Database } from '../src/storage/database.js';
import { Store } from '../src/watch/store.js';
import { item, observation } from './watch/helpers.js';

const homes: string[] = [];
const config = { ...DEFAULT_CONFIG, scheduledWeekday: 5, scheduledHour: 16 };
const friday = new Date(2030, 7, 23, 16, 5);
const report: RunSummary = {
  startedAt: friday.toISOString(),
  finishedAt: friday.toISOString(),
  outcome: 'success',
  purchasesProcessed: 0,
  observationsRecorded: 0,
  candidatesFound: 0,
  alertsSent: 0,
  unresolvedPrices: 0,
};
const failure: ScheduledFailure = {
  job: 'receipt',
  stage: 'purchase import',
  failedAt: friday.toISOString(),
};
afterEach(() => {
  for (const home of homes.splice(0))
    rmSync(home, { recursive: true, force: true });
});
function home() {
  const path = mkdtempSync(join(tmpdir(), 'costco-failure-test-'));
  homes.push(path);
  return path;
}
function harness() {
  const path = join(home(), 'test.sqlite');
  const mail = {
    resolveSelfRecipient: vi.fn(async () => 'self@example.com'),
    send: vi.fn<MailNotifier['send']>(async () => {}),
  };
  const local = { send: vi.fn(async () => {}) };
  const log = vi.fn();
  const dependencies = {
    config,
    logPath: '~/.costco-genie/logs/stderr.log',
    openStore: () => Database.open(path),
    mail: () => mail,
    local: () => local,
    log,
    now: () => friday,
  };
  const read = () => {
    const db = Database.openReadOnly(path);
    try {
      return db.getLastScheduledFailures();
    } finally {
      db.close();
    }
  };
  return {
    path,
    mail,
    local,
    log,
    dependencies,
    read,
    notify: (event = failure) =>
      notifyScheduledFailure(event, {
        ...dependencies,
        now: () => new Date(event.failedAt),
      }),
  };
}
async function cliHarness(overrides: Partial<DefaultCliDependencies> = {}) {
  const homeDirectory = home();
  const paths = appPaths(homeDirectory);
  const mail = {
    resolveSelfRecipient: vi.fn(async () => 'self@example.com'),
    send: vi.fn<MailNotifier['send']>(async () => {}),
  };
  const local = { send: vi.fn(async () => {}) };
  const watchMail = vi.fn(async () => {});
  const sources = vi.fn<SourceFetcher>(async () => ({
    observations: [observation(null)],
    diagnostics: ['TEST source unavailable'],
    session: 'not_required' as const,
  }));
  const log = vi.fn();
  const launchctl = vi.fn(async () => false);
  const actions = createDefaultCliActions({
    homeDirectory,
    dependencies: {
      now: () => friday,
      platform: 'darwin',
      isLaunchAgentLoaded: launchctl,
      createLock: () => ({ runExclusive: async (action) => action() }),
      createMailNotifier: () => mail,
      createLocalNotifier: () => local,
      watchMail: () => watchMail,
      watchSources: () => sources,
      logError: log,
      readCostcoTokens: async () => ({
        clientId: 'TEST-client',
        idToken: 'TEST-token',
      }),
      fetchReceipts: async () => [],
      fetchOnlineOrderPurchases: async () => ({
        purchases: [],
        failedDetailBatches: 0,
        diagnostic: {
          channel: null,
          source: 'costco_online_orders',
          status: 'ok',
          observedAt: friday.toISOString(),
          message: 'TEST import completed',
        },
      }),
      fetchReportPriceEvidence: async () => ({ items: [], diagnostics: [] }),
      ...overrides,
    },
  });
  await actions.setup({});
  writeFileSync(paths.configFile, JSON.stringify(config));
  const addWatch = () => {
    const store = new Store(paths.databaseFile);
    try {
      store.add(item);
    } finally {
      store.close();
    }
  };
  return {
    actions,
    paths,
    mail,
    local,
    watchMail,
    sources,
    log,
    launchctl,
    addWatch,
  };
}
const io = () => ({ log: vi.fn(), error: vi.fn() });

describe('durable scheduled failure notifications', () => {
  it('emails a receipt failure once, persists across connections, and permits a new local day', async () => {
    const h = harness();
    await h.notify();
    await h.notify();
    const late = new Date(2030, 7, 23, 23, 59).toISOString();
    await h.notify({ ...failure, failedAt: late, stage: 'storage' });
    expect(h.mail.send).toHaveBeenCalledTimes(1);
    expect(h.mail.send.mock.calls[0]).toEqual([
      'self@example.com',
      'Costco Genie: receipt run failed',
      expect.stringContaining('run `./costco doctor`'),
    ]);
    expect(h.read()).toMatchObject([
      {
        job: 'receipt',
        delivery: 'delivered',
        localDay: '2030-08-23',
        stage: 'storage',
        failedAt: late,
      },
    ]);
    expect(lstatSync(h.path).mode & 0o777).toBe(0o600);
    await h.notify({
      ...failure,
      failedAt: new Date(2030, 7, 24, 0, 1).toISOString(),
    });
    expect(h.mail.send).toHaveBeenCalledTimes(2);
    expect(h.local.send).not.toHaveBeenCalled();
  });
  it('reserves atomically before delivery across simultaneous attempts', async () => {
    const h = harness();
    await Promise.all([h.notify(), h.notify(), h.notify()]);
    expect(h.mail.send).toHaveBeenCalledTimes(1);
  });
  it('dedupes by the notification attempt day when dispatch crosses midnight', async () => {
    const h = harness();
    const afterMidnight = new Date(2030, 7, 24, 0, 1);
    await notifyScheduledFailure(failure, {
      ...h.dependencies,
      now: () => afterMidnight,
    });
    await notifyScheduledFailure(
      { ...failure, failedAt: afterMidnight.toISOString() },
      { ...h.dependencies, now: () => afterMidnight },
    );
    expect(h.mail.send).toHaveBeenCalledOnce();
    expect(h.read()[0].localDay).toBe('2030-08-24');
  });
  it('uses configured recipient and sends HTML plus text only for SMTP', async () => {
    const h = harness();
    await notifyScheduledFailure(failure, {
      ...h.dependencies,
      config: {
        ...config,
        smtpConfigPath: '/TEST/private-smtp.json',
        emailRecipient: 'chosen@example.com',
      },
    });
    expect(h.mail.resolveSelfRecipient).not.toHaveBeenCalled();
    expect(h.mail.send.mock.calls[0]).toEqual([
      'chosen@example.com',
      'Costco Genie: receipt run failed',
      expect.stringContaining('Stage: purchase import'),
      expect.stringContaining('<html>'),
    ]);
  });
  it('records sanitized delivery failure, notifies locally, and never retries email that day', async () => {
    const h = harness();
    h.mail.send.mockRejectedValue(new Error('SMTP down smtp_pass=TEST-secret'));
    await h.notify();
    await h.notify();
    expect(h.mail.send).toHaveBeenCalledTimes(1);
    expect(h.local.send).toHaveBeenCalledOnce();
    expect(h.log).toHaveBeenCalledWith(
      expect.stringContaining('failure email delivery'),
    );
    expect(JSON.stringify(h.read())).not.toContain('TEST-secret');
    expect(h.read()[0].delivery).toBe('failed');
  });
  it('logs a local fallback failure without rejecting', async () => {
    const h = harness();
    h.mail.resolveSelfRecipient.mockRejectedValue(
      new Error('TEST no mail account'),
    );
    h.local.send.mockRejectedValue(new Error('TEST no desktop'));
    await expect(h.notify()).resolves.toBeUndefined();
    expect(h.log).toHaveBeenCalledWith(
      expect.stringContaining('failure local notification'),
    );
    expect(h.read()[0].delivery).toBe('failed');
  });
  it('uses local fallback if storage cannot reserve safely, without attempting undeduped mail', async () => {
    const h = harness();
    await notifyScheduledFailure(failure, {
      ...h.dependencies,
      openStore: () => {
        throw new Error('TEST storage unavailable');
      },
    });
    expect(h.mail.send).not.toHaveBeenCalled();
    expect(h.local.send).toHaveBeenCalledOnce();
    expect(h.log).toHaveBeenCalledWith(
      expect.stringContaining('scheduled failure notification state'),
    );
  });
  it('handles pending crash reservations without resending', async () => {
    const h = harness();
    const db = Database.open(h.path);
    db.claimScheduledFailure({
      ...failure,
      localDay: '2030-08-23',
      delivery: 'pending',
      deliveryError: null,
    });
    db.close();
    await h.notify();
    expect(h.mail.send).not.toHaveBeenCalled();
    expect(h.read()[0].delivery).toBe('pending');
  });
  it('keeps a crash-safe reservation when saving delivery status fails', async () => {
    const h = harness();
    await notifyScheduledFailure(failure, {
      ...h.dependencies,
      openStore: () => {
        const db = Database.open(h.path);
        return {
          claimScheduledFailure: db.claimScheduledFailure.bind(db),
          finishScheduledFailure: () => {
            throw new Error('TEST result write failed');
          },
          close: () => db.close(),
        };
      },
    });
    await h.notify();
    expect(h.mail.send).toHaveBeenCalledOnce();
    expect(h.local.send).toHaveBeenCalledOnce();
    expect(h.read()[0].delivery).toBe('pending');
    expect(h.log).toHaveBeenCalledWith(
      expect.stringContaining('scheduled failure notification state'),
    );
  });
  it('migrates additively and tolerates older read-only databases', () => {
    const path = join(home(), 'old.sqlite');
    const old = new Sqlite(path);
    old.exec(
      "CREATE TABLE sentinel (value TEXT); INSERT INTO sentinel VALUES ('TEST preserved')",
    );
    old.close();
    const readOnly = Database.openReadOnly(path);
    expect(readOnly.getLastScheduledFailures()).toEqual([]);
    readOnly.close();
    for (let i = 0; i < 2; i++) {
      const db = Database.open(path);
      db.close();
    }
    const check = new Sqlite(path, { readonly: true });
    expect(check.prepare('SELECT value FROM sentinel').get()).toEqual({
      value: 'TEST preserved',
    });
    expect(check.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    check.close();
  });
  it('calculates next local calendar triggers, including weekly wait and year rollover', () => {
    expect(nextScheduledAttempt('receipt', config, friday)).toEqual(
      new Date(2030, 7, 30, 16),
    );
    expect(nextScheduledAttempt('watch', config, friday)).toEqual(
      new Date(2030, 7, 24, 8),
    );
    expect(
      nextScheduledAttempt('watch', config, new Date(2030, 11, 31, 9)),
    ).toEqual(new Date(2031, 0, 1, 8));
    expect(
      nextScheduledAttempt(
        'receipt',
        { ...config, scheduledWeekday: null },
        friday,
      ),
    ).toEqual(new Date(2030, 7, 24, 16));
  });
});

describe('scheduled CLI failure policy', () => {
  it('sends on the first failed receipt import and consumes its weekly trigger', async () => {
    const h = await cliHarness({
      fetchReceipts: async () => {
        throw new Error('TEST import failed');
      },
    });
    const output = io();
    expect(await runCli(['run', '--scheduled'], h.actions, output)).toBe(1);
    expect(h.mail.send).toHaveBeenCalledOnce();
    const text = String(h.mail.send.mock.calls[0][2]);
    expect(text).toContain('Stage: purchase import');
    expect(text).toContain('August 30, 2030');
    expect(text).toContain(h.paths.logDir);
    expect(text).toContain('weekly receipt run otherwise waits');
    expect(await runCli(['run', '--scheduled'], h.actions, output)).toBe(0);
    expect(h.mail.send).toHaveBeenCalledOnce();
    expect(await h.actions.status()).toContain('notification: delivered');
    expect(JSON.stringify(await h.actions.doctor())).toContain(
      'Last scheduled receipt failure:',
    );
  });
  it('emails two distinct alerts for the two jobs, and removes both old watch notice paths', async () => {
    let clock = friday;
    const h = await cliHarness({
      now: () => clock,
      readCostcoTokens: async () => {
        throw new AuthRequiredError();
      },
    });
    h.addWatch();
    h.sources.mockImplementation(async () => ({
      observations: [observation(null)],
      diagnostics: [],
      session: 'signed_out',
    }));
    const store = new Store(h.paths.databaseFile);
    store.setState('scheduledFailures', '2');
    store.setState('sessionNotified', 'false');
    store.close();
    for (let i = 0; i < 4; i++)
      await runCli(['run', '--scheduled'], h.actions, io());
    expect(h.mail.send.mock.calls.map((call) => call[1])).toEqual([
      'Costco Genie: watch check failed',
      'Costco Genie: receipt run failed',
    ]);
    expect(h.watchMail).not.toHaveBeenCalled();
    const login =
      'run `./costco login`, sign in, close the dedicated Chrome window, then `./costco run`';
    expect(
      h.mail.send.mock.calls.every((call) => String(call[2]).includes(login)),
    ).toBe(true);
    clock = new Date(2030, 7, 24, 8, 1);
    await runCli(['run', '--scheduled'], h.actions, io());
    expect(h.mail.send).toHaveBeenCalledTimes(3);
    expect(h.mail.send.mock.calls[2][1]).toBe(
      'Costco Genie: watch check failed',
    );
  });
  it('preserves auth exit 3 even when SMTP and the fallback fail', async () => {
    const h = await cliHarness({
      readCostcoTokens: async () => {
        throw new AuthRequiredError();
      },
    });
    h.mail.send.mockRejectedValue(new Error('TEST SMTP down'));
    h.local.send.mockRejectedValue(new Error('TEST notification down'));
    expect(await runCli(['run', '--scheduled'], h.actions, io())).toBe(3);
    expect(h.log).toHaveBeenCalledWith(
      expect.stringContaining('failure email delivery'),
    );
    expect(await h.actions.status()).toContain('notification: failed');
  });
  it('does not email interactive receipt or watch failures, including expired watch sessions', async () => {
    const h = await cliHarness({
      readCostcoTokens: async () => {
        throw new AuthRequiredError();
      },
    });
    h.addWatch();
    h.sources.mockImplementation(async () => ({
      observations: [observation(null)],
      diagnostics: [],
      session: 'signed_out',
    }));
    expect(await runCli(['run'], h.actions, io())).toBe(3);
    expect(await runCli(['watch', 'check'], h.actions, io())).toBe(1);
    expect(h.mail.send).not.toHaveBeenCalled();
    expect(h.watchMail).not.toHaveBeenCalled();
  });
  it('does not email not-due receipts, successful freshness skips, or empty watches', async () => {
    let clock = new Date(2030, 7, 23, 8);
    const h = await cliHarness({ now: () => clock });
    expect(await runCli(['run', '--scheduled'], h.actions, io())).toBe(0);
    expect(h.sources).not.toHaveBeenCalled();
    clock = new Date(2030, 7, 23, 15, 59);
    expect(await runCli(['run'], h.actions, io())).toBe(0);
    clock = friday;
    const result = await h.actions.run({ scheduled: true });
    expect(result.outcome).toBe('skipped');
    expect(h.mail.send).not.toHaveBeenCalled();
  });
  it('catches lock errors escaping both callbacks and preserves failure exit 1', async () => {
    const h = await cliHarness({
      createLock: () => ({
        runExclusive: async () => {
          throw new RunOverlapError('/TEST/run.lock');
        },
      }),
    });
    expect(await runCli(['run', '--scheduled'], h.actions, io())).toBe(1);
    expect(h.mail.send).toHaveBeenCalledTimes(2);
    expect(
      h.mail.send.mock.calls.every((call) =>
        call[2].includes('Stage: run lock'),
      ),
    ).toBe(true);
  });
  it('records a database callback exception and keeps both jobs independent', async () => {
    let calls = 0;
    const h = await cliHarness({
      openDatabase: (path) => {
        if (++calls === 2) throw new Error('TEST open failed');
        return Database.open(path);
      },
    });
    expect(await runCli(['run', '--scheduled'], h.actions, io())).toBe(1);
    expect(h.mail.send).toHaveBeenCalledOnce();
  });
});

describe('dispatcher boundary', () => {
  it('does not send for partial unresolved prices, success, or skips', async () => {
    const notify = vi.fn(async () => {});
    for (const outcome of ['partial_failure', 'success', 'skipped'] as const)
      await dispatchScheduledChecks(
        async () => ({ status: 'skipped', text: 'TEST freshness skip' }),
        async () => ({ ...report, outcome, unresolvedPrices: 7 }),
        () => friday,
        notify,
      );
    expect(notify).not.toHaveBeenCalled();
  });
  it('excludes credentials, URLs, payloads and purchase text from operational email', async () => {
    const h = harness();
    const sensitive =
      'TEST-private-purchase order TEST-123 smtp_pass=TEST-password https://example.com/?token=TEST-token cookie=TEST-cookie';
    const result = await dispatchScheduledChecks(
      async () => {
        throw new Error(sensitive);
      },
      async () => ({ ...report, outcome: 'failure', diagnostic: sensitive }),
      () => friday,
      h.notify,
    );
    expect(result.watchFailed).toBe(true);
    expect(h.mail.send).toHaveBeenCalledTimes(2);
    const sent = JSON.stringify(h.mail.send.mock.calls);
    for (const value of [
      'TEST-private-purchase',
      'TEST-123',
      'TEST-password',
      'TEST-token',
      'TEST-cookie',
      'https://example.com',
    ])
      expect(sent).not.toContain(value);
  });
  it('catches thrown callbacks and an unexpectedly thrown notification handler', async () => {
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const notify = vi.fn<(failure: ScheduledFailure) => Promise<void>>(
        async () => {
          throw new Error('TEST delivery boundary');
        },
      );
      const result = await dispatchScheduledChecks(
        async () => {
          throw new Error('TEST watch');
        },
        async () => {
          throw new AuthRequiredError();
        },
        () => friday,
        notify,
      );
      expect(result).toMatchObject({ outcome: 'failure', watchFailed: true });
      expect(notify).toHaveBeenCalledTimes(2);
      expect(notify.mock.calls[1][0]).toMatchObject({
        job: 'receipt',
        loginRequired: true,
      });
    } finally {
      errorLog.mockRestore();
    }
  });
});
