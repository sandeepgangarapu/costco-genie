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
import { DEFAULT_CONFIG, loadConfig } from '../config/config.js';
import { appPaths, type AppPaths } from '../config/paths.js';
import {
  openLoginBrowser,
  readCostcoTokens,
} from '../costco/browser-session.js';
import {
  fetchReportPriceEvidence,
  fetchWarehousePrices,
} from '../costco/price-client.js';
import { fetchReceipts } from '../costco/receipt-client.js';
import type { RunSummary } from '../domain/types.js';
import {
  createPrivateTextFile,
  pathExistsWithoutFollowing,
} from '../lib/filesystem.js';
import { FileRunLock } from '../lib/process.js';
import { AppleMailNotifier } from '../notifications/apple-mail.js';
import { MacOsNotifier } from '../notifications/macos.js';
import { writeFullReport } from '../notifications/full-report.js';
import {
  installLaunchAgent,
  type LaunchAgentInstallOptions,
  type LaunchAgentUninstallOptions,
  uninstallLaunchAgent,
} from '../scheduler/launchd.js';
import { Database } from '../storage/database.js';
import { diagnoseEnvironment, type DoctorReport } from './doctor.js';

const AGENT_LABEL = 'com.costco-price-matcher.daily';

export interface CliActions {
  readonly doctor: () => Promise<DoctorReport>;
  readonly installAgent: () => Promise<string>;
  readonly login: () => Promise<void>;
  readonly run: (options: {
    readonly scheduled: boolean;
  }) => Promise<RunSummary>;
  readonly setup: () => Promise<string>;
  readonly status: () => Promise<string>;
  readonly uninstallAgent: () => Promise<string>;
}

export interface DefaultCliActionOptions {
  readonly dependencies?: Partial<DefaultCliDependencies>;
  readonly homeDirectory?: string;
}

export interface DefaultCliDependencies {
  readonly accessPath: (path: string, mode: number) => void;
  readonly compiledCliPath: string;
  readonly createLocalNotifier: () => LocalNotifier;
  readonly createLock: (path: string) => RunLock;
  readonly createMailNotifier: () => MailNotifier;
  readonly fetchReceipts: RunDependencies['fetchReceipts'];
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

  return {
    doctor: () => runDoctor(paths, dependencies),
    installAgent: async () => {
      const config = loadConfig(paths);
      const plistPath = launchAgentPath(homeDirectory);
      await dependencies.installLaunchAgent({
        plistPath,
        renderOptions: {
          cliPath: dependencies.compiledCliPath,
          label: AGENT_LABEL,
          logDirectory: paths.logDir,
          nodePath: dependencies.nodePath,
          scheduledHour: config.scheduledHour,
          scheduledMinute: config.scheduledMinute,
          workingDirectory: dependencies.projectDirectory,
        },
        uid: dependencies.getUid(),
      });
      return plistPath;
    },
    login: async () => {
      loadConfig(paths);
      await dependencies.openLoginBrowser(paths);
    },
    run: async ({ scheduled }) => {
      const config = loadConfig(paths);
      const lock = dependencies.createLock(join(paths.dataDir, 'run.lock'));
      return lock.runExclusive(async () => {
        const database = dependencies.openDatabase(paths.databaseFile);
        try {
          return await runPriceCheckLocked(
            {
              config,
              database,
              fetchReceipts: dependencies.fetchReceipts,
              fetchWarehousePrices: dependencies.fetchWarehousePrices,
              fetchReportPriceEvidence: dependencies.fetchReportPriceEvidence,
              localNotifier: dependencies.createLocalNotifier(),
              mailNotifier: dependencies.createMailNotifier(),
              readCostcoTokens: () => dependencies.readCostcoTokens(paths),
              writeFullReport: (report) => writeFullReport(paths, report),
            },
            { now: dependencies.now, scheduled },
          );
        } finally {
          database.close();
        }
      });
    },
    setup: async () => {
      loadConfig(paths);
      if (!existsSync(paths.configFile)) {
        createPrivateTextFile(
          paths.configFile,
          `${JSON.stringify(DEFAULT_CONFIG, null, 2)}\n`,
        );
      }
      const database = dependencies.openDatabase(paths.databaseFile);
      database.close();
      return paths.configFile;
    },
    status: async () => statusText(paths, dependencies),
    uninstallAgent: async () => {
      const plistPath = launchAgentPath(homeDirectory);
      await dependencies.uninstallLaunchAgent({
        label: AGENT_LABEL,
        plistPath,
        uid: dependencies.getUid(),
      });
      return plistPath;
    },
  };
}

async function statusText(
  paths: AppPaths,
  dependencies: DefaultCliDependencies,
): Promise<string> {
  const pathLines = [
    `Data directory: ${paths.dataDir}`,
    `Configuration: ${paths.configFile}`,
    `Database: ${paths.databaseFile}`,
    `Logs: ${paths.logDir}`,
  ];
  if (!dependencies.fileExists(paths.databaseFile)) {
    return [
      ...pathLines,
      'Application is not set up; run `costco setup`.',
    ].join('\n');
  }

  const database = dependencies.openReadOnlyDatabase(paths.databaseFile);
  try {
    const lastRun = database.getLastSuccessfulRun();
    return [
      ...pathLines,
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
  return diagnoseEnvironment({
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
      dependencies.mailApplicationExists()
        ? {
            detail:
              'Mail is installed; account and Automation access are not verified by offline doctor',
            ok: true,
          }
        : { detail: 'Apple Mail is not installed', ok: false },
  });
}

function defaultCliDependencies(): DefaultCliDependencies {
  return {
    accessPath: accessSync,
    compiledCliPath: compiledCliPath(),
    createLocalNotifier: () => new MacOsNotifier(),
    createLock: (path) => new FileRunLock(path),
    createMailNotifier: () => new AppleMailNotifier(),
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

function launchAgentPath(homeDirectory: string): string {
  return join(homeDirectory, 'Library', 'LaunchAgents', `${AGENT_LABEL}.plist`);
}

function projectDirectory(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
}

function compiledCliPath(): string {
  return resolve(projectDirectory(), 'dist', 'cli.js');
}
