import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config/config.js';
import { appPaths } from '../src/config/paths.js';

const temporaryHomes: string[] = [];

function createTemporaryHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'costco-price-matcher-'));
  temporaryHomes.push(home);
  return home;
}

afterEach(() => {
  for (const home of temporaryHomes.splice(0)) {
    rmSync(home, { force: true, recursive: true });
  }
});

describe('loadConfig', () => {
  it('uses documented defaults and creates its application directories', () => {
    const paths = appPaths(createTemporaryHome());

    expect(loadConfig(paths)).toEqual({
      adjustmentWindowDays: 30,
      daysToFetch: 35,
      emailRecipient: null,
      minimumSavingsCents: 1,
      priceBatchSize: 25,
      sameDayMarkupPercent: 13.5,
      sameDayPostalCode: '98029',
      sameDayRepresentativeAddress: '2520 NE Park Dr, Issaquah, WA 98029',
      scheduledHour: 9,
      scheduledMinute: 0,
      scheduledIntervalDays: 1,
    });
    expect(existsSync(paths.dataDir)).toBe(true);
    expect(existsSync(paths.browserProfileDir)).toBe(true);
    expect(existsSync(paths.logDir)).toBe(true);
    expect(paths.reportsDir).toBe(join(paths.dataDir, 'reports'));
  });

  it('merges a partial JSON config with the defaults', () => {
    const paths = appPaths(createTemporaryHome());
    mkdirSync(paths.dataDir, { recursive: true });
    writeFileSync(
      paths.configFile,
      JSON.stringify({
        adjustmentWindowDays: 14,
        emailRecipient: 'me@example.com',
      }),
    );

    expect(loadConfig(paths)).toMatchObject({
      adjustmentWindowDays: 14,
      daysToFetch: 35,
      emailRecipient: 'me@example.com',
      priceBatchSize: 25,
      sameDayMarkupPercent: 13.5,
      sameDayPostalCode: '98029',
      sameDayRepresentativeAddress: '2520 NE Park Dr, Issaquah, WA 98029',
    });
  });

  it('creates and hardens private application directories and an existing config file', () => {
    const paths = appPaths(createTemporaryHome());
    mkdirSync(paths.browserProfileDir, { mode: 0o755, recursive: true });
    mkdirSync(paths.logDir, { mode: 0o755, recursive: true });
    chmodSync(paths.dataDir, 0o755);
    chmodSync(paths.browserProfileDir, 0o755);
    chmodSync(paths.logDir, 0o755);
    writeFileSync(paths.configFile, '{}', { mode: 0o644 });
    chmodSync(paths.configFile, 0o644);

    loadConfig(paths);

    expect(lstatSync(paths.dataDir).mode & 0o777).toBe(0o700);
    expect(lstatSync(paths.browserProfileDir).mode & 0o777).toBe(0o700);
    expect(lstatSync(paths.logDir).mode & 0o777).toBe(0o700);
    expect(lstatSync(paths.configFile).mode & 0o777).toBe(0o600);
  });

  it('rejects a symlink config without reading or changing its target', () => {
    const home = createTemporaryHome();
    const paths = appPaths(home);
    const target = join(home, 'outside-config.json');
    mkdirSync(paths.dataDir, { recursive: true });
    writeFileSync(target, '{"daysToFetch":14}', { mode: 0o644 });
    chmodSync(target, 0o644);
    symlinkSync(target, paths.configFile);

    expect(() => loadConfig(paths)).toThrow(/unsafe|symbolic link/i);
    expect(lstatSync(target).mode & 0o777).toBe(0o644);
  });

  it('rejects a wrong-type application directory', () => {
    const paths = appPaths(createTemporaryHome());
    mkdirSync(paths.dataDir, { recursive: true });
    writeFileSync(paths.browserProfileDir, 'not a directory');

    expect(() => loadConfig(paths)).toThrow(/directory|unsafe/i);
  });

  it('rejects a symlink application root without creating data through it', () => {
    const home = createTemporaryHome();
    const paths = appPaths(home);
    const target = join(home, 'outside-directory');
    mkdirSync(target);
    symlinkSync(target, paths.dataDir);

    expect(() => loadConfig(paths)).toThrow(/unsafe|symbolic link/i);
    expect(existsSync(join(target, 'browser-profile'))).toBe(false);
    expect(existsSync(join(target, 'logs'))).toBe(false);
  });

  it.each([
    { daysToFetch: 0 },
    { daysToFetch: 366 },
    { adjustmentWindowDays: 0 },
    { scheduledHour: 24 },
    { scheduledMinute: 60 },
    { scheduledIntervalDays: 0 },
    { priceBatchSize: 26 },
    { minimumSavingsCents: -1 },
    { sameDayMarkupPercent: 0 },
    { sameDayMarkupPercent: 100 },
    { sameDayPostalCode: '9802' },
    { sameDayPostalCode: '9802A' },
    { sameDayRepresentativeAddress: '' },
  ])('rejects invalid configuration ranges: %j', (invalidConfig) => {
    const paths = appPaths(createTemporaryHome());
    mkdirSync(paths.dataDir, { recursive: true });
    writeFileSync(paths.configFile, JSON.stringify(invalidConfig));

    expect(() => loadConfig(paths)).toThrow(
      expect.objectContaining({ name: 'ZodError' }),
    );
  });
});
