import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export function chromeBinaryPath(): string {
  const candidates = [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    join(
      homedir(),
      'Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    ),
  ];
  return candidates.find(existsSync) ?? candidates[0]!;
}
