import { z } from 'zod';

import {
  ensurePrivateDirectory,
  pathExistsWithoutFollowing,
  readPrivateTextFile,
} from '../lib/filesystem.js';
import type { AppPaths } from './paths.js';

const configSchema = z.object({
  daysToFetch: z.number().int().min(1).max(365),
  adjustmentWindowDays: z.number().int().min(1).max(365),
  scheduledHour: z.number().int().min(0).max(23),
  scheduledMinute: z.number().int().min(0).max(59),
  emailRecipient: z.string().email().nullable(),
  priceBatchSize: z.number().int().min(1).max(25),
  minimumSavingsCents: z.number().int().min(0),
});

export type AppConfig = Readonly<z.infer<typeof configSchema>>;

export const DEFAULT_CONFIG: AppConfig = Object.freeze({
  daysToFetch: 35,
  adjustmentWindowDays: 30,
  scheduledHour: 9,
  scheduledMinute: 0,
  emailRecipient: null,
  priceBatchSize: 25,
  minimumSavingsCents: 1,
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

  const partialConfig = configSchema
    .partial()
    .parse(readPartialConfig(paths.configFile));
  const config = configSchema.parse({ ...DEFAULT_CONFIG, ...partialConfig });

  return Object.freeze(config);
}
