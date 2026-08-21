import { describe, expect, it } from 'vitest';

import {
  MacOsNotificationError,
  MacOsNotifier,
} from '../src/notifications/macos.js';
import type { ExecFile } from '../src/lib/process.js';

describe('MacOsNotifier', () => {
  it('passes notification content through osascript argv instead of AppleScript source', async () => {
    const calls: Array<{ args: readonly string[]; file: string }> = [];
    const execFile: ExecFile = async (file, args) => {
      calls.push({ args, file });
      return { stderr: '', stdout: '' };
    };
    const title = 'Potential "deal"';
    const body =
      'Untrusted text: \\" & do shell script "open https://bad.invalid"';

    await new MacOsNotifier(execFile).send(title, body);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.file).toBe('/usr/bin/osascript');
    expect(calls[0]?.args.slice(-3)).toEqual(['--', title, body]);
    expect(calls[0]?.args[0]).toBe('-e');
    expect(calls[0]?.args[1]).not.toContain(title);
    expect(calls[0]?.args[1]).not.toContain(body);
  });

  it('reports Notification Center failures as a channel-specific error', async () => {
    const execFile: ExecFile = async () => {
      throw new Error('automation denied');
    };

    await expect(
      new MacOsNotifier(execFile).send('Title', 'Body'),
    ).rejects.toBeInstanceOf(MacOsNotificationError);
  });
});
