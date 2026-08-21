import { describe, expect, it } from 'vitest';

import type { ExecFile } from '../src/lib/process.js';
import {
  AppleMailError,
  AppleMailNotifier,
} from '../src/notifications/apple-mail.js';

describe('AppleMailNotifier', () => {
  it('resolves the first address from an enabled Mail account', async () => {
    const execFile: ExecFile = async () => ({
      stderr: '',
      stdout: 'self@example.com\n',
    });

    await expect(
      new AppleMailNotifier(execFile).resolveSelfRecipient(),
    ).resolves.toBe('self@example.com');
  });

  it('passes recipient, subject, and literal plain text through argv instead of AppleScript source', async () => {
    const calls: Array<{ args: readonly string[]; file: string }> = [];
    const execFile: ExecFile = async (file, args) => {
      calls.push({ args, file });
      return { stderr: '', stdout: '' };
    };
    const recipient = 'self+"unsafe"@example.com';
    const subject = 'Costco <potential> & savings';
    const text =
      '<p>literal markup</p>\n" & do shell script "open https://bad.invalid"';

    await new AppleMailNotifier(execFile).send(recipient, subject, text);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.file).toBe('/usr/bin/osascript');
    expect(calls[0]?.args.slice(-4)).toEqual(['--', recipient, subject, text]);
    expect(calls[0]?.args[0]).toBe('-e');
    expect(calls[0]?.args[1]).not.toContain(recipient);
    expect(calls[0]?.args[1]).not.toContain(subject);
    expect(calls[0]?.args[1]).not.toContain(text);
  });

  it('rejects an empty self recipient and wraps Mail failures', async () => {
    const emptyRecipient: ExecFile = async () => ({
      stderr: '',
      stdout: '  \n',
    });
    const failingSend: ExecFile = async () => {
      throw new Error('Mail automation denied');
    };

    await expect(
      new AppleMailNotifier(emptyRecipient).resolveSelfRecipient(),
    ).rejects.toBeInstanceOf(AppleMailError);
    await expect(
      new AppleMailNotifier(failingSend).send(
        'self@example.com',
        'Subject',
        'Plain-text body',
      ),
    ).rejects.toBeInstanceOf(AppleMailError);
  });
});
