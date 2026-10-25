import { randomUUID } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  fstatSync,
  lstatSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  renameSync,
  rmSync,
  type Stats,
} from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';

import {
  createPrivateTextFile,
  openPrivateRegularFile,
  pathExistsWithoutFollowing,
} from '../lib/filesystem.js';
import { FileRunLock } from '../lib/process.js';
import { appPaths } from './paths.js';

export function legacyDataDirectory(homeDirectory: string): string {
  return join(homeDirectory, '.costco-price-matcher');
}

export interface DataMigrationOptions {
  readonly readOnly?: boolean;
  readonly rename?: (source: string, destination: string) => void;
  readonly replaceConfig?: (source: string, destination: string) => void;
  readonly isProcessAlive?: (pid: number) => boolean;
}

/** Move the private tree, including the locked inode and Chrome profile; never copy it. */
export async function migrateLegacyDataDirectory(
  homeDirectory: string,
  options: DataMigrationOptions = {},
): Promise<void> {
  const destination = appPaths(homeDirectory).dataDir;
  const legacy = legacyDataDirectory(homeDirectory);
  if (pathExistsWithoutFollowing(destination)) {
    assertConfigMigrationComplete(destination);
    return;
  }
  if (!pathExistsWithoutFollowing(legacy)) return;

  if (options.readOnly) {
    throw new Error(
      'Legacy data needs migration. Run ./costco status before a watch dry run; dry runs do not move data or rewrite configuration.',
    );
  }

  const original = assertPrivateDirectory(legacy);
  await new FileRunLock(join(legacy, 'run.lock')).runExclusive(async () => {
    // A different invocation may have migrated while this one acquired flock.
    if (pathExistsWithoutFollowing(destination)) {
      assertConfigMigrationComplete(destination);
      return;
    }
    const current = assertPrivateDirectory(legacy);
    if (current.dev !== original.dev || current.ino !== original.ino) {
      throw new Error('Legacy data directory changed during migration; retry.');
    }
    assertBrowserProfileIdle(
      join(legacy, 'browser-profile'),
      options.isProcessAlive ?? isProcessAlive,
    );
    const config = prepareConfigRewrite(legacy, destination);
    const temporaryName = `.config-migration-${randomUUID()}.tmp`;
    const stagedConfig = join(legacy, temporaryName);
    let moved = false;
    try {
      // Stage the replacement before moving, so invalid/unwritable config stops early.
      if (config !== null) {
        createPrivateTextFile(stagedConfig, config.contents);
        chmodSync(stagedConfig, config.mode);
      }
      try {
        (options.rename ?? renameSync)(legacy, destination);
        moved = true;
      } catch (error) {
        throw new Error(
          'Costco Genie could not atomically rename the legacy data directory ' +
            '(including across filesystems/EXDEV). No data was copied or moved; ' +
            'keep both paths on the same filesystem and retry.',
          { cause: error },
        );
      }
      if (config !== null) {
        try {
          (options.replaceConfig ?? renameSync)(
            join(destination, temporaryName),
            join(destination, 'config.json'),
          );
        } catch (error) {
          // Keep the prepared config for manual recovery; never discard private settings.
          throw new Error(
            `Data moved to ${destination}, but config path rewriting failed. ` +
              `The prepared configuration is ${join(destination, temporaryName)}; ` +
              'restore it as config.json before retrying.',
            { cause: error },
          );
        }
      }
    } finally {
      if (!moved) rmSync(stagedConfig, { force: true });
    }
  });
}

function assertConfigMigrationComplete(destination: string): void {
  // Do not follow a linked root just to inspect migration state.
  const stat = lstatSync(destination);
  if (!stat.isDirectory() || stat.isSymbolicLink()) return;
  const pending = readdirSync(destination).find((name) =>
    /^\.config-migration-[\da-f-]+\.tmp$/u.test(name),
  );
  if (pending) {
    throw new Error(
      `Data moved to ${destination}, but config path rewriting is incomplete. ` +
        `The prepared configuration is ${join(destination, pending)}; ` +
        'restore it as config.json before retrying.',
    );
  }
}

function assertPrivateDirectory(path: string): Stats {
  const stat = lstatSync(path);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    (process.getuid !== undefined && stat.uid !== process.getuid()) ||
    (stat.mode & 0o077) !== 0
  ) {
    throw new Error(
      `Refusing migration: ${path} must be a real owner-only directory, not a symlink.`,
    );
  }
  return stat;
}

function assertBrowserProfileIdle(
  profile: string,
  processAlive: (pid: number) => boolean,
): void {
  if (!pathExistsWithoutFollowing(profile)) return;
  assertPrivateDirectory(profile);
  const entries = ['SingletonLock', 'SingletonSocket', 'SingletonCookie'];
  if (
    !entries.some((entry) => pathExistsWithoutFollowing(join(profile, entry)))
  )
    return;

  const lock = join(profile, 'SingletonLock');
  if (pathExistsWithoutFollowing(lock) && lstatSync(lock).isSymbolicLink()) {
    const match = /^(.*)-(\d+)$/.exec(readlinkSync(lock));
    const pid = Number(match?.[2]);
    // Only a provably stale lock from this host is safe; cookie/socket alone is ambiguous.
    if (
      match?.[1] === hostname() &&
      Number.isSafeInteger(pid) &&
      pid > 0 &&
      !processAlive(pid)
    )
      return;
  }
  throw new Error(
    'Cannot migrate the Chrome profile: close the dedicated Costco Chrome window and retry.',
  );
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM and other uncertain results cannot establish that Chrome has exited.
    return !(
      error instanceof Error &&
      'code' in error &&
      error.code === 'ESRCH'
    );
  }
}

function prepareConfigRewrite(
  legacy: string,
  destination: string,
): { contents: string; mode: number } | null {
  const path = join(legacy, 'config.json');
  if (!pathExistsWithoutFollowing(path)) return null;
  const fd = openPrivateRegularFile(path, { readOnly: true });
  try {
    const mode = fstatSync(fd).mode & 0o777;
    if ((mode & 0o077) !== 0)
      throw new Error('Configuration must be owner-only.');
    const text = readFileSync(fd, 'utf8');
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      throw new Error(
        'Cannot migrate invalid config.json; repair the legacy configuration and retry.',
      );
    }
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw new Error(
        'Cannot migrate config.json: expected a configuration object.',
      );
    }
    const rewritten = JSON.stringify(
      value,
      (_key, entry: unknown) =>
        typeof entry === 'string' &&
        (entry === legacy || entry.startsWith(`${legacy}/`))
          ? destination + entry.slice(legacy.length)
          : entry,
      2,
    );
    return rewritten === JSON.stringify(value, null, 2)
      ? null
      : { contents: `${rewritten}\n`, mode };
  } finally {
    closeSync(fd);
  }
}
