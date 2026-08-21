import { describe, expect, it, vi } from 'vitest';

import {
  createExecFile,
  execFile,
  ExecFileError,
  type NodeExecFile,
} from '../src/lib/process.js';

describe('execFile', () => {
  it('preserves the exit code and stderr of a failed child command', async () => {
    const failure = execFile('/bin/sh', [
      '-c',
      'printf "launchctl-shaped failure" >&2; exit 7',
    ]);

    await expect(failure).rejects.toBeInstanceOf(ExecFileError);
    await expect(failure).rejects.toMatchObject({
      code: 7,
      stderr: 'launchctl-shaped failure',
      stdout: '',
    });
  });

  it('bounds noninteractive commands at 30 seconds and reports an actionable timeout', async () => {
    vi.useFakeTimers();
    const runner: NodeExecFile = (_file, _args, options, callback) => {
      setTimeout(() => {
        callback(
          Object.assign(new Error('killed'), {
            code: null,
            killed: true,
            signal: 'SIGTERM',
          }),
          '',
          '',
        );
      }, options.timeout);
    };
    const boundedExecFile = createExecFile(runner);

    try {
      const result = boundedExecFile('/usr/bin/osascript', ['-e', 'return']);
      const rejection = expect(result).rejects.toMatchObject({
        message: expect.stringMatching(/timed out after 30000ms.*osascript/i),
        name: 'ExecFileError',
      });
      await vi.advanceTimersByTimeAsync(30_000);

      await rejection;
    } finally {
      vi.useRealTimers();
    }
  });
});
