import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

const temporaryDirectories: string[] = [];
const launcherSource = fileURLToPath(new URL('../costco', import.meta.url));

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'costco-launcher-'));
  temporaryDirectories.push(directory);
  return directory;
}

function writeExecutable(path: string, contents: string): void {
  writeFileSync(path, contents, { mode: 0o755 });
}

function launcherFixture(options: {
  readonly initialNodeVersion: string;
  readonly withNvm: boolean;
}): {
  readonly directory: string;
  readonly environment: NodeJS.ProcessEnv;
  readonly launcher: string;
  readonly logFile: string;
  readonly workingDirectoryFile: string;
} {
  const directory = temporaryDirectory();
  const binDirectory = join(directory, 'bin');
  const nvmDirectory = join(directory, 'nvm');
  const logFile = join(directory, 'commands.log');
  const workingDirectoryFile = join(directory, 'working-directory.log');
  const launcher = join(directory, 'costco');
  mkdirSync(binDirectory);
  writeFileSync(join(directory, '.nvmrc'), '22.13.0\n');
  writeFileSync(join(directory, 'package-lock.json'), '{}\n');
  copyFileSync(launcherSource, launcher);
  chmodSync(launcher, 0o755);

  writeExecutable(
    join(binDirectory, 'node'),
    `#!/bin/sh
version=\${COSTCO_FAKE_NODE_VERSION:-22.2.0}
case "\${1:-}" in
  -e)
    major=\${version%%.*}
    rest=\${version#*.}
    minor=\${rest%%.*}
    if [ "$major" -gt 22 ] || { [ "$major" -eq 22 ] && [ "$minor" -ge 13 ]; }; then
      exit 0
    fi
    exit 1
    ;;
  -p)
    printf '%s-%s-%s\\n' "darwin" "arm64" "127"
    ;;
  dist/cli.js)
    printf 'node %s\\n' "$*" >> "$COSTCO_TEST_LOG"
    printf '%s\\n' "$PWD" > "$COSTCO_TEST_WORKING_DIRECTORY"
    ;;
esac
`,
  );
  writeExecutable(
    join(binDirectory, 'npm'),
    `#!/bin/sh
printf 'npm %s\\n' "$*" >> "$COSTCO_TEST_LOG"
if [ "\${1:-}" = "ci" ]; then
  rm -rf node_modules
  mkdir -p node_modules
fi
`,
  );

  if (options.withNvm) {
    mkdirSync(nvmDirectory);
    writeFileSync(
      join(nvmDirectory, 'nvm.sh'),
      `nvm() {
  printf 'nvm %s\\n' "$*" >> "$COSTCO_TEST_LOG"
  if [ "\${1:-}" = "install" ] && [ "\${2:-}" = "--silent" ]; then
    printf '%s\\n' 'invalid nvm install option' >&2
    return 3
  fi
  export COSTCO_FAKE_NODE_VERSION=22.13.0
}
`,
    );
  }

  return {
    directory,
    environment: {
      COSTCO_FAKE_NODE_VERSION: options.initialNodeVersion,
      COSTCO_TEST_LOG: logFile,
      COSTCO_TEST_WORKING_DIRECTORY: workingDirectoryFile,
      HOME: directory,
      NVM_DIR: options.withNvm ? nvmDirectory : join(directory, 'missing-nvm'),
      PATH: `${binDirectory}:/usr/bin:/bin`,
    },
    launcher,
    logFile,
    workingDirectoryFile,
  };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe('one-command launcher', () => {
  it('selects the pinned NVM runtime, refreshes native dependencies once, builds, and forwards arguments', () => {
    const fixture = launcherFixture({
      initialNodeVersion: '22.2.0',
      withNvm: true,
    });

    execFileSync(fixture.launcher, ['status'], {
      cwd: fixture.directory,
      env: fixture.environment,
    });
    execFileSync(fixture.launcher, ['doctor'], {
      cwd: fixture.directory,
      env: fixture.environment,
    });

    expect(readFileSync(fixture.logFile, 'utf8').trim().split('\n')).toEqual([
      'nvm install',
      'nvm use --silent',
      'npm ci --silent',
      'npm run build --silent',
      'node dist/cli.js status',
      'nvm install',
      'nvm use --silent',
      'npm run build --silent',
      'node dist/cli.js doctor',
    ]);
  });

  it('fails before npm or the CLI when Node is unsupported and NVM is unavailable', () => {
    const fixture = launcherFixture({
      initialNodeVersion: '22.2.0',
      withNvm: false,
    });

    const result = spawnSync(fixture.launcher, ['status'], {
      cwd: fixture.directory,
      encoding: 'utf8',
      env: fixture.environment,
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      'Costco Genie requires Node 22.13.0 or newer',
    );
    expect(result.stderr).toContain('install NVM');
    expect(result.stderr).toContain(
      'or install Node 22.13.0 or newer with npm',
    );
    expect(result.stdout).toBe('');
  });

  it('resolves an npm-style symlink before locating the project', () => {
    const fixture = launcherFixture({
      initialNodeVersion: '22.2.0',
      withNvm: true,
    });
    const globalBinDirectory = join(temporaryDirectory(), 'bin');
    const linkedLauncher = join(globalBinDirectory, 'costco');
    mkdirSync(globalBinDirectory);
    symlinkSync(fixture.launcher, linkedLauncher);

    execFileSync(linkedLauncher, ['status'], {
      cwd: tmpdir(),
      env: fixture.environment,
    });

    expect(readFileSync(fixture.workingDirectoryFile, 'utf8').trim()).toBe(
      realpathSync(fixture.directory),
    );
  });

  it('refreshes dependencies when package-lock.json is newer than the runtime stamp', () => {
    const fixture = launcherFixture({
      initialNodeVersion: '22.13.0',
      withNvm: false,
    });
    execFileSync(fixture.launcher, ['status'], {
      cwd: fixture.directory,
      env: fixture.environment,
    });
    const future = new Date(Date.now() + 10_000);
    utimesSync(join(fixture.directory, 'package-lock.json'), future, future);

    execFileSync(fixture.launcher, ['status'], {
      cwd: fixture.directory,
      env: fixture.environment,
    });

    const installs = readFileSync(fixture.logFile, 'utf8')
      .trim()
      .split('\n')
      .filter((line) => line === 'npm ci --silent');
    expect(installs).toHaveLength(2);
  });
});
