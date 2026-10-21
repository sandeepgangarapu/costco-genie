import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { describe, expect, it, vi } from 'vitest';
import Sqlite from 'better-sqlite3';
import { syntheticJwt } from './fixtures/jwt.js';

import type { RunSummary } from '../src/domain/types.js';
import { AuthRequiredError } from '../src/costco/errors.js';
import { AppleMailNotifier } from '../src/notifications/apple-mail.js';
import {
  diagnoseEnvironment,
  createDefaultCliActions,
  isDirectInvocation,
  runCli,
  type CliActions,
  type CliIo,
  type DoctorDependencies,
  type DoctorReport,
} from '../src/cli.js';

function summary(outcome: RunSummary['outcome']): RunSummary {
  return {
    alertsSent: 0,
    candidatesFound: 0,
    finishedAt: '2026-08-18T16:00:01.000Z',
    notifications: {
      email: { attempted: false, delivered: 0, error: null },
      local: { attempted: false, delivered: 0, error: null },
    },
    observationsRecorded: 0,
    outcome,
    purchasesProcessed: 0,
    startedAt: '2026-08-18T16:00:00.000Z',
    unresolvedPrices: 0,
  };
}

function cliHarness(overrides: Partial<CliActions> = {}) {
  const output: string[] = [];
  const errors: string[] = [];
  const calls: string[] = [];
  const doctorReport: DoctorReport = {
    checks: [{ detail: 'ready', name: 'runtime', ok: true }],
    ok: true,
  };
  const actions: CliActions = {
    async doctor() {
      calls.push('doctor');
      return doctorReport;
    },
    async installAgent() {
      calls.push('install-agent');
      return '/tmp/agent.plist';
    },
    async login() {
      calls.push('login');
    },
    async run(options) {
      calls.push(`run:${String(options.scheduled)}`);
      return summary('success');
    },
    async setup() {
      calls.push('setup');
      return '/tmp/config.json';
    },
    async status() {
      calls.push('status');
      return 'No successful run recorded.';
    },
    async uninstallAgent() {
      calls.push('uninstall-agent');
      return '/tmp/agent.plist';
    },
    ...overrides,
  };
  const io: CliIo = {
    error: (message) => errors.push(message),
    log: (message) => output.push(message),
  };
  return { actions, calls, errors, io, output };
}

