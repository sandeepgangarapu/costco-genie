import { readFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { z } from 'zod';

import {
  ensurePrivateDirectory,
  inspectRegularFileWithoutMutation,
  pathExistsWithoutFollowing,
  readPrivateTextFile,
} from '../lib/filesystem.js';
import type { AppPaths } from './paths.js';

const configSchema = z.object({
  daysToFetch: z.number().int().min(1).max(365),
  adjustmentWindowDays: z.number().int().min(1).max(365),
  scheduledHour: z.number().int().min(0).max(23),
  scheduledMinute: z.number().int().min(0).max(59),
  scheduledWeekday: z.number().int().min(0).max(6).nullable(),
  scheduledIntervalDays: z.number().int().min(1).max(365),
  emailRecipient: z.string().email().nullable(),
  emailEveryRun: z.boolean(),
  smtpConfigPath: z.string().refine(isAbsolute).nullable(),
  priceBatchSize: z.number().int().min(1).max(25),
  minimumSavingsCents: z.number().int().min(0),
  sameDayMarkupPercent: z.number().positive().lt(100),
  sameDayPostalCode: z.string().regex(/^\d{5}$/u),
  sameDayRepresentativeAddress: z.string().trim().min(1),
});

export type AppConfig = Readonly<z.infer<typeof configSchema>>;

export const DEFAULT_CONFIG: AppConfig = Object.freeze({
  daysToFetch: 35,
  adjustmentWindowDays: 30,
  scheduledHour: 9,
  scheduledMinute: 0,
  scheduledWeekday: null,
  scheduledIntervalDays: 1,
  emailRecipient: null,
  emailEveryRun: false,
  smtpConfigPath: null,
  priceBatchSize: 25,
  minimumSavingsCents: 1,
  sameDayMarkupPercent: 13.5,
  sameDayPostalCode: '98029',
  sameDayRepresentativeAddress: '2520 NE Park Dr, Issaquah, WA 98029',
});

function ensureDirectories(paths: AppPaths): void {
  ensurePrivateDirectory(paths.dataDir);
  ensurePrivateDirectory(paths.browserProfileDir);
  ensurePrivateDirectory(paths.logDir);
}

function readPartialConfig(configFile: string): unknown {
  if (!pathExistsWithoutFollowing(configFile)) {
    return {};
  }

  return JSON.parse(readPrivateTextFile(configFile));
}

export function loadConfig(paths: AppPaths): AppConfig {
  ensureDirectories(paths);

  return parseConfig(readPartialConfig(paths.configFile));
}

export function readConfigWithoutMutation(paths: AppPaths): AppConfig {
  if (!pathExistsWithoutFollowing(paths.configFile)) {
    return DEFAULT_CONFIG;
  }
  inspectRegularFileWithoutMutation(paths.configFile);
  return parseConfig(JSON.parse(readFileSync(paths.configFile, 'utf8')));
}

function parseConfig(value: unknown): AppConfig {
  const partialConfig = configSchema.partial().parse(value);
  const config = configSchema.parse({ ...DEFAULT_CONFIG, ...partialConfig });

  return Object.freeze(config);
}
