import { runWatchCli, formatCheck } from '../watch/cli.js';
import { check as checkWatchlist } from '../watch/check.js';
import { Store } from '../watch/store.js';
import { makeSources } from '../watch/sources.js';
import { watchMailSender, type MailSender } from '../watch/email.js';
import type { SourceFetcher } from '../watch/check.js';
import {
  dispatchScheduledChecks,
  type ScheduledSummary,
} from '../scheduler/dispatch.js';
import {
  accessSync,
  constants as fsConstants,
  existsSync,
  lstatSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  runPriceCheckLocked,
  type LocalNotifier,
  type MailNotifier,
  type RunDependencies,
  type RunLock,
} from '../app/run.js';
import {
  loadConfig,
  readConfigWithoutMutation,
  saveConfig,
  type AppConfig,
} from '../config/config.js';
import { appPaths, type AppPaths } from '../config/paths.js';
import {
  legacyDataDirectory,
  migrateLegacyDataDirectory,
} from '../config/migrate.js';
import {
  openLoginBrowser,
  readCostcoTokens,
} from '../costco/browser-session.js';
import {
  fetchReportPriceEvidence,
  fetchWarehousePrices,
} from '../costco/price-client.js';
import { fetchOnlineOrderPurchases } from '../costco/online-order-client.js';
import { fetchReceipts } from '../costco/receipt-client.js';
import { pathExistsWithoutFollowing } from '../lib/filesystem.js';
import { FileRunLock } from '../lib/process.js';
import { AppleMailNotifier } from '../notifications/apple-mail.js';
import { SmtpMailNotifier } from '../notifications/smtp-mail.js';
import { MacOsNotifier } from '../notifications/macos.js';
import { writeFullReport } from '../notifications/full-report.js';
import {
  AGENT_LABEL,
  LEGACY_AGENT_LABEL,
  isLaunchAgentLoaded,
  launchAgentPath,
  installLaunchAgent,
  type LaunchAgentInstallOptions,
  type LaunchAgentUninstallOptions,
  uninstallLaunchAgent,
} from '../scheduler/launchd.js';
import { Database } from '../storage/database.js';
import { diagnoseEnvironment, type DoctorReport } from './doctor.js';
import { promptForSetup, type SetupOptions } from './setup.js';

export interface CliActions {
  readonly doctor: () => Promise<DoctorReport>;
  readonly installAgent: () => Promise<string>;
  readonly login: () => Promise<void>;
  readonly run: (options: {
    readonly scheduled: boolean;
  }) => Promise<ScheduledSummary>;
  readonly watch?: (
    args: readonly string[],
  ) => Promise<{ code: number; text: string }>;
  readonly setup: (options?: SetupOptions) => Promise<string>;
  readonly status: () => Promise<string>;
  readonly uninstallAgent: () => Promise<string>;
}

export interface DefaultCliActionOptions {
  readonly dependencies?: Partial<DefaultCliDependencies>;
  readonly homeDirectory?: string;
}