describe('runCli', () => {
  it.each([[[]], [['--help']], [['help']]])(
    'prints help without performing work for %j',
    async (arguments_) => {
      const harness = cliHarness();

      const exitCode = await runCli(arguments_, harness.actions, harness.io);

      expect(exitCode).toBe(0);
      expect(harness.calls).toEqual([]);
      expect(harness.output.join('\n')).toContain('costco <command>');
      for (const command of [
        'setup',
        'login',
        'run',
        'status',
        'install-agent',
        'uninstall-agent',
        'doctor',
      ]) {
        expect(harness.output.join('\n')).toContain(command);
      }
    },
  );

  it.each([
    ['setup', 'setup'],
    ['login', 'login'],
    ['status', 'status'],
    ['install-agent', 'install-agent'],
    ['uninstall-agent', 'uninstall-agent'],
    ['doctor', 'doctor'],
  ])('routes %s to its action', async (command, expectedCall) => {
    const harness = cliHarness();

    const exitCode = await runCli([command], harness.actions, harness.io);

    expect(exitCode).toBe(0);
    expect(harness.calls).toEqual([expectedCall]);
  });

  it('routes scheduled runs with the freshness flag', async () => {
    const harness = cliHarness();

    const exitCode = await runCli(
      ['run', '--scheduled'],
      harness.actions,
      harness.io,
    );

    expect(exitCode).toBe(0);
    expect(harness.calls).toEqual(['run:true']);
  });

  it('passes setup choices to the action and explains the dedicated browser login', async () => {
    let options: unknown;
    const harness = cliHarness({
      setup: async (value) => {
        options = value;
        return '/tmp/config.json';
      },
    });
    expect(
      await runCli(
        ['setup', '--zip', '10001', '--address', '123 Example St'],
        harness.actions,
        harness.io,
      ),
    ).toBe(0);
    expect(options).toEqual({
      sameDayPostalCode: '10001',
      sameDayRepresentativeAddress: '123 Example St',
    });
    expect(harness.output.join('\n')).toContain('dedicated Chrome window');
  });

  it('rejects invalid setup options before touching local settings', async () => {
    const harness = cliHarness();
    expect(
      await runCli(['setup', '--zip', '1234'], harness.actions, harness.io),
    ).toBe(64);
    expect(harness.calls).toEqual([]);
    expect(harness.errors.join('\n')).toContain('five-digit ZIP');
  });

  it('prints the generated HTML, CSV, and JSON report paths', async () => {
    const harness = cliHarness({
      run: async () => ({
        ...summary('success'),
        reportFiles: {
          htmlFile: '/reports/latest.html',
          csvFile: '/reports/latest.csv',
          jsonFile: '/reports/latest.json',
        },
      }),
    });

    await runCli(['run'], harness.actions, harness.io);

    expect(harness.output.join('\n')).toContain(
      'HTML report: /reports/latest.html',
    );
    expect(harness.output.join('\n')).toContain(
      'CSV report: /reports/latest.csv',
    );
    expect(harness.output.join('\n')).toContain(
      'JSON report: /reports/latest.json',
    );
  });

  it('prints channel-specific purchase and unresolved counts for a mixed run', async () => {
    const harness = cliHarness({
      run: async () => ({
        ...summary('partial_failure'),
        onlinePurchasesProcessed: 2,
        onlineUnresolvedPrices: 1,
        purchasesProcessed: 5,
        unresolvedPrices: 2,
        warehousePurchasesProcessed: 3,
        warehouseUnresolvedPrices: 1,
      }),
    });

    await runCli(['run'], harness.actions, harness.io);

    expect(harness.output.join('\n')).toContain('Warehouse purchases: 3');
    expect(harness.output.join('\n')).toContain('Costco.com purchases: 2');
    expect(harness.output.join('\n')).toContain(
      'Warehouse unresolved prices: 1',
    );
    expect(harness.output.join('\n')).toContain(
      'Costco.com unresolved prices: 1',
    );
  });

  it('keeps older run summaries readable when channel-specific counts are absent', async () => {
    const harness = cliHarness({ run: async () => summary('success') });

    await runCli(['run'], harness.actions, harness.io);

    expect(harness.output.join('\n')).toContain('Purchases: 0');
    expect(harness.output.join('\n')).toContain('Unresolved: 0');
    expect(harness.output.join('\n')).not.toContain('Warehouse purchases:');
    expect(harness.output.join('\n')).not.toContain('Costco.com purchases:');
    expect(harness.output.join('\n')).not.toContain(
      'Warehouse unresolved prices:',
    );
    expect(harness.output.join('\n')).not.toContain(
      'Costco.com unresolved prices:',
    );
  });

  it.each([
    ['success', 0],
    ['skipped', 0],
    ['partial_failure', 2],
    ['auth_required', 3],
    ['failure', 1],
  ] as const)(
    'returns a useful exit code for a %s run',
    async (outcome, code) => {
      const harness = cliHarness({ run: async () => summary(outcome) });

      const exitCode = await runCli(['run'], harness.actions, harness.io);

      expect(exitCode).toBe(code);
      expect(harness.output.join('\n')).toContain(`Outcome: ${outcome}`);
      if (outcome === 'auth_required') {
        expect(harness.output.join('\n')).toContain('costco login');
      }
    },
  );

  it('uses a nonzero exit and help for an unknown command', async () => {
    const harness = cliHarness();

    const exitCode = await runCli(['launch'], harness.actions, harness.io);

    expect(exitCode).toBe(64);
    expect(harness.errors.join('\n')).toContain('Unknown command: launch');
    expect(harness.output.join('\n')).toContain('costco <command>');
  });

  it('prints safe run and channel diagnostics to stderr for scheduled or manual logs', async () => {
    const failed: RunSummary = {
      ...summary('partial_failure'),
      diagnostic:
        'Receipt retrieval failed: request timed out; Email delivery failed: Automation denied',
      notifications: {
        email: {
          attempted: true,
          delivered: 0,
          error: 'Automation denied',
        },
        local: { attempted: false, delivered: 0, error: null },
      },
    };
    const harness = cliHarness({ run: async () => failed });

    const exitCode = await runCli(
      ['run', '--scheduled'],
      harness.actions,
      harness.io,
    );

    expect(exitCode).toBe(2);
    expect(harness.errors).toEqual([
      'Receipt retrieval failed: request timed out; Email delivery failed: Automation denied',
    ]);
    expect(harness.output.join('\n')).toContain('Outcome: partial_failure');
  });

  it('makes thrown authentication failures actionable', async () => {
    const harness = cliHarness({
      run: async () => {
        throw new AuthRequiredError();
      },
    });

    const exitCode = await runCli(['run'], harness.actions, harness.io);

    expect(exitCode).toBe(1);
    expect(harness.errors.join('\n')).toContain('costco login');
  });

  it('redacts a standalone JWT from thrown command errors', async () => {
    const jwt = syntheticJwt;
    const harness = cliHarness({
      run: async () => {
        throw new Error(
          `upstream rejected session ${jwt} Authorization: Basic basic-secret refreshToken=refresh-secret payload={"secret":"nested-secret","nested":{"x":1}}`,
        );
      },
    });

    const exitCode = await runCli(['run'], harness.actions, harness.io);

    expect(exitCode).toBe(1);
    expect(harness.errors.join('\n')).toContain('[redacted]');
    expect(harness.errors.join('\n')).not.toContain(jwt);
    expect(harness.errors.join('\n')).not.toMatch(
      /basic-secret|refresh-secret|nested-secret/,
    );
  });

  it('returns a failing doctor exit code when any readiness check fails', async () => {
    const harness = cliHarness({
      doctor: async () => ({
        checks: [
          {
            detail: 'Apple Mail has no enabled account',
            name: 'mail',
            ok: false,
          },
        ],
        ok: false,
      }),
    });

    const exitCode = await runCli(['doctor'], harness.actions, harness.io);

    expect(exitCode).toBe(2);
    expect(harness.output.join('\n')).toContain(
      'FAIL mail: Apple Mail has no enabled account',
    );
  });
});

