import { join } from 'node:path';

export interface AppPaths {
  readonly dataDir: string;
  readonly configFile: string;
  readonly databaseFile: string;
  readonly browserProfileDir: string;
  readonly logDir: string;
  readonly reportsDir: string;
}

export function appPaths(homeDir: string): AppPaths {
  const dataDir = join(homeDir, '.costco-price-matcher');

  return Object.freeze({
    dataDir,
    configFile: join(dataDir, 'config.json'),
    databaseFile: join(dataDir, 'costco.sqlite'),
    browserProfileDir: join(dataDir, 'browser-profile'),
    logDir: join(dataDir, 'logs'),
    reportsDir: join(dataDir, 'reports'),
  });
}