export interface DefaultCliDependencies {
  readonly isLaunchAgentLoaded: typeof isLaunchAgentLoaded;
  readonly migrateDataDirectory: typeof migrateLegacyDataDirectory;
  readonly watchSources: (config: AppConfig, paths: AppPaths) => SourceFetcher;
  readonly watchMail: (config: AppConfig) => MailSender;
  readonly promptSetup: (config: AppConfig) => Promise<SetupOptions>;
  readonly accessPath: (path: string, mode: number) => void;
  readonly compiledCliPath: string;
  readonly createLocalNotifier: () => LocalNotifier;
  readonly createLock: (path: string) => RunLock;
  readonly createMailNotifier: (config: AppConfig) => MailNotifier;
  readonly fetchReceipts: RunDependencies['fetchReceipts'];
  readonly fetchOnlineOrderPurchases: RunDependencies['fetchOnlineOrderPurchases'];
  readonly fetchWarehousePrices: RunDependencies['fetchWarehousePrices'];
  readonly fetchReportPriceEvidence: NonNullable<
    RunDependencies['fetchReportPriceEvidence']
  >;
  readonly fileExists: (path: string) => boolean;
  readonly getUid: () => number;
  readonly installLaunchAgent: (
    options: LaunchAgentInstallOptions,
  ) => Promise<void>;
  readonly isDirectory: (path: string) => boolean;
  readonly isRegularFile: (path: string) => boolean;
  readonly mailApplicationExists: () => boolean;
  readonly nodePath: string;
  readonly nodeVersion: string;
  readonly now: () => Date;
  readonly openDatabase: (path: string) => Database;
  readonly openLoginBrowser: (paths: AppPaths) => Promise<void>;
  readonly openReadOnlyDatabase: (path: string) => Database;
  readonly platform: string;
  readonly projectDirectory: string;
  readonly readCostcoTokens: RunDependencies['readCostcoTokens'] extends () => infer Result
    ? (paths: AppPaths) => Result
    : never;
  readonly uninstallLaunchAgent: (
    options: LaunchAgentUninstallOptions,
  ) => Promise<void>;
}