describe('diagnoseEnvironment', () => {
  it('checks every readiness boundary without sending a message', async () => {
    const checked: string[] = [];
    const dependencies: DoctorDependencies = {
      checkBrowserProfile() {
        checked.push('browser-profile');
        return {
          detail: 'profile present; live session is verified by run/login',
          ok: true,
        };
      },
      checkDataDirectories() {
        checked.push('data-directories');
        return { detail: '/tmp/costco-data is accessible', ok: true };
      },
      checkDatabase() {
        checked.push('database');
        return { detail: 'database opened read-only', ok: true };
      },
      checkLock() {
        checked.push('lock');
        return { detail: 'lock path is ready', ok: true };
      },
      checkMail() {
        checked.push('mail');
        return {
          detail: 'Mail is installed; account status is not verified offline',
          ok: true,
        };
      },
      nodeVersion: '22.13.0',
      platform: 'darwin',
    };

    const report = await diagnoseEnvironment(dependencies);

    expect(report.ok).toBe(true);
    expect(report.checks.map((check) => check.name)).toEqual([
      'platform',
      'runtime',
      'data-directories',
      'database',
      'lock',
      'mail',
      'browser-profile',
    ]);
    expect(checked).toEqual([
      'data-directories',
      'database',
      'lock',
      'mail',
      'browser-profile',
    ]);
  });

  it('sanitizes errors thrown by offline doctor probes', async () => {
    const secret =
      'token=doctor-secret payload={"secret":"nested-secret","nested":{"x":1}}';
    const dependencies: DoctorDependencies = {
      checkBrowserProfile: () => ({ detail: 'profile absent', ok: false }),
      checkDataDirectories: () => ({ detail: 'not initialized', ok: true }),
      checkDatabase: () => {
        throw new Error(`database check failed ${secret}`);
      },
      checkLock: () => ({ detail: 'lock ready', ok: true }),
      checkMail: () => ({ detail: 'Mail installed', ok: true }),
      nodeVersion: '22.13.0',
      platform: 'darwin',
    };

    const report = await diagnoseEnvironment(dependencies);
    const database = report.checks.find((check) => check.name === 'database');

    expect(database?.ok).toBe(false);
    expect(database?.detail).toContain('[redacted]');
    expect(database?.detail).not.toMatch(/doctor-secret|nested-secret/);
  });
});

