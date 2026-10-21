import { spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

const installer = fileURLToPath(new URL('../install.sh', import.meta.url));
const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'costco-installer-'));
  directories.push(home);
  const bin = join(home, 'bin');
  mkdirSync(bin);
  const executable = (path: string, contents: string) =>
    writeFileSync(path, `#!/bin/sh\n${contents}\n`, { mode: 0o755 });
  executable(
    join(bin, 'uname'),
    'printf "%s\\n" "${COSTCO_TEST_PLATFORM:-Darwin}"',
  );
  executable(join(bin, 'xcode-select'), 'exit 0');
  executable(join(bin, 'node'), 'exit 0');
  executable(join(bin, 'npm'), 'exit 0');
  executable(
    join(bin, 'git'),
    `
printf 'git %s\\n' "$*" >> "$COSTCO_TEST_LOG"
for destination do :; done
mkdir -p "$destination"
cat > "$destination/costco" <<'LAUNCHER'
#!/bin/sh
printf 'costco %s\\n' "$*" >> "$COSTCO_TEST_LOG"
LAUNCHER
chmod +x "$destination/costco"
`,
  );
  const chromeDirectory = join(
    home,
    'Applications',
    'Google Chrome.app',
    'Contents',
    'MacOS',
  );
  mkdirSync(chromeDirectory, { recursive: true });
  executable(join(chromeDirectory, 'Google Chrome'), 'exit 0');
  const log = join(home, 'commands.log');
  const environment = {
    HOME: home,
    NVM_DIR: join(home, 'missing-nvm'),
    PATH: `${bin}:/usr/bin:/bin`,
    COSTCO_TEST_LOG: log,
  };
  return { home, log, environment };
}

describe('URL installer', () => {
  it('clones over HTTPS, runs noninteractive setup, and leaves login to the user', () => {
    const { home, log, environment } = fixture();
    const destination = join(home, 'checkout with spaces');
    const result = spawnSync('/bin/sh', [installer], {
      env: { ...environment, COSTCO_INSTALL_DIR: destination },
      encoding: 'utf8',
    });
    expect(result.status).toBe(0);
    expect(readFileSync(log, 'utf8').trim().split('\n')).toEqual([
      `git clone --depth 1 --branch main --single-branch -- https://github.com/sandeepgangarapu/costco-price-matcher.git ${destination}`,
      'costco setup --no-same-day',
    ]);
    expect(result.stdout).toContain('sign in to Costco yourself');
    expect(result.stdout).toContain('./costco run');
  });

  it('refuses to overwrite an existing checkout', () => {
    const { home, environment } = fixture();
    const destination = join(home, 'costco-price-matcher');
    mkdirSync(destination);
    writeFileSync(join(destination, 'keep.txt'), 'keep');
    const result = spawnSync('/bin/sh', [installer], {
      env: environment,
      encoding: 'utf8',
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('already exists');
    expect(readFileSync(join(destination, 'keep.txt'), 'utf8')).toBe('keep');
  });

  it('rejects unsupported systems before downloading anything', () => {
    const { environment } = fixture();
    const result = spawnSync('/bin/sh', [installer], {
      env: { ...environment, COSTCO_TEST_PLATFORM: 'Linux' },
      encoding: 'utf8',
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('requires macOS');
  });

  it('requires an absolute installation directory', () => {
    const { environment } = fixture();
    const result = spawnSync('/bin/sh', [installer], {
      env: { ...environment, COSTCO_INSTALL_DIR: 'relative' },
      encoding: 'utf8',
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('absolute path');
  });
});
