import { randomUUID } from 'node:crypto';
import {
  accessSync,
  constants as fsConstants,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';

import { execFile as defaultExecFile, type ExecFile } from '../lib/process.js';
import { ensurePrivateDirectory } from '../lib/filesystem.js';

const LAUNCHCTL = '/bin/launchctl';
const PLUTIL = '/usr/bin/plutil';

export interface LaunchAgentRenderOptions {
  readonly cliPath: string;
  readonly label: string;
  readonly logDirectory: string;
  readonly nodePath: string;
  readonly watchScheduledHour?: number;
  readonly watchScheduledMinute?: number;
  readonly scheduledHour?: number;
  readonly scheduledMinute?: number;
  readonly scheduledWeekday?: number | null;
  readonly workingDirectory: string;
}

export interface LaunchAgentInstallOptions {
  readonly execFile?: ExecFile;
  readonly operations?: Partial<LaunchAgentTransactionOperations>;
  readonly plistPath: string;
  readonly renderOptions: LaunchAgentRenderOptions;
  readonly uid: number;
}

export interface LaunchAgentTransactionOperations {
  readonly backup: (source: string, destination: string) => void;
  readonly remove: (path: string) => void;
  readonly replace: (source: string, destination: string) => void;
  readonly restore: (source: string, destination: string) => void;
}

export interface LaunchAgentTransactionPhases {
  readonly backupCreated: boolean;
  readonly oldBootedOut: boolean;
  readonly oldExists: boolean;
  readonly oldLoaded: boolean;
  readonly replacementApplied: boolean;
  readonly replacementBootedOut: boolean;
  readonly restorationSucceeded: boolean;
}

export class IncompleteLaunchAgentRollbackError extends AggregateError {
  readonly phases: LaunchAgentTransactionPhases;
  readonly recoveryKind: 'copy' | 'in-place';
  readonly recoveryPath: string;

  constructor(
    errors: readonly unknown[],
    recoveryPath: string,
    phases: LaunchAgentTransactionPhases,
    recoveryKind: 'copy' | 'in-place' = 'copy',
  ) {
    super(
      errors,
      `LaunchAgent installation failed and rollback was incomplete. ` +
        (recoveryKind === 'copy'
          ? `A recovery copy is preserved at ${recoveryPath}. `
          : `An in-place recovery artifact remains at ${recoveryPath}; a separate recovery copy could not be created. `) +
        `Manual recovery is required; ` +
        'inspect the loaded service before restoring or bootstrapping any plist.',
    );
    this.name = 'IncompleteLaunchAgentRollbackError';
    this.phases = { ...phases };
    this.recoveryKind = recoveryKind;
    this.recoveryPath = recoveryPath;
  }
}

const defaultTransactionOperations: LaunchAgentTransactionOperations = {
  backup: (source, destination) =>
    copyFileSync(source, destination, fsConstants.COPYFILE_EXCL),
  remove: (path) => rmSync(path, { force: true }),
  replace: (source, destination) => renameSync(source, destination),
  restore: (source, destination) => renameSync(source, destination),
};

export interface LaunchAgentUninstallOptions {
  readonly execFile?: ExecFile;
  readonly label: string;
  readonly plistPath: string;
  readonly uid: number;
}

export function renderLaunchAgent(options: LaunchAgentRenderOptions): string {
  validateRenderOptions(options);
  const hour = options.scheduledHour ?? 9;
  const minute = options.scheduledMinute ?? 0;
  const weekday = options.scheduledWeekday;
  const stdoutPath = join(options.logDirectory, 'stdout.log');
  const stderrPath = join(options.logDirectory, 'stderr.log');

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${escapeXml(options.label)}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${escapeXml(options.nodePath)}</string>
    <string>${escapeXml(options.cliPath)}</string>
    <string>run</string>
    <string>--scheduled</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${escapeXml(options.workingDirectory)}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>StartCalendarInterval</key>
  <array>
  <dict>
${weekday == null ? '' : `    <key>Weekday</key>\n    <integer>${String(weekday)}</integer>\n`}
    <key>Hour</key>
    <integer>${String(hour)}</integer>
    <key>Minute</key>
    <integer>${String(minute)}</integer>
  </dict>
  <dict>
    <key>Hour</key>
    <integer>${String(options.watchScheduledHour ?? 8)}</integer>
    <key>Minute</key>
    <integer>${String(options.watchScheduledMinute ?? 0)}</integer>
  </dict>
  </array>
  <key>StandardOutPath</key>
  <string>${escapeXml(stdoutPath)}</string>
  <key>StandardErrorPath</key>
  <string>${escapeXml(stderrPath)}</string>
</dict>
</plist>
`;
}

export async function installLaunchAgent(
  options: LaunchAgentInstallOptions,
): Promise<void> {
  validateInstallTarget(options.plistPath, options.uid);
  const execFile = options.execFile ?? defaultExecFile;
  const operations = {
    ...defaultTransactionOperations,
    ...options.operations,
  };
  await validateRuntime(options.renderOptions, execFile);
  mkdirSync(dirname(options.plistPath), { recursive: true });
  const candidatePath = transactionPath(options.plistPath, 'candidate');
  const backupPath = transactionPath(options.plistPath, 'backup');
  const phases: MutableLaunchAgentTransactionPhases = {
    backupCreated: false,
    oldBootedOut: false,
    oldExists: false,
    oldLoaded: false,
    replacementApplied: false,
    replacementBootedOut: false,
    restorationSucceeded: false,
  };
  let oldPlistPrevalidated = false;
  let preserveBackup = false;

  try {
    writeFileSync(candidatePath, renderLaunchAgent(options.renderOptions), {
      flag: 'wx',
      mode: 0o644,
    });
    await execFile(PLUTIL, ['-lint', candidatePath]);
    phases.oldLoaded = await isAgentLoaded(
      execFile,
      serviceTarget(options.uid, options.renderOptions.label),
    );
    phases.oldExists = existsSync(options.plistPath);
    if (phases.oldLoaded) {
      if (!phases.oldExists) {
        throw new Error(
          `Loaded LaunchAgent plist is missing at ${options.plistPath}; ` +
            'refusing to unload the existing service',
        );
      }
      await execFile(PLUTIL, ['-lint', options.plistPath]);
      oldPlistPrevalidated = true;
    }
    if (phases.oldExists) {
      operations.backup(options.plistPath, backupPath);
      verifyBackup(options.plistPath, backupPath);
      phases.backupCreated = true;
    }
    if (phases.oldLoaded) {
      await execFile(LAUNCHCTL, [
        'bootout',
        serviceTarget(options.uid, options.renderOptions.label),
      ]);
      phases.oldBootedOut = true;
    }

    operations.replace(candidatePath, options.plistPath);
    phases.replacementApplied = true;
    ensurePrivateDirectory(options.renderOptions.logDirectory);
    await execFile(LAUNCHCTL, [
      'bootstrap',
      userDomain(options.uid),
      options.plistPath,
    ]);
  } catch (error) {
    const rollback = await rollbackInstallation({
      backupPath,
      execFile,
      label: options.renderOptions.label,
      oldPlistPrevalidated,
      operations,
      phases,
      plistPath: options.plistPath,
      uid: options.uid,
    });
    preserveBackup = rollback.preserveBackup;
    if (rollback.incomplete || rollback.restoreFailed) {
      throw new IncompleteLaunchAgentRollbackError(
        [error, ...rollback.errors],
        rollback.recoveryPath,
        phases,
        rollback.recoveryKind,
      );
    }
    if (rollback.errors.length > 0) {
      throw new AggregateError(
        [error, ...rollback.errors],
        'LaunchAgent installation failed and rollback was incomplete',
      );
    }
    throw error;
  } finally {
    operations.remove(candidatePath);
    if (!preserveBackup) operations.remove(backupPath);
  }
}

export async function uninstallLaunchAgent(
  options: LaunchAgentUninstallOptions,
): Promise<void> {
  validateInstallTarget(options.plistPath, options.uid);
  if (!options.label.trim()) throw new TypeError('label must not be empty');
  const execFile = options.execFile ?? defaultExecFile;
  await allowUnavailableAgent(() =>
    execFile(LAUNCHCTL, ['bootout', serviceTarget(options.uid, options.label)]),
  );
  if (existsSync(options.plistPath)) {
    rmSync(options.plistPath);
  }
}

function validateRenderOptions(options: LaunchAgentRenderOptions): void {
  for (const field of [
    'nodePath',
    'cliPath',
    'workingDirectory',
    'logDirectory',
  ] as const) {
    if (!isAbsolute(options[field])) {
      throw new TypeError(`${field} must be an absolute path`);
    }
  }
  if (!options.label.trim()) {
    throw new TypeError('label must not be empty');
  }
  validateCalendarValue(
    'watchScheduledHour',
    options.watchScheduledHour ?? 8,
    23,
  );
  validateCalendarValue(
    'watchScheduledMinute',
    options.watchScheduledMinute ?? 0,
    59,
  );
  validateCalendarValue('scheduledHour', options.scheduledHour ?? 9, 23);
  validateCalendarValue('scheduledMinute', options.scheduledMinute ?? 0, 59);
  if (options.scheduledWeekday != null) {
    validateCalendarValue('scheduledWeekday', options.scheduledWeekday, 6);
  }
}

function validateCalendarValue(
  field: string,
  value: number,
  maximum: number,
): void {
  if (!Number.isInteger(value) || value < 0 || value > maximum) {
    throw new RangeError(`${field} must be an integer from 0 to ${maximum}`);
  }
}

function validateInstallTarget(plistPath: string, uid: number): void {
  if (!isAbsolute(plistPath)) {
    throw new TypeError('plistPath must be an absolute path');
  }
  if (!Number.isSafeInteger(uid) || uid < 0) {
    throw new RangeError('uid must be a non-negative integer');
  }
}

function userDomain(uid: number): string {
  return `gui/${String(uid)}`;
}

function serviceTarget(uid: number, label: string): string {
  return `${userDomain(uid)}/${label}`;
}

async function allowUnavailableAgent(action: () => Promise<unknown>) {
  try {
    await action();
  } catch (error) {
    if (!isUnavailableAgent(error)) throw error;
  }
}

function isUnavailableAgent(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const stderr = 'stderr' in error ? error.stderr : undefined;
  return (
    typeof stderr === 'string' &&
    /could not find service|no such process|service.*not found/i.test(stderr)
  );
}

async function isAgentLoaded(
  execFile: ExecFile,
  target: string,
): Promise<boolean> {
  try {
    await execFile(LAUNCHCTL, ['print', target]);
    return true;
  } catch (error) {
    if (isUnavailableAgent(error)) return false;
    throw error;
  }
}

type MutableLaunchAgentTransactionPhases = {
  -readonly [
    Key in keyof LaunchAgentTransactionPhases
  ]: LaunchAgentTransactionPhases[Key];
};

interface RollbackOptions {
  readonly backupPath: string;
  readonly execFile: ExecFile;
  readonly label: string;
  readonly oldPlistPrevalidated: boolean;
  readonly operations: LaunchAgentTransactionOperations;
  readonly phases: MutableLaunchAgentTransactionPhases;
  readonly plistPath: string;
  readonly uid: number;
}

interface RollbackResult {
  readonly errors: unknown[];
  readonly incomplete: boolean;
  readonly preserveBackup: boolean;
  readonly recoveryKind: 'copy' | 'in-place';
  readonly recoveryPath: string;
  readonly restoreFailed: boolean;
}

async function rollbackInstallation(
  options: RollbackOptions,
): Promise<RollbackResult> {
  const errors: unknown[] = [];
  const target = serviceTarget(options.uid, options.label);
  let preserveBackup = false;
  let restoreFailed = false;
  let recoveryKind: 'copy' | 'in-place' = 'copy';
  let recoveryPath = options.backupPath;

  if (options.phases.replacementApplied) {
    try {
      await allowUnavailableAgent(() =>
        options.execFile(LAUNCHCTL, ['bootout', target]),
      );
      options.phases.replacementBootedOut = true;
    } catch (error) {
      errors.push(error);
      if (!options.phases.oldExists) {
        try {
          options.operations.backup(options.plistPath, options.backupPath);
          verifyBackup(options.plistPath, options.backupPath);
          options.phases.backupCreated = true;
        } catch (backupError) {
          errors.push(backupError);
          recoveryKind = 'in-place';
          recoveryPath = options.plistPath;
        }
      }
      preserveBackup = options.phases.backupCreated;
      return {
        errors,
        incomplete: true,
        preserveBackup,
        recoveryKind,
        recoveryPath,
        restoreFailed: false,
      };
    }
    if (options.phases.oldExists) {
      try {
        if (!options.phases.backupCreated) {
          throw new Error('The pre-install plist backup was not created');
        }
        options.operations.restore(options.backupPath, options.plistPath);
        options.phases.restorationSucceeded = true;
      } catch (error) {
        errors.push(error);
        restoreFailed = true;
        preserveBackup = options.phases.backupCreated;
      }
    } else {
      try {
        options.operations.remove(options.plistPath);
        options.phases.restorationSucceeded = true;
      } catch (error) {
        errors.push(error);
      }
    }

    if (
      options.phases.oldLoaded &&
      options.phases.oldBootedOut &&
      options.oldPlistPrevalidated &&
      options.phases.restorationSucceeded
    ) {
      try {
        await options.execFile(LAUNCHCTL, [
          'bootstrap',
          userDomain(options.uid),
          options.plistPath,
        ]);
      } catch (error) {
        errors.push(error);
        preserveBackup = existsSync(options.backupPath);
      }
    }
  } else if (
    options.phases.oldBootedOut &&
    options.phases.oldLoaded &&
    options.phases.oldExists &&
    options.oldPlistPrevalidated
  ) {
    options.phases.restorationSucceeded = true;
    try {
      await options.execFile(LAUNCHCTL, [
        'bootstrap',
        userDomain(options.uid),
        options.plistPath,
      ]);
    } catch (error) {
      errors.push(error);
      preserveBackup = existsSync(options.backupPath);
    }
  }

  return {
    errors,
    incomplete: false,
    preserveBackup,
    recoveryKind,
    recoveryPath,
    restoreFailed,
  };
}

function verifyBackup(sourcePath: string, backupPath: string): void {
  if (!existsSync(backupPath)) {
    throw new Error(`LaunchAgent backup was not created at ${backupPath}`);
  }
  if (!readFileSync(sourcePath).equals(readFileSync(backupPath))) {
    throw new Error(`LaunchAgent backup verification failed at ${backupPath}`);
  }
}

async function validateRuntime(
  options: LaunchAgentRenderOptions,
  execFile: ExecFile,
): Promise<void> {
  try {
    accessSync(options.nodePath, fsConstants.F_OK | fsConstants.X_OK);
    if (!statSync(options.nodePath).isFile()) throw new Error('not a file');
  } catch (error) {
    throw new Error(
      `Node executable is missing or not executable: ${options.nodePath}`,
      { cause: error },
    );
  }
  try {
    accessSync(options.cliPath, fsConstants.F_OK | fsConstants.R_OK);
    if (!statSync(options.cliPath).isFile()) throw new Error('not a file');
  } catch (error) {
    throw new Error(`Compiled CLI is missing: ${options.cliPath}`, {
      cause: error,
    });
  }

  const result = await execFile(options.nodePath, ['--version']);
  const match = /^v?(\d+)\.(\d+)\.(\d+)\s*$/.exec(result.stdout.trim());
  if (!match) {
    throw new Error(
      `Could not determine Node version from ${options.nodePath}: ${result.stdout.trim()}`,
    );
  }
  const major = Number(match[1]);
  const minor = Number(match[2]);
  if (major < 22 || (major === 22 && minor < 13)) {
    throw new Error(
      `LaunchAgent requires Node 22.13.0 or newer; ${options.nodePath} reports ${result.stdout.trim()}`,
    );
  }
}

function transactionPath(plistPath: string, kind: string): string {
  return `${plistPath}.${kind}-${randomUUID()}`;
}

function escapeXml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}