describe('CLI entry point', () => {
  it('recognizes execution through an npm-style binary symlink', () => {
    const directory = mkdtempSync(join(tmpdir(), 'costco-cli-symlink-'));
    const target = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
    const executable = join(directory, 'costco');
    symlinkSync(target, executable);

    try {
      expect(isDirectInvocation(executable, pathToFileURL(target).href)).toBe(
        true,
      );
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });
});

describe('default CLI status', () => {
  it('reports an uninitialized fresh home without creating any files or directories', async () => {
    const homeDirectory = mkdtempSync(join(tmpdir(), 'costco-status-home-'));

    try {
      const actions = createDefaultCliActions({ homeDirectory });

      await expect(actions.status()).resolves.toContain('not set up');
      expect(readdirSync(homeDirectory)).toEqual([]);
    } finally {
      rmSync(homeDirectory, { force: true, recursive: true });
    }
  });

  it('keeps the real default doctor offline and read-only without invoking Apple Mail', async () => {
    const homeDirectory = mkdtempSync(join(tmpdir(), 'costco-doctor-home-'));
    let browserOrClientCalls = 0;
    const unexpectedDefaultMail = vi
      .spyOn(AppleMailNotifier.prototype, 'resolveSelfRecipient')
      .mockRejectedValue(new Error('unexpected default Mail boundary'));

    try {
      const actions = createDefaultCliActions({
        dependencies: {
          mailApplicationExists: () => true,
          openLoginBrowser: async () => {
            browserOrClientCalls += 1;
          },
          readCostcoTokens: async () => {
            browserOrClientCalls += 1;
            throw new Error('doctor must not contact Costco');
          },
        },
        homeDirectory,
      } as never);

      const report = await actions.doctor();

      expect(report.checks).toContainEqual({
        detail:
          'Mail is installed; account and Automation access are not verified by offline doctor',
        name: 'mail',
        ok: true,
      });
      expect(unexpectedDefaultMail).not.toHaveBeenCalled();
      expect(browserOrClientCalls).toBe(0);
      expect(readdirSync(homeDirectory)).toEqual([]);
    } finally {
      unexpectedDefaultMail.mockRestore();
      rmSync(homeDirectory, { force: true, recursive: true });
    }
  });

  it('does not harden permissions during read-only status or doctor checks', async () => {
    const homeDirectory = mkdtempSync(join(tmpdir(), 'costco-readonly-home-'));

    try {
      const actions = createDefaultCliActions({
        dependencies: { mailApplicationExists: () => true },
        homeDirectory,
      });
      await actions.setup();
      const root = join(homeDirectory, '.costco-price-matcher');
      const paths = [
        root,
        join(root, 'browser-profile'),
        join(root, 'logs'),
        join(root, 'config.json'),
        join(root, 'costco.sqlite'),
      ];
      for (const path of paths) chmodSync(path, 0o755);

      await actions.status();
      await actions.doctor();

      expect(paths.map((path) => lstatSync(path).mode & 0o777)).toEqual([
        0o755, 0o755, 0o755, 0o755, 0o755,
      ]);
    } finally {
      rmSync(homeDirectory, { force: true, recursive: true });
    }
  });

  it('reads a pre-diagnostic legacy database through real status and doctor without migration or mutation', async () => {
    const homeDirectory = mkdtempSync(join(tmpdir(), 'costco-legacy-home-'));
    const root = join(homeDirectory, '.costco-price-matcher');
    const databasePath = join(root, 'costco.sqlite');
    mkdirSync(join(root, 'browser-profile'), { recursive: true });
    mkdirSync(join(root, 'logs'));
    const legacy = new Sqlite(databasePath);
    legacy.exec(`
      CREATE TABLE runs (
        id INTEGER PRIMARY KEY,
        started_at TEXT NOT NULL,
        finished_at TEXT,
        outcome TEXT,
        purchases_processed INTEGER,
        observations_recorded INTEGER,
        candidates_found INTEGER,
        alerts_sent INTEGER,
        unresolved_prices INTEGER,
        notification_results TEXT
      );
      INSERT INTO runs (
        started_at, finished_at, outcome, purchases_processed,
        observations_recorded, candidates_found, alerts_sent,
        unresolved_prices, notification_results
      ) VALUES (
        '2026-08-18T09:00:00.000Z', '2026-08-18T09:01:00.000Z',
        'success', 2, 2, 1, 1, 0, NULL
      );
    `);
    legacy.close();
    chmodSync(databasePath, 0o644);
    const before = statSync(databasePath);
    const beforeColumns = readRunColumnNames(databasePath);

    try {
      const actions = createDefaultCliActions({
        dependencies: { mailApplicationExists: () => true },
        homeDirectory,
      });

      await expect(actions.status()).resolves.toContain(
        'Last successful run: 2026-08-18T09:01:00.000Z',
      );
      const doctor = await actions.doctor();

      expect(doctor.checks).toContainEqual({
        detail: 'database opened read-only',
        name: 'database',
        ok: true,
      });
      const after = statSync(databasePath);
      expect(readRunColumnNames(databasePath)).toEqual(beforeColumns);
      expect(beforeColumns).not.toContain('diagnostic');
      expect(after.mtimeMs).toBe(before.mtimeMs);
      expect(after.size).toBe(before.size);
      expect(after.mode & 0o777).toBe(0o644);
    } finally {
      rmSync(homeDirectory, { force: true, recursive: true });
    }
  });
});

function readRunColumnNames(databasePath: string): string[] {
  const database = new Sqlite(databasePath, {
    fileMustExist: true,
    readonly: true,
  });
  try {
    return database
      .prepare<[], { name: string }>('PRAGMA table_info(runs)')
      .all()
      .map((column) => column.name);
  } finally {
    database.close();
  }
}