export function createDefaultCliActions(
  options: DefaultCliActionOptions = {},
): CliActions {
  const homeDirectory = options.homeDirectory ?? homedir();
  const paths = appPaths(homeDirectory);
  const dependencies = {
    ...defaultCliDependencies(),
    ...options.dependencies,
  };
  const prepareData = () => dependencies.migrateDataDirectory(homeDirectory);
  const legacyAgent = {
    label: LEGACY_AGENT_LABEL,
    plistPath: launchAgentPath(homeDirectory, LEGACY_AGENT_LABEL),
  };
  const legacyWarnings = async (): Promise<string[]> => {
    const warnings: string[] = [];
    if (dependencies.fileExists(legacyDataDirectory(homeDirectory))) {
      warnings.push(
        `Legacy data directory still exists at ${legacyDataDirectory(homeDirectory)}; using ${paths.dataDir}. Neither directory will be merged or deleted.`,
      );
    }
    if (
      dependencies.fileExists(legacyAgent.plistPath) ||
      (dependencies.platform === 'darwin' &&
        (await dependencies.isLaunchAgentLoaded(
          dependencies.getUid(),
          LEGACY_AGENT_LABEL,
        )))
    ) {
      warnings.push(
        `Legacy LaunchAgent ${LEGACY_AGENT_LABEL} remains; run ./costco install-agent to replace it, or ./costco uninstall-agent to remove both agents.`,
      );
    }
    return warnings;
  };

  return {
    doctor: async () => {
      await prepareData();
      const report = await runDoctor(paths, dependencies);
      const warnings = await legacyWarnings();
      return {
        ok: report.ok && warnings.length === 0,
        checks: [
          ...report.checks,
          ...warnings.map((detail) => ({
            name: 'legacy-installation',
            ok: false,
            detail,
          })),
        ],
      };
    },
    installAgent: async () => {
      await prepareData();
      const config = loadConfig(paths);
      const plistPath = launchAgentPath(homeDirectory);
      await dependencies.installLaunchAgent({
        legacyAgent,
        plistPath,
        renderOptions: {
          cliPath: dependencies.compiledCliPath,
          label: AGENT_LABEL,
          logDirectory: paths.logDir,
          nodePath: dependencies.nodePath,
          watchScheduledHour: config.watchScheduledHour,
          watchScheduledMinute: config.watchScheduledMinute,
          scheduledHour: config.scheduledHour,
          scheduledMinute: config.scheduledMinute,
          scheduledWeekday: config.scheduledWeekday,
          workingDirectory: dependencies.projectDirectory,
        },
        uid: dependencies.getUid(),
      });
      return plistPath;
    },
    login: async () => {
      await prepareData();
      loadConfig(paths);
      await dependencies.openLoginBrowser(paths);
    },
    watch: async (args) => {
      await prepareData();
      // A dry run reads configuration without chmod or creating directories.
      const config =
        args.includes('--dry-run') || ['list', 'history'].includes(args[0])
          ? readConfigWithoutMutation(paths)
          : loadConfig(paths);
      return runWatchCli(args, {
        paths,
        config,
        lock: dependencies.createLock(join(paths.dataDir, 'run.lock')),
        sources: dependencies.watchSources(config, paths),
        mail: dependencies.watchMail(config),
        now: dependencies.now,
      });
    },
    run: async ({ scheduled }) => {
      await prepareData();
      const config = loadConfig(paths);
      const lock = dependencies.createLock(join(paths.dataDir, 'run.lock'));
      const receipts = () =>
        lock.runExclusive(async () => {
          const database = dependencies.openDatabase(paths.databaseFile);
          try {
            return await runPriceCheckLocked(
              {
                config,
                database,
                fetchOnlineOrderPurchases:
                  dependencies.fetchOnlineOrderPurchases,
                fetchReceipts: dependencies.fetchReceipts,
                fetchWarehousePrices: dependencies.fetchWarehousePrices,
                fetchReportPriceEvidence: dependencies.fetchReportPriceEvidence,
                localNotifier: dependencies.createLocalNotifier(),
                mailNotifier: dependencies.createMailNotifier(config),
                readCostcoTokens: () => dependencies.readCostcoTokens(paths),
                writeFullReport: (report) => writeFullReport(paths, report),
              },
              { now: dependencies.now, scheduled },
            );
          } finally {
            database.close();
          }
        });
      if (!scheduled) return receipts();
      return dispatchScheduledChecks(
        () =>
          lock.runExclusive(async () => {
            const store = new Store(paths.databaseFile);
            try {
              if (!store.items().length)
                return {
                  status: 'skipped',
                  text: 'Watchlist is empty; scheduled watch check skipped.',
                };
              const result = await checkWatchlist(
                store,
                config,
                dependencies.watchSources(config, paths),
                dependencies.watchMail(config),
                { scheduled: true },
                dependencies.now,
              );
              return {
                status: result.status,
                text: formatCheck(result, store.items()),
              };
            } finally {
              store.close();
            }
          }),
        receipts,
      );
    },
    setup: async (options) => {
      await prepareData();
      const config = loadConfig(paths);
      const changes = options ?? (await dependencies.promptSetup(config));
      saveConfig(paths, { ...config, ...changes });
      const database = dependencies.openDatabase(paths.databaseFile);
      database.close();
      return paths.configFile;
    },
    status: async () => {
      await prepareData();
      return [
        await statusText(paths, dependencies),
        ...(await legacyWarnings()).map((warning) => `WARNING: ${warning}`),
      ].join('\n');
    },
    uninstallAgent: async () => {
      const plistPath = launchAgentPath(homeDirectory);
      const errors: unknown[] = [];
      for (const agent of [{ label: AGENT_LABEL, plistPath }, legacyAgent]) {
        try {
          await dependencies.uninstallLaunchAgent({
            ...agent,
            uid: dependencies.getUid(),
          });
        } catch (error) {
          errors.push(error);
        }
      }
      if (errors.length > 0)
        throw new AggregateError(
          errors,
          'Could not remove both Costco Genie LaunchAgents; inspect each service before retrying.',
        );
      return plistPath;
    },
  };
}

