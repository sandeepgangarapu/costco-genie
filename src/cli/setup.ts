import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';

import { parseConfig, type AppConfig } from '../config/config.js';

export interface SetupOptions {
  watchWarehouseNumber?: AppConfig['watchWarehouseNumber'];
  sameDayPostalCode?: AppConfig['sameDayPostalCode'];
  sameDayRepresentativeAddress?: AppConfig['sameDayRepresentativeAddress'];
  emailRecipient?: AppConfig['emailRecipient'];
}

export class SetupUsageError extends Error {}

export function parseSetupOptions(
  arguments_: readonly string[],
): SetupOptions | undefined {
  if (arguments_.length === 0) return undefined;
  const options: SetupOptions = {};
  for (let index = 0; index < arguments_.length; index += 1) {
    const flag = arguments_[index];
    if (flag === '--no-same-day') {
      options.sameDayPostalCode = null;
      options.sameDayRepresentativeAddress = null;
      continue;
    }
    if (
      flag !== '--zip' &&
      flag !== '--address' &&
      flag !== '--email' &&
      flag !== '--watch-warehouse'
    ) {
      throw new SetupUsageError(
        `Unknown setup option: ${flag}. Run ./costco help for examples.`,
      );
    }
    const value = arguments_[index + 1];
    if (value === undefined || value.startsWith('--') || value.trim() === '') {
      throw new SetupUsageError(`${flag} needs a value.`);
    }
    index += 1;
    switch (flag) {
      case '--watch-warehouse':
        options.watchWarehouseNumber = value === '-' ? null : value.trim();
        break;
      case '--zip':
        options.sameDayPostalCode = value.trim();
        break;
      case '--address':
        options.sameDayRepresentativeAddress = value.trim();
        break;
      case '--email':
        options.emailRecipient = value === '-' ? null : value.trim();
        break;
    }
  }
  validateSetupOptions(options);
  return options;
}

function validateSetupOptions(options: SetupOptions): void {
  try {
    parseConfig(options);
  } catch {
    throw new SetupUsageError(
      'Use a physical watch warehouse number, a five-digit ZIP, a nonempty address, and a valid email address (or --email - to use your mail provider’s default).',
    );
  }
}

export interface SetupPrompt {
  readonly question: (message: string) => Promise<string>;
  readonly log: (message: string) => void;
}

export async function collectSetupOptions(
  config: AppConfig,
  prompt: SetupPrompt,
): Promise<SetupOptions> {
  prompt.log(
    'Your settings stay in ~/.costco-price-matcher/config.json, outside the repository.',
  );
  prompt.log(
    'Press Enter to keep each value. Enter - to clear it. Same-Day estimates are optional.',
  );
  const ask = async (
    label: string,
    current: string | null,
    key: keyof SetupOptions,
  ): Promise<string | null> => {
    while (true) {
      const value = (
        await prompt.question(`${label} [${current ?? 'not set'}]: `)
      ).trim();
      const next = value === '' ? current : value === '-' ? null : value;
      try {
        parseConfig({ [key]: next });
        return next;
      } catch {
        prompt.log(
          key === 'sameDayPostalCode'
            ? 'Please enter exactly five digits, or - to skip Same-Day estimates.'
            : 'Please enter a valid email address, or - to use your mail provider’s default.',
        );
      }
    }
  };
  const sameDayPostalCode = await ask(
    'Same-Day ZIP (leave blank to skip)',
    config.sameDayPostalCode,
    'sameDayPostalCode',
  );
  const sameDayRepresentativeAddress =
    sameDayPostalCode === null
      ? null
      : await ask(
          'Nearby address in that ZIP for Same-Day lookup',
          config.sameDayRepresentativeAddress,
          'sameDayRepresentativeAddress',
        );
  if (sameDayPostalCode !== null && sameDayRepresentativeAddress === null) {
    throw new SetupUsageError(
      'Same-Day estimates need both a ZIP and an address. Rerun ./costco setup, or use ./costco setup --no-same-day to skip estimates.',
    );
  }
  const emailRecipient = await ask(
    'Alert email (leave unset to use your mail provider’s default)',
    config.emailRecipient,
    'emailRecipient',
  );
  const options = {
    sameDayPostalCode,
    sameDayRepresentativeAddress,
    emailRecipient,
  };
  validateSetupOptions(options);
  return options;
}

export async function promptForSetup(config: AppConfig): Promise<SetupOptions> {
  if (!stdin.isTTY || !stdout.isTTY) return {};
  const readline = createInterface({ input: stdin, output: stdout });
  try {
    return await collectSetupOptions(config, {
      question: (message) => readline.question(message),
      log: console.log,
    });
  } finally {
    readline.close();
  }
}
