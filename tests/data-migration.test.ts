import {
  chmodSync,
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import fsExt from 'fs-ext';
import { afterEach, describe, expect, it } from 'vitest';

import { createDefaultCliActions, runCli } from '../src/cli.js';
import {
  legacyDataDirectory,
  migrateLegacyDataDirectory,
} from '../src/config/migrate.js';
import { appPaths } from '../src/config/paths.js';
import { openPrivateRegularFile } from '../src/lib/filesystem.js';
import { FileRunLock, RunOverlapError } from '../src/lib/process.js';
import {
  LEGACY_AGENT_LABEL,
  launchAgentPath,
} from '../src/scheduler/launchd.js';

const homes: string[] = [];
function fixture(legacyExists = true) {
  const home = mkdtempSync(join(tmpdir(), 'costco-genie-migration-'));
  homes.push(home);
  const legacy = legacyDataDirectory(home);
  const paths = appPaths(home);
  if (legacyExists) {
    mkdirSync(legacy, { mode: 0o700 });
    mkdirSync(join(legacy, 'browser-profile'), { mode: 0o700 });
    writeFileSync(join(legacy, 'run.lock'), '', { mode: 0o600 });
    writeFileSync(join(legacy, 'config.json'), '{}\n', { mode: 0o600 });
    writeFileSync(join(legacy, 'costco.sqlite'), 'synthetic database', {
      mode: 0o600,
    });
    writeFileSync(
      join(legacy, 'browser-profile', 'synthetic-session'),
      'synthetic profile',
      { mode: 0o600 },
    );
  }
  return { home, legacy, paths };
}
afterEach(() => {
  for (const home of homes.splice(0))
    rmSync(home, { recursive: true, force: true });
});

describe('migrateLegacyDataDirectory', () => {
  it('leaves an absent installation absent', async () => {
    const { home } = fixture(false);
    await migrateLegacyDataDirectory(home);
    expect(readdirSync(home)).toEqual([]);
  });

  it('renames the entire legacy tree under flock, preserving inodes and owner-only modes, and is idempotent', async () => {
    const { home, legacy, paths } = fixture();
    const names = [
      '',
      'browser-profile',
      'browser-profile/synthetic-session',
      'costco.sqlite',
      'config.json',
      'run.lock',
    ];
    const before = names.map((name) => lstatSync(join(legacy, name)));
    await migrateLegacyDataDirectory(home, {
      rename(source, destination) {
        expect([source, destination]).toEqual([legacy, paths.dataDir]);
        const fd = openPrivateRegularFile(join(legacy, 'run.lock'));
        try {
          expect(() => fsExt.flockSync(fd, 'exnb')).toThrow();
        } finally {
          closeSync(fd);
        }
        renameSync(source, destination);
      },
    });
    expect(existsSync(legacy)).toBe(false);
    for (const [index, name] of names.entries()) {
      const after = lstatSync(join(paths.dataDir, name));
      expect(after.ino).toBe(before[index]?.ino);
      expect(after.mode).toBe(before[index]?.mode);
    }
    expect(readFileSync(paths.databaseFile, 'utf8')).toBe('synthetic database');
    const configStat = lstatSync(paths.configFile);
    await migrateLegacyDataDirectory(home);
    expect(lstatSync(paths.configFile).mtimeMs).toBe(configStat.mtimeMs);
    await new FileRunLock(join(paths.dataDir, 'run.lock')).runExclusive(
      async () => {},
    );
  });

  it('uses the new tree when both directories exist without merging or deleting', async () => {
    const { home, legacy, paths } = fixture();
    mkdirSync(paths.dataDir, { mode: 0o700 });
    writeFileSync(paths.configFile, '{"emailEveryRun":true}', { mode: 0o600 });
    const before = lstatSync(legacy);
    await migrateLegacyDataDirectory(home);
    expect(lstatSync(legacy).ino).toBe(before.ino);
    expect(readFileSync(paths.configFile, 'utf8')).toBe(
      '{"emailEveryRun":true}',
    );
    expect(existsSync(paths.databaseFile)).toBe(false);
  });

  it('refuses symlinked legacy directories without accessing their targets', async () => {
    const { home, legacy, paths } = fixture(false);
    const target = join(home, 'target');
    mkdirSync(target, { mode: 0o700 });
    symlinkSync(target, legacy);
    await expect(migrateLegacyDataDirectory(home)).rejects.toThrow(
      'real owner-only directory',
    );
    expect(readdirSync(target)).toEqual([]);
    expect(existsSync(paths.dataDir)).toBe(false);
  });

  it('refuses nonprivate or non-directory legacy roots', async () => {
    const { home, legacy } = fixture();
    chmodSync(legacy, 0o755);
    await expect(migrateLegacyDataDirectory(home)).rejects.toThrow(
      'owner-only',
    );
    expect(lstatSync(legacy).mode & 0o777).toBe(0o755);
    rmSync(legacy, { recursive: true });
    writeFileSync(legacy, 'not a directory');
    await expect(migrateLegacyDataDirectory(home)).rejects.toThrow(
      'real owner-only directory',
    );
  });

  it('refuses a running Chrome profile using real process liveness without opening the profile', async () => {
    const { home, legacy, paths } = fixture();
    symlinkSync(
      `${hostname()}-${process.pid}`,
      join(legacy, 'browser-profile', 'SingletonLock'),
    );
    symlinkSync(
      '/synthetic/socket/SingletonSocket',
      join(legacy, 'browser-profile', 'SingletonSocket'),
    );
    symlinkSync(
      'synthetic-cookie',
      join(legacy, 'browser-profile', 'SingletonCookie'),
    );
    await expect(migrateLegacyDataDirectory(home)).rejects.toThrow(
      'close the dedicated Costco Chrome window and retry',
    );
    expect(existsSync(paths.dataDir)).toBe(false);
    expect(existsSync(legacy)).toBe(true);
  });

  it.each(['SingletonSocket', 'SingletonCookie'])(
    'refuses an ambiguous %s without a provably stale local lock',
    async (entry) => {
      const { home, legacy } = fixture();
      symlinkSync('synthetic-target', join(legacy, 'browser-profile', entry));
      await expect(migrateLegacyDataDirectory(home)).rejects.toThrow(
        'close the dedicated Costco Chrome window and retry',
      );
    },
  );

  it('allows stale local Chrome singleton links when their process is dead', async () => {
    const { home, legacy, paths } = fixture();
    symlinkSync(
      `${hostname()}-123456789`,
      join(legacy, 'browser-profile', 'SingletonLock'),
    );
    symlinkSync(
      'synthetic-cookie',
      join(legacy, 'browser-profile', 'SingletonCookie'),
    );
    await migrateLegacyDataDirectory(home, { isProcessAlive: () => false });
    expect(
      lstatSync(
        join(paths.browserProfileDir, 'SingletonLock'),
      ).isSymbolicLink(),
    ).toBe(true);
  });

  it('refuses a symlinked browser profile or lock/config file', async () => {
    const { home, legacy } = fixture();
    rmSync(join(legacy, 'browser-profile'), { recursive: true });
    symlinkSync(home, join(legacy, 'browser-profile'));
    await expect(migrateLegacyDataDirectory(home)).rejects.toThrow(
      'real owner-only directory',
    );
    rmSync(join(legacy, 'browser-profile'));
    for (const name of ['run.lock', 'config.json']) {
      rmSync(join(legacy, name));
      symlinkSync(join(home, 'missing'), join(legacy, name));
      await expect(migrateLegacyDataDirectory(home)).rejects.toThrow(
        'symbolic links',
      );
      rmSync(join(legacy, name));
      writeFileSync(join(legacy, name), '{}', { mode: 0o600 });
    }
  });

  it('refuses migration while a legacy check owns run.lock', async () => {
    const { home, legacy, paths } = fixture();
    await new FileRunLock(join(legacy, 'run.lock')).runExclusive(async () => {
      await expect(migrateLegacyDataDirectory(home)).rejects.toBeInstanceOf(
        RunOverlapError,
      );
      expect(existsSync(paths.dataDir)).toBe(false);
    });
  });

  it('leaves all data and rewritten config untouched on EXDEV without copying', async () => {
    const { home, legacy, paths } = fixture();
    const config = JSON.stringify({
      smtpConfigPath: join(legacy, 'smtp.json'),
    });
    writeFileSync(join(legacy, 'config.json'), config);
    const before = readdirSync(legacy);
    const inode = lstatSync(join(legacy, 'config.json')).ino;
    await expect(
      migrateLegacyDataDirectory(home, {
        rename() {
          throw Object.assign(new Error('cross-device'), { code: 'EXDEV' });
        },
      }),
    ).rejects.toThrow(/atomically rename.*EXDEV.*No data was copied or moved/);
    expect(readdirSync(legacy)).toEqual(before);
    expect(readFileSync(join(legacy, 'config.json'), 'utf8')).toBe(config);
    expect(lstatSync(join(legacy, 'config.json')).ino).toBe(inode);
    expect(existsSync(paths.dataDir)).toBe(false);
  });

  it('rewrites only path values within the old prefix and preserves settings, file modes, and SMTP inode', async () => {
    const { home, legacy, paths } = fixture();
    const smtp = join(legacy, 'smtp.json');
    writeFileSync(smtp, 'synthetic SMTP placeholder', { mode: 0o600 });
    const smtpInode = lstatSync(smtp).ino;
    writeFileSync(
      join(legacy, 'config.json'),
      JSON.stringify({
        smtpConfigPath: smtp,
        emailRecipient: 'you@example.com',
        scheduledWeekday: 3,
        watchScheduledHour: 7,
        nested: {
          paths: [legacy, `${legacy}-other/smtp.json`, '/external/smtp.json'],
        },
      }),
    );
    chmodSync(join(legacy, 'config.json'), 0o400);
    await migrateLegacyDataDirectory(home);
    expect(JSON.parse(readFileSync(paths.configFile, 'utf8'))).toEqual({
      smtpConfigPath: join(paths.dataDir, 'smtp.json'),
      emailRecipient: 'you@example.com',
      scheduledWeekday: 3,
      watchScheduledHour: 7,
      nested: {
        paths: [
          paths.dataDir,
          `${legacy}-other/smtp.json`,
          '/external/smtp.json',
        ],
      },
    });
    expect(lstatSync(paths.configFile).mode & 0o777).toBe(0o400);
    expect(lstatSync(join(paths.dataDir, 'smtp.json')).ino).toBe(smtpInode);
    expect(lstatSync(join(paths.dataDir, 'smtp.json')).mode & 0o777).toBe(
      0o600,
    );
    expect(
      readdirSync(paths.dataDir).some((name) => name.includes('migration')),
    ).toBe(false);
    await migrateLegacyDataDirectory(home);
    expect(lstatSync(paths.configFile).mode & 0o777).toBe(0o400);
  });

  it('fails before moving invalid config without echoing its contents', async () => {
    const { home, legacy, paths } = fixture();
    writeFileSync(
      join(legacy, 'config.json'),
      'synthetic-private-setting-invalid-json',
    );
    await expect(migrateLegacyDataDirectory(home)).rejects.toThrow(
      'Cannot migrate invalid config.json',
    );
    expect(existsSync(legacy)).toBe(true);
    expect(existsSync(paths.dataDir)).toBe(false);
  });

  it('blocks subsequent commands after a failed config replacement until the prepared config is restored', async () => {
    const { home, legacy, paths } = fixture();
    writeFileSync(
      join(legacy, 'config.json'),
      JSON.stringify({ smtpConfigPath: join(legacy, 'smtp.json') }),
    );
    await expect(
      migrateLegacyDataDirectory(home, {
        replaceConfig() {
          throw new Error('TEST-config replacement failed');
        },
      }),
    ).rejects.toThrow('config path rewriting failed');
    expect(existsSync(legacy)).toBe(false);
    const prepared = readdirSync(paths.dataDir).find((name) =>
      name.startsWith('.config-migration-'),
    )!;
    const oldConfig = readFileSync(paths.configFile, 'utf8');
    expect(oldConfig).toContain(legacy);
    await expect(migrateLegacyDataDirectory(home)).rejects.toThrow(
      'config path rewriting is incomplete',
    );
    const actions = createDefaultCliActions({ homeDirectory: home });
    await expect(actions.run({ scheduled: true })).rejects.toThrow(prepared);
    expect(readFileSync(paths.configFile, 'utf8')).toBe(oldConfig);
    renameSync(join(paths.dataDir, prepared), paths.configFile);
    await expect(migrateLegacyDataDirectory(home)).resolves.toBeUndefined();
    expect(JSON.parse(readFileSync(paths.configFile, 'utf8'))).toEqual({
      smtpConfigPath: join(paths.dataDir, 'smtp.json'),
    });
  });
});

describe('CLI migration entry points', () => {
  it('refuses a legacy-only dry run without moving data, changing permissions, or rewriting config', async () => {
    const { home, legacy, paths } = fixture();
    writeFileSync(
      join(legacy, 'config.json'),
      JSON.stringify({ smtpConfigPath: join(legacy, 'smtp.json') }),
    );
    chmodSync(join(legacy, 'run.lock'), 0o400);
    const names = readdirSync(legacy);
    const before = names.map((name) => ({
      stat: lstatSync(join(legacy, name)),
      contents: lstatSync(join(legacy, name)).isFile()
        ? readFileSync(join(legacy, name))
        : null,
    }));
    const actions = createDefaultCliActions({ homeDirectory: home });
    await expect(actions.watch!(['check', '--dry-run'])).rejects.toThrow(
      'Run ./costco status before a watch dry run',
    );
    expect(existsSync(paths.dataDir)).toBe(false);
    expect(readdirSync(legacy)).toEqual(names);
    for (const [index, name] of names.entries()) {
      const stat = lstatSync(join(legacy, name));
      expect([stat.ino, stat.mode, stat.mtimeMs]).toEqual([
        before[index].stat.ino,
        before[index].stat.mode,
        before[index].stat.mtimeMs,
      ]);
      if (before[index].contents)
        expect(readFileSync(join(legacy, name))).toEqual(
          before[index].contents,
        );
    }
  });

  it('migrates real legacy config and database on the first offline status and doctor invocation', async () => {
    const { home, legacy, paths } = fixture(false);
    const actions = createDefaultCliActions({
      homeDirectory: home,
      dependencies: {
        isLaunchAgentLoaded: async () => false,
        mailApplicationExists: () => true,
      },
    });
    await actions.setup({ scheduledWeekday: 4, watchScheduledHour: 6 });
    renameSync(paths.dataDir, legacy);
    expect(await actions.status()).toContain('Watch schedule: daily 06:00');
    expect(existsSync(legacy)).toBe(false);
    renameSync(paths.dataDir, legacy);
    expect((await actions.doctor()).checks).toContainEqual(
      expect.objectContaining({ name: 'database', ok: true }),
    );
    expect(existsSync(legacy)).toBe(false);
    expect(
      JSON.parse(readFileSync(paths.configFile, 'utf8')).scheduledWeekday,
    ).toBe(4);
  });

  it.each(['plist', 'loaded-service'])(
    'reports both directories and a lingering legacy agent via %s without merging or cleaning up',
    async (kind) => {
      const { home, legacy } = fixture(false);
      let inspectedLabel = '';
      const actions = createDefaultCliActions({
        homeDirectory: home,
        dependencies: {
          platform: 'darwin',
          getUid: () => 777,
          mailApplicationExists: () => true,
          isLaunchAgentLoaded: async (uid, label) => {
            expect(uid).toBe(777);
            inspectedLabel = label;
            return kind === 'loaded-service';
          },
        },
      });
      await actions.setup({});
      mkdirSync(legacy, { mode: 0o700 });
      const plist = launchAgentPath(home, LEGACY_AGENT_LABEL);
      if (kind === 'plist') {
        mkdirSync(join(home, 'Library', 'LaunchAgents'), { recursive: true });
        writeFileSync(plist, 'synthetic legacy agent');
      }
      const status = await actions.status();
      expect(status).toContain('Costco Genie status');
      expect(status).toContain('Legacy data directory still exists');
      expect(status).toContain(
        `Legacy LaunchAgent ${LEGACY_AGENT_LABEL} remains`,
      );
      const doctor = await actions.doctor();
      expect(doctor.ok).toBe(false);
      expect(
        doctor.checks.filter((check) => check.name === 'legacy-installation'),
      ).toHaveLength(2);
      expect(readdirSync(legacy)).toEqual([]);
      if (kind === 'loaded-service')
        expect(inspectedLabel).toBe(LEGACY_AGENT_LABEL);
      else expect(readFileSync(plist, 'utf8')).toBe('synthetic legacy agent');
    },
  );

  it.each([
    'setup',
    'login',
    'run',
    'run --scheduled',
    'watch list',
    'watch check --dry-run',
    'watch add 123 --no-check',
    'watch remove 123',
    'watch history 123',
    'install-agent',
    'status',
    'doctor',
  ])(
    'migrates before %s can open config, storage, profile, network, mail, or launchctl',
    async (command) => {
      const { home } = fixture(false);
      let migrations = 0;
      const actions = createDefaultCliActions({
        homeDirectory: home,
        dependencies: {
          migrateDataDirectory: async (receivedHome) => {
            expect(receivedHome).toBe(home);
            migrations++;
            throw new Error('synthetic migration stop');
          },
        },
      });
      const errors: string[] = [];
      expect(
        await runCli(command.split(' '), actions, {
          log: () => {},
          error: (text) => errors.push(text),
        }),
      ).toBe(1);
      expect(migrations).toBe(1);
      expect(errors).toEqual(['synthetic migration stop']);
      expect(readdirSync(home)).toEqual([]);
    },
  );

  it('does not migrate or inspect data for help', async () => {
    const { home, legacy } = fixture();
    const actions = createDefaultCliActions({ homeDirectory: home });
    expect(
      await runCli(['help'], actions, { log: () => {}, error: () => {} }),
    ).toBe(0);
    expect(existsSync(legacy)).toBe(true);
    expect(existsSync(appPaths(home).dataDir)).toBe(false);
  });
});