async function statusText(
  paths: AppPaths,
  dependencies: DefaultCliDependencies,
): Promise<string> {
  const pathLines = [
    'Costco Genie status',
    `Data directory: ${paths.dataDir}`,
    `Configuration: ${paths.configFile}`,
    `Database: ${paths.databaseFile}`,
    `Logs: ${paths.logDir}`,
  ];
  if (!dependencies.fileExists(paths.databaseFile)) {
    return [
      ...pathLines,
      watchStatusText(paths, dependencies),
      'Application is not set up; run `costco setup`.',
    ].join('\n');
  }

  const database = dependencies.openReadOnlyDatabase(paths.databaseFile);
  try {
    const lastRun = database.getLastSuccessfulRun();
    return [
      ...pathLines,
      watchStatusText(paths, dependencies),
      lastRun
        ? `Last successful run: ${lastRun.finishedAt} (${String(lastRun.candidatesFound)} potential, ${String(lastRun.unresolvedPrices)} unresolved)`
        : 'No successful run recorded.',
    ].join('\n');
  } finally {
    database.close();
  }
}

async function runDoctor(
  paths: AppPaths,
  dependencies: DefaultCliDependencies,
): Promise<DoctorReport> {
  const config = readConfigWithoutMutation(paths);
  const report = await diagnoseEnvironment({
    checkBrowserProfile: () => {
      if (
        !dependencies.fileExists(paths.browserProfileDir) ||
        !dependencies.isDirectory(paths.browserProfileDir)
      ) {
        return {
          detail: 'dedicated profile is absent; run `costco login`',
          ok: false,
        };
      }
      return {
        detail:
          'dedicated profile is present; live session is verified by `costco run` or `costco login`',
        ok: true,
      };
    },
    checkDataDirectories: () => {
      for (const directory of [
        paths.dataDir,
        paths.browserProfileDir,
        paths.logDir,
      ]) {
        if (
          !dependencies.fileExists(directory) ||
          !dependencies.isDirectory(directory)
        ) {
          return {
            detail: `${directory} is missing; run \`costco setup\``,
            ok: false,
          };
        }
        dependencies.accessPath(directory, fsConstants.R_OK | fsConstants.W_OK);
      }
      return {
        detail: `${paths.dataDir} is readable and writable`,
        ok: true,
      };
    },
    checkDatabase: () => {
      if (!dependencies.fileExists(paths.databaseFile)) {
        return { detail: 'database is not initialized', ok: false };
      }
      const database = dependencies.openReadOnlyDatabase(paths.databaseFile);
      try {
        database.getLastSuccessfulRun();
      } finally {
        database.close();
      }
      return { detail: 'database opened read-only', ok: true };
    },
    checkLock: () => {
      if (!dependencies.fileExists(paths.dataDir)) {
        return { detail: 'data directory is not initialized', ok: false };
      }
      dependencies.accessPath(
        paths.dataDir,
        fsConstants.R_OK | fsConstants.W_OK,
      );
      const lockPath = join(paths.dataDir, 'run.lock');
      if (dependencies.fileExists(lockPath)) {
        if (!dependencies.isRegularFile(lockPath)) {
          return { detail: 'lock target is not a regular file', ok: false };
        }
        dependencies.accessPath(lockPath, fsConstants.R_OK | fsConstants.W_OK);
        return {
          detail:
            'lock file is accessible; active ownership is checked by `costco run`',
          ok: true,
        };
      }
      return { detail: 'lock path is ready for the first run', ok: true };
    },
    nodeVersion: dependencies.nodeVersion,
    platform: dependencies.platform,
    checkMail: () =>
      config.smtpConfigPath !== null
        ? dependencies.fileExists(config.smtpConfigPath) &&
          dependencies.isRegularFile(config.smtpConfigPath)
          ? {
              detail: `SMTP configuration is present at ${config.smtpConfigPath}; delivery is verified by a live run`,
              ok: true,
            }
          : {
              detail: `SMTP configuration is missing at ${config.smtpConfigPath}`,
              ok: false,
            }
        : dependencies.mailApplicationExists()
          ? {
              detail:
                'Mail is installed; account and Automation access are not verified by offline doctor',
              ok: true,
            }
          : { detail: 'Apple Mail is not installed', ok: false },
  });
  try {
    const detail = watchStatusText(paths, dependencies);
    return {
      ...report,
      checks: [
        ...report.checks,
        { name: 'watchlist-and-schedules', ok: true, detail },
      ],
    };
  } catch {
    return {
      ok: false,
      checks: [
        ...report.checks,
        {
          name: 'watchlist-and-schedules',
          ok: false,
          detail:
            'Cannot read watchlist state; run setup and inspect local storage.',
        },
      ],
    };
  }
}

