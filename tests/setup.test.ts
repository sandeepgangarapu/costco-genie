import { describe, expect, it } from 'vitest';

import { DEFAULT_CONFIG } from '../src/config/config.js';
import {
  collectSetupOptions,
  parseSetupOptions,
  SetupUsageError,
} from '../src/cli/setup.js';

describe('setup choices', () => {
  it('parses startup values without any built-in location', () => {
    expect(parseSetupOptions([])).toBeUndefined();
    expect(
      parseSetupOptions([
        '--zip',
        '10001',
        '--address',
        '123 Example St',
        '--email',
        'you@example.com',
      ]),
    ).toEqual({
      sameDayPostalCode: '10001',
      sameDayRepresentativeAddress: '123 Example St',
      emailRecipient: 'you@example.com',
    });
    expect(parseSetupOptions(['--no-same-day', '--email', '-'])).toEqual({
      sameDayPostalCode: null,
      sameDayRepresentativeAddress: null,
      emailRecipient: null,
    });
  });

  it.each([
    ['--zip'],
    ['--zip', '--email'],
    ['--zip', '1234'],
    ['--address', ' '],
    ['--email', 'invalid'],
    ['--password', 'anything'],
  ])('rejects invalid arguments %j', (...arguments_) => {
    expect(() => parseSetupOptions(arguments_)).toThrow(SetupUsageError);
  });

  it('lets a new user skip location and email with Enter', async () => {
    expect(
      await collectSetupOptions(DEFAULT_CONFIG, {
        question: async () => '',
        log: () => {},
      }),
    ).toEqual({
      sameDayPostalCode: null,
      sameDayRepresentativeAddress: null,
      emailRecipient: null,
    });
  });

  it('keeps existing choices when the user presses Enter', async () => {
    const config = {
      ...DEFAULT_CONFIG,
      sameDayPostalCode: '10001',
      sameDayRepresentativeAddress: '123 Example St',
      emailRecipient: 'you@example.com',
    };
    const result = await collectSetupOptions(config, {
      question: async () => '',
      log: () => {},
    });
    expect(result).toEqual({
      sameDayPostalCode: config.sameDayPostalCode,
      sameDayRepresentativeAddress: config.sameDayRepresentativeAddress,
      emailRecipient: config.emailRecipient,
    });
  });

  it('clears the address as well when location is disabled', async () => {
    const answers = ['-', '-'];
    const result = await collectSetupOptions(
      {
        ...DEFAULT_CONFIG,
        sameDayPostalCode: '10001',
        sameDayRepresentativeAddress: '123 Example St',
      },
      { question: async () => answers.shift()!, log: () => {} },
    );
    expect(result).toEqual({
      sameDayPostalCode: null,
      sameDayRepresentativeAddress: null,
      emailRecipient: null,
    });
  });

  it('requires an address when a ZIP is provided in the wizard', async () => {
    const answers = ['10001', ''];
    await expect(
      collectSetupOptions(DEFAULT_CONFIG, {
        question: async () => answers.shift()!,
        log: () => {},
      }),
    ).rejects.toThrow(/both a ZIP and an address/);
  });

  it('lets the user correct an invalid ZIP or email without restarting setup', async () => {
    const answers = [
      '123',
      '10001',
      '123 Example St',
      'invalid',
      'you@example.com',
    ];
    const messages: string[] = [];
    const options = await collectSetupOptions(DEFAULT_CONFIG, {
      question: async () => answers.shift()!,
      log: (message) => messages.push(message),
    });
    expect(options).toEqual({
      sameDayPostalCode: '10001',
      sameDayRepresentativeAddress: '123 Example St',
      emailRecipient: 'you@example.com',
    });
    expect(messages.join('\n')).toContain('exactly five digits');
    expect(messages.join('\n')).toContain('valid email address');
  });
});