function defaultCliDependencies(): DefaultCliDependencies {
  return {
    isLaunchAgentLoaded,
    migrateDataDirectory: migrateLegacyDataDirectory,
    watchSources: (config, paths) => makeSources(config, {}, paths),
    watchMail: watchMailSender,
    promptSetup: promptForSetup,
    accessPath: accessSync,
    compiledCliPath: compiledCliPath(),
    createLocalNotifier: () => new MacOsNotifier(),
    createLock: (path) => new FileRunLock(path),
    createMailNotifier: (config) =>
      config.smtpConfigPath === null
        ? new AppleMailNotifier()
        : new SmtpMailNotifier(config.smtpConfigPath),
    fetchOnlineOrderPurchases,
    fetchReceipts: (tokens, startDate, endDate, signal) =>
      fetchReceipts(tokens, startDate, endDate, fetch, signal),
    fetchWarehousePrices,
    fetchReportPriceEvidence,
    fileExists: pathExistsWithoutFollowing,
    getUid: currentUid,
    installLaunchAgent,
    isDirectory: (path) => lstatSync(path).isDirectory(),
    isRegularFile: (path) => lstatSync(path).isFile(),
    mailApplicationExists: () =>
      existsSync('/System/Applications/Mail.app') ||
      existsSync('/Applications/Mail.app'),
    nodePath: process.execPath,
    nodeVersion: process.versions.node,
    now: () => new Date(),
    openDatabase: Database.open,
    openLoginBrowser,
    openReadOnlyDatabase: Database.openReadOnly,
    platform: process.platform,
    projectDirectory: projectDirectory(),
    readCostcoTokens,
    uninstallLaunchAgent,
  };
}

function currentUid(): number {
  const uid = process.getuid?.();
  if (uid === undefined) {
    throw new Error('LaunchAgent management requires macOS or Unix');
  }
  return uid;
}

function projectDirectory(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
}

function compiledCliPath(): string {
  return resolve(projectDirectory(), 'dist', 'cli.js');
}

function watchStatusText(
  paths: AppPaths,
  dependencies: DefaultCliDependencies,
): string {
  const config = readConfigWithoutMutation(paths);
  const time = (hour: number, minute: number) =>
    String(hour).padStart(2, '0') + ':' + String(minute).padStart(2, '0');
  const lines = [
    'Watch schedule: daily ' +
      time(config.watchScheduledHour, config.watchScheduledMinute) +
      ' local',
    'Receipt schedule: ' +
      (config.scheduledWeekday === null
        ? 'daily'
        : 'weekday ' + config.scheduledWeekday) +
      ' ' +
      time(config.scheduledHour, config.scheduledMinute) +
      ' local; freshness ' +
      config.scheduledIntervalDays +
      ' day(s)',
    'Watch warehouse configured: ' + (config.watchWarehouseNumber !== null),
  ];
  if (dependencies.fileExists(paths.databaseFile)) {
    const store = new Store(paths.databaseFile, true);
    try {
      lines.push(
        'Watchlist active items: ' + store.items().length,
        'Last successful watch check: ' +
          (store.state('lastSuccessfulCheck') ?? 'never'),
        'Scheduled watch failures: ' +
          (store.state('scheduledFailures') ?? '0'),
        'Pending watch alerts: ' + store.pending().length,
      );
    } finally {
      store.close();
    }
  } else lines.push('Watchlist is not initialized.');
  return lines.join('\n');
}
