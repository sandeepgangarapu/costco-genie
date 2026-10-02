import { execFile as nodeExecFile } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { afterEach, describe, expect, it } from 'vitest';

import type { ExecFile } from '../src/lib/process.js';
import {
  IncompleteLaunchAgentRollbackError,
  installLaunchAgent,
  renderLaunchAgent,
  type LaunchAgentTransactionOperations,
  uninstallLaunchAgent,
} from '../src/scheduler/launchd.js';

const execFile = promisify(nodeExecFile);
const temporaryDirectories: string[] = [];

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'costco-launchd-test-'));
  temporaryDirectories.push(directory);
  return directory;
}

const renderOptions = {
  cliPath: '/Applications/Costco & Tools/dist/cli.js',
  label: 'com.example.costco<matcher>',
  logDirectory: '/Users/example/Library/Logs/Costco & Matcher',
  nodePath: '/opt/homebrew/bin/node',
  scheduledHour: 9,
  scheduledMinute: 0,
  workingDirectory: '/Applications/Costco & Tools',
};

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe('renderLaunchAgent', () => {
  it('renders a valid daily user agent with escaped absolute paths and logs', async () => {
    const plist = renderLaunchAgent(renderOptions);
    const directory = temporaryDirectory();
    const plistPath = join(directory, 'agent.plist');
    writeFileSync(plistPath, plist);

    await expect(
      execFile('/usr/bin/plutil', ['-lint', plistPath]),
    ).resolves.toMatchObject({ stdout: expect.stringContaining('OK') });
    expect(plist).toContain(
      '<string>com.example.costco&lt;matcher&gt;</string>',
    );
    expect(plist).toContain(
      '<string>/Applications/Costco &amp; Tools/dist/cli.js</string>',
    );
    expect(plist).toContain('<key>RunAtLoad</key>\n  <true/>');
    expect(plist).toContain('<key>Hour</key>\n    <integer>9</integer>');
    expect(plist).toContain('<key>Minute</key>\n    <integer>0</integer>');
    expect(plist).toContain(
      '<string>/Users/example/Library/Logs/Costco &amp; Matcher/stdout.log</string>',
    );
    expect(plist).toContain(
      '<string>/Users/example/Library/Logs/Costco &amp; Matcher/stderr.log</string>',
    );
    expect(plist).toContain('<string>run</string>');
    expect(plist).toContain('<string>--scheduled</string>');
  });

  it('renders a Friday-only agent without a login run', async () => {
    const plist = renderLaunchAgent({
      ...renderOptions,
      scheduledHour: 16,
      scheduledWeekday: 5,
    });
    const plistPath = join(temporaryDirectory(), 'friday.plist');
    writeFileSync(plistPath, plist);

    await expect(
      execFile('/usr/bin/plutil', ['-lint', plistPath]),
    ).resolves.toMatchObject({ stdout: expect.stringContaining('OK') });
    expect(plist).toContain('<key>RunAtLoad</key>\n  <false/>');
    expect(plist).toContain('<key>Weekday</key>\n    <integer>5</integer>');
    expect(plist).toContain('<key>Hour</key>\n    <integer>16</integer>');
    expect(plist).toContain('<string>--scheduled</string>');
  });

  it.each([
    ['nodePath', 'node'],
    ['cliPath', 'dist/cli.js'],
    ['workingDirectory', '.'],
    ['logDirectory', 'logs'],
  ] as const)('rejects a non-absolute %s', (field, value) => {
    expect(() =>
      renderLaunchAgent({ ...renderOptions, [field]: value }),
    ).toThrow(`${field} must be an absolute path`);
  });
});

describe('LaunchAgent installation', () => {
  function installFixture(existingPlist?: string) {
    const directory = temporaryDirectory();
    const plistPath = join(directory, 'LaunchAgents', 'costco.plist');
    const nodePath = join(directory, 'node');
    const cliPath = join(directory, 'dist', 'cli.js');
    mkdirSync(join(directory, 'dist'), { recursive: true });
    mkdirSync(join(directory, 'LaunchAgents'), { recursive: true });
    writeFileSync(nodePath, '#!/bin/sh\n');
    chmodSync(nodePath, 0o755);
    writeFileSync(cliPath, '#!/usr/bin/env node\n');
    const configured = {
      ...renderOptions,
      cliPath,
      label: 'com.example.costco.matcher',
      logDirectory: join(directory, 'logs'),
      nodePath,
      workingDirectory: directory,
    };
    if (existingPlist !== undefined) {
      writeFileSync(plistPath, existingPlist);
    }
    return { configured, directory, plistPath };
  }

  function commandError(stderr: string, code = 3): Error {
    return Object.assign(new Error(stderr), { code, stderr, stdout: '' });
  }

  function leftoverTransactionFiles(directory: string): string[] {
    const launchAgents = join(directory, 'LaunchAgents');
    return existsSync(launchAgents)
      ? readdirSync(launchAgents).filter((name) =>
          /\.candidate-|\.backup-/.test(name),
        )
      : [];
  }

  function transactionOperations(
    overrides: Partial<LaunchAgentTransactionOperations> = {},
  ): LaunchAgentTransactionOperations {
    return {
      backup: (source, destination) => copyFileSync(source, destination),
      remove: (path) => rmSync(path, { force: true }),
      replace: (source, destination) => renameSync(source, destination),
      restore: (source, destination) => renameSync(source, destination),
      ...overrides,
    };
  }

  it('atomically replaces a loaded prior agent after lint and restores no transaction files', async () => {
    const { configured, directory, plistPath } = installFixture('old plist');
    const commands: Array<{ args: readonly string[]; file: string }> = [];
    const fakeExecFile: ExecFile = async (file, args) => {
      commands.push({ args, file });
      return {
        stderr: '',
        stdout: file === configured.nodePath ? 'v22.13.0\n' : '',
      };
    };

    await installLaunchAgent({
      execFile: fakeExecFile,
      plistPath,
      renderOptions: configured,
      uid: 501,
    });

    expect(commands.map(({ file, args }) => [file, ...args])).toEqual([
      [configured.nodePath, '--version'],
      ['/usr/bin/plutil', '-lint', expect.stringContaining('.candidate-')],
      ['/bin/launchctl', 'print', 'gui/501/com.example.costco.matcher'],
      ['/usr/bin/plutil', '-lint', plistPath],
      ['/bin/launchctl', 'bootout', 'gui/501/com.example.costco.matcher'],
      ['/bin/launchctl', 'bootstrap', 'gui/501', plistPath],
    ]);
    expect(readFileSync(plistPath, 'utf8')).toBe(renderLaunchAgent(configured));
    expect(leftoverTransactionFiles(directory)).toEqual([]);
  });

  it('refuses to boot out a loaded service whose old plist is missing', async () => {
    const { configured, directory, plistPath } = installFixture();
    const commands: string[] = [];
    const fakeExecFile: ExecFile = async (file, args) => {
      commands.push(`${file} ${args.join(' ')}`);
      return {
        stderr: '',
        stdout: file === configured.nodePath ? 'v22.13.0' : 'loaded',
      };
    };

    await expect(
      installLaunchAgent({
        execFile: fakeExecFile,
        plistPath,
        renderOptions: configured,
        uid: 501,
      }),
    ).rejects.toThrow(/loaded.*plist.*missing|missing.*loaded.*plist/i);
    expect(commands.some((command) => command.includes(' bootout '))).toBe(
      false,
    );
    expect(commands.some((command) => command.includes(' bootstrap '))).toBe(
      false,
    );
    expect(existsSync(plistPath)).toBe(false);
    expect(leftoverTransactionFiles(directory)).toEqual([]);
  });

  it('refuses to boot out a loaded service whose old plist fails lint', async () => {
    const { configured, directory, plistPath } = installFixture('corrupt');
    const commands: string[] = [];
    const oldLintFailure = commandError('old plist is corrupt', 1);
    const fakeExecFile: ExecFile = async (file, args) => {
      commands.push(`${file} ${args.join(' ')}`);
      if (file === configured.nodePath)
        return { stderr: '', stdout: 'v22.13.0' };
      if (file === '/usr/bin/plutil' && args[1] === plistPath) {
        throw oldLintFailure;
      }
      return { stderr: '', stdout: 'loaded' };
    };

    await expect(
      installLaunchAgent({
        execFile: fakeExecFile,
        plistPath,
        renderOptions: configured,
        uid: 501,
      }),
    ).rejects.toBe(oldLintFailure);
    expect(commands.some((command) => command.includes(' bootout '))).toBe(
      false,
    );
    expect(commands.some((command) => command.includes(' bootstrap '))).toBe(
      false,
    );
    expect(readFileSync(plistPath, 'utf8')).toBe('corrupt');
    expect(leftoverTransactionFiles(directory)).toEqual([]);
  });

  it('creates and verifies the backup before booting out the loaded old service', async () => {
    const { configured, directory, plistPath } = installFixture('old plist');
    const events: string[] = [];
    const operations = transactionOperations({
      backup: (source, destination) => {
        copyFileSync(source, destination);
        expect(readFileSync(destination, 'utf8')).toBe('old plist');
        events.push('backup');
      },
    });
    const fakeExecFile: ExecFile = async (file, args) => {
      if (file === configured.nodePath)
        return { stderr: '', stdout: 'v22.13.0' };
      if (args[0] === 'bootout') events.push('bootout');
      return { stderr: '', stdout: 'loaded' };
    };

    await installLaunchAgent({
      execFile: fakeExecFile,
      operations,
      plistPath,
      renderOptions: configured,
      uid: 501,
    });

    expect(events).toEqual(['backup', 'bootout']);
    expect(leftoverTransactionFiles(directory)).toEqual([]);
  });

  it('does not boot out or replace the loaded old service when backup creation fails', async () => {
    const { configured, directory, plistPath } = installFixture('old plist');
    const commands: string[] = [];
    const backupFailure = new Error('backup failed');
    const fakeExecFile: ExecFile = async (file, args) => {
      commands.push(`${file} ${args.join(' ')}`);
      return {
        stderr: '',
        stdout: file === configured.nodePath ? 'v22.13.0' : 'loaded',
      };
    };

    await expect(
      installLaunchAgent({
        execFile: fakeExecFile,
        operations: transactionOperations({
          backup: () => {
            throw backupFailure;
          },
        }),
        plistPath,
        renderOptions: configured,
        uid: 501,
      }),
    ).rejects.toBe(backupFailure);
    expect(commands.some((command) => command.includes(' bootout '))).toBe(
      false,
    );
    expect(readFileSync(plistPath, 'utf8')).toBe('old plist');
    expect(leftoverTransactionFiles(directory)).toEqual([]);
  });

  it('replaces an existing unloaded plist without issuing bootout', async () => {
    const { configured, plistPath } = installFixture('old plist');
    const commands: string[] = [];
    const fakeExecFile: ExecFile = async (file, args) => {
      commands.push(`${file} ${args.join(' ')}`);
      if (file === configured.nodePath)
        return { stderr: '', stdout: 'v22.13.0' };
      if (args[0] === 'print') throw commandError('Could not find service');
      return { stderr: '', stdout: '' };
    };

    await installLaunchAgent({
      execFile: fakeExecFile,
      plistPath,
      renderOptions: configured,
      uid: 501,
    });

    expect(commands.some((command) => command.includes(' bootout '))).toBe(
      false,
    );
    expect(commands.at(-1)).toBe(
      `/bin/launchctl bootstrap gui/501 ${plistPath}`,
    );
    expect(readFileSync(plistPath, 'utf8')).toBe(renderLaunchAgent(configured));
  });

  it('leaves the installed plist and loaded agent untouched when lint fails', async () => {
    const { configured, directory, plistPath } = installFixture('old plist');
    const commands: string[] = [];
    const lintFailure = commandError('Invalid plist', 1);
    const fakeExecFile: ExecFile = async (file, args) => {
      commands.push(`${file} ${args.join(' ')}`);
      if (file === configured.nodePath)
        return { stderr: '', stdout: 'v22.13.0' };
      if (file === '/usr/bin/plutil') throw lintFailure;
      return { stderr: '', stdout: '' };
    };

    await expect(
      installLaunchAgent({
        execFile: fakeExecFile,
        plistPath,
        renderOptions: configured,
        uid: 501,
      }),
    ).rejects.toBe(lintFailure);
    expect(readFileSync(plistPath, 'utf8')).toBe('old plist');
    expect(commands.some((command) => command.includes('launchctl'))).toBe(
      false,
    );
    expect(leftoverTransactionFiles(directory)).toEqual([]);
  });

  it('preserves a loaded old agent and plist when bootout fails', async () => {
    const { configured, directory, plistPath } = installFixture('old plist');
    let printCalls = 0;
    const denied = commandError('Operation not permitted', 1);
    const fakeExecFile: ExecFile = async (file, args) => {
      if (file === configured.nodePath)
        return { stderr: '', stdout: 'v22.13.0' };
      if (args[0] === 'print') {
        printCalls += 1;
        return { stderr: '', stdout: 'loaded' };
      }
      if (args[0] === 'bootout') throw denied;
      return { stderr: '', stdout: '' };
    };

    await expect(
      installLaunchAgent({
        execFile: fakeExecFile,
        plistPath,
        renderOptions: configured,
        uid: 501,
      }),
    ).rejects.toBe(denied);
    expect(readFileSync(plistPath, 'utf8')).toBe('old plist');
    expect(printCalls).toBeGreaterThanOrEqual(1);
    expect(leftoverTransactionFiles(directory)).toEqual([]);
  });

  it('re-bootstrap the prevalidated old service when atomic replacement fails after bootout', async () => {
    const { configured, directory, plistPath } = installFixture('old plist');
    const commands: string[] = [];
    const replacementFailure = new Error('atomic replacement failed');
    const fakeExecFile: ExecFile = async (file, args) => {
      commands.push(`${file} ${args.join(' ')}`);
      return {
        stderr: '',
        stdout: file === configured.nodePath ? 'v22.13.0' : 'loaded',
      };
    };

    await expect(
      installLaunchAgent({
        execFile: fakeExecFile,
        operations: transactionOperations({
          replace: () => {
            throw replacementFailure;
          },
        }),
        plistPath,
        renderOptions: configured,
        uid: 501,
      }),
    ).rejects.toBe(replacementFailure);
    expect(readFileSync(plistPath, 'utf8')).toBe('old plist');
    expect(
      commands.filter((command) => command.includes(' bootstrap ')),
    ).toEqual([`/bin/launchctl bootstrap gui/501 ${plistPath}`]);
    expect(leftoverTransactionFiles(directory)).toEqual([]);
  });

  it('restores and re-bootstraps a loaded old agent when replacement bootstrap fails', async () => {
    const { configured, directory, plistPath } = installFixture('old plist');
    const commands: string[] = [];
    const bootstrapFailure = commandError('bootstrap failed', 5);
    let bootstrapCalls = 0;
    const fakeExecFile: ExecFile = async (file, args) => {
      commands.push(`${file} ${args.join(' ')}`);
      if (file === configured.nodePath)
        return { stderr: '', stdout: 'v22.13.0' };
      if (args[0] === 'bootstrap') {
        bootstrapCalls += 1;
        if (bootstrapCalls === 1) throw bootstrapFailure;
      }
      if (args[0] === 'bootout' && bootstrapCalls === 1) {
        throw commandError('Could not find service');
      }
      return { stderr: '', stdout: '' };
    };

    await expect(
      installLaunchAgent({
        execFile: fakeExecFile,
        plistPath,
        renderOptions: configured,
        uid: 501,
      }),
    ).rejects.toBe(bootstrapFailure);
    expect(readFileSync(plistPath, 'utf8')).toBe('old plist');
    expect(bootstrapCalls).toBe(2);
    expect(commands.at(-1)).toBe(
      `/bin/launchctl bootstrap gui/501 ${plistPath}`,
    );
    expect(leftoverTransactionFiles(directory)).toEqual([]);
  });

  it('preserves recovery state and stops rollback when replacement bootout fails for a previously loaded agent', async () => {
    const { configured, directory, plistPath } = installFixture('old plist');
    const newBootstrapFailure = commandError('new bootstrap failed', 5);
    const replacementBootoutFailure = commandError(
      'replacement bootout denied',
      1,
    );
    let bootoutCalls = 0;
    let bootstrapCalls = 0;
    const fakeExecFile: ExecFile = async (file, args) => {
      if (file === configured.nodePath)
        return { stderr: '', stdout: 'v22.13.0' };
      if (args[0] === 'bootout') {
        bootoutCalls += 1;
        if (bootoutCalls === 2) throw replacementBootoutFailure;
      }
      if (args[0] === 'bootstrap') {
        bootstrapCalls += 1;
        throw newBootstrapFailure;
      }
      return { stderr: '', stdout: 'loaded' };
    };

    let thrown: unknown;
    try {
      await installLaunchAgent({
        execFile: fakeExecFile,
        plistPath,
        renderOptions: configured,
        uid: 501,
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(IncompleteLaunchAgentRollbackError);
    const rollback = thrown as IncompleteLaunchAgentRollbackError;
    expect(readFileSync(rollback.recoveryPath, 'utf8')).toBe('old plist');
    expect(rollback.message).toMatch(/manual recovery|recovery copy/i);
    expect(rollback.phases).toMatchObject({
      oldBootedOut: true,
      oldLoaded: true,
      replacementApplied: true,
      replacementBootedOut: false,
      restorationSucceeded: false,
    });
    expect(readFileSync(plistPath, 'utf8')).toBe(renderLaunchAgent(configured));
    expect(bootoutCalls).toBe(2);
    expect(bootstrapCalls).toBe(1);
    expect(leftoverTransactionFiles(directory)).toEqual([
      rollback.recoveryPath.split('/').at(-1),
    ]);
  });

  it('preserves recovery state and stops rollback when replacement bootout fails for a previously unloaded agent', async () => {
    const { configured, directory, plistPath } = installFixture('old plist');
    const replacementBootoutFailure = commandError(
      'replacement bootout denied',
      1,
    );
    let bootstrapCalls = 0;
    const fakeExecFile: ExecFile = async (file, args) => {
      if (file === configured.nodePath)
        return { stderr: '', stdout: 'v22.13.0' };
      if (args[0] === 'print') throw commandError('Could not find service');
      if (args[0] === 'bootstrap') {
        bootstrapCalls += 1;
        throw commandError('new bootstrap failed', 5);
      }
      if (args[0] === 'bootout') throw replacementBootoutFailure;
      return { stderr: '', stdout: '' };
    };

    let thrown: unknown;
    try {
      await installLaunchAgent({
        execFile: fakeExecFile,
        plistPath,
        renderOptions: configured,
        uid: 501,
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(IncompleteLaunchAgentRollbackError);
    const rollback = thrown as IncompleteLaunchAgentRollbackError;
    expect(readFileSync(rollback.recoveryPath, 'utf8')).toBe('old plist');
    expect(rollback.phases).toMatchObject({
      oldBootedOut: false,
      oldLoaded: false,
      replacementApplied: true,
      replacementBootedOut: false,
      restorationSucceeded: false,
    });
    expect(readFileSync(plistPath, 'utf8')).toBe(renderLaunchAgent(configured));
    expect(bootstrapCalls).toBe(1);
    expect(leftoverTransactionFiles(directory)).toEqual([
      rollback.recoveryPath.split('/').at(-1),
    ]);
  });

  it('reports an in-place recovery artifact when first-install rollback copying also fails', async () => {
    const { configured, plistPath } = installFixture();
    const fakeExecFile: ExecFile = async (file, args) => {
      if (file === configured.nodePath)
        return { stderr: '', stdout: 'v22.13.0' };
      if (args[0] === 'print') throw commandError('Could not find service');
      if (args[0] === 'bootstrap') throw commandError('bootstrap failed', 5);
      if (args[0] === 'bootout') throw commandError('bootout denied', 1);
      return { stderr: '', stdout: '' };
    };

    let thrown: unknown;
    try {
      await installLaunchAgent({
        execFile: fakeExecFile,
        operations: transactionOperations({
          backup: () => {
            throw new Error('recovery copy failed');
          },
        }),
        plistPath,
        renderOptions: configured,
        uid: 501,
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(IncompleteLaunchAgentRollbackError);
    const rollback = thrown as IncompleteLaunchAgentRollbackError;
    expect(rollback.recoveryPath).toBe(plistPath);
    expect(rollback.message).toMatch(/in-place recovery artifact/i);
    expect(rollback.message).not.toMatch(/recovery copy is preserved/i);
    expect(readFileSync(plistPath, 'utf8')).toBe(renderLaunchAgent(configured));
  });

  it('preserves the backup and does not bootstrap from live when atomic restore fails', async () => {
    const { configured, directory, plistPath } = installFixture('old plist');
    const commands: string[] = [];
    const restoreFailure = new Error('restore rename failed');
    let bootstrapCalls = 0;
    const fakeExecFile: ExecFile = async (file, args) => {
      commands.push(`${file} ${args.join(' ')}`);
      if (file === configured.nodePath)
        return { stderr: '', stdout: 'v22.13.0' };
      if (args[0] === 'bootstrap') {
        bootstrapCalls += 1;
        throw commandError('new bootstrap failed', 5);
      }
      if (args[0] === 'bootout' && bootstrapCalls === 1) {
        throw commandError('Could not find service');
      }
      return { stderr: '', stdout: 'loaded' };
    };

    let thrown: unknown;
    try {
      await installLaunchAgent({
        execFile: fakeExecFile,
        operations: transactionOperations({
          restore: () => {
            throw restoreFailure;
          },
        }),
        plistPath,
        renderOptions: configured,
        uid: 501,
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(IncompleteLaunchAgentRollbackError);
    const rollbackError = thrown as IncompleteLaunchAgentRollbackError;
    expect(rollbackError.recoveryPath).toMatch(/\.backup-/);
    expect(rollbackError.message).toContain(rollbackError.recoveryPath);
    expect(rollbackError.phases).toEqual({
      backupCreated: true,
      oldBootedOut: true,
      oldExists: true,
      oldLoaded: true,
      replacementApplied: true,
      replacementBootedOut: true,
      restorationSucceeded: false,
    });
    expect(readFileSync(rollbackError.recoveryPath, 'utf8')).toBe('old plist');
    expect(bootstrapCalls).toBe(1);
    expect(
      commands.filter((command) => command.includes(' bootstrap ')),
    ).toHaveLength(1);
    expect(readFileSync(plistPath, 'utf8')).toBe(renderLaunchAgent(configured));
    expect(leftoverTransactionFiles(directory)).toEqual([
      rollbackError.recoveryPath.split('/').at(-1),
    ]);
  });

  it('restores an unloaded old plist without loading it after bootstrap failure', async () => {
    const { configured, directory, plistPath } = installFixture('old plist');
    let bootstrapCalls = 0;
    const fakeExecFile: ExecFile = async (file, args) => {
      if (file === configured.nodePath)
        return { stderr: '', stdout: 'v22.13.0' };
      if (args[0] === 'print') throw commandError('Could not find service');
      if (args[0] === 'bootstrap') {
        bootstrapCalls += 1;
        throw commandError('bootstrap failed', 5);
      }
      if (args[0] === 'bootout') throw commandError('Could not find service');
      return { stderr: '', stdout: '' };
    };

    await expect(
      installLaunchAgent({
        execFile: fakeExecFile,
        plistPath,
        renderOptions: configured,
        uid: 501,
      }),
    ).rejects.toThrow('bootstrap failed');
    expect(readFileSync(plistPath, 'utf8')).toBe('old plist');
    expect(bootstrapCalls).toBe(1);
    expect(leftoverTransactionFiles(directory)).toEqual([]);
  });

  it('removes a failed replacement without bootstrapping old state when none existed', async () => {
    const { configured, directory, plistPath } = installFixture();
    let bootstrapCalls = 0;
    const fakeExecFile: ExecFile = async (file, args) => {
      if (file === configured.nodePath)
        return { stderr: '', stdout: 'v22.13.0' };
      if (args[0] === 'print' || args[0] === 'bootout') {
        throw commandError('Could not find service');
      }
      if (args[0] === 'bootstrap') {
        bootstrapCalls += 1;
        throw commandError('new bootstrap failed', 5);
      }
      return { stderr: '', stdout: '' };
    };

    await expect(
      installLaunchAgent({
        execFile: fakeExecFile,
        plistPath,
        renderOptions: configured,
        uid: 501,
      }),
    ).rejects.toThrow('new bootstrap failed');
    expect(bootstrapCalls).toBe(1);
    expect(existsSync(plistPath)).toBe(false);
    expect(leftoverTransactionFiles(directory)).toEqual([]);
  });

  it.each([
    ['v22.12.9', /Node 22\.13\.0 or newer/],
    ['not-a-version', /could not determine Node version/i],
  ])('rejects unsupported scheduler runtime %s', async (version, message) => {
    const { configured, plistPath } = installFixture();
    const fakeExecFile: ExecFile = async (file) => ({
      stderr: '',
      stdout: file === configured.nodePath ? version : '',
    });

    await expect(
      installLaunchAgent({
        execFile: fakeExecFile,
        plistPath,
        renderOptions: configured,
        uid: 501,
      }),
    ).rejects.toThrow(message);
    expect(existsSync(plistPath)).toBe(false);
  });

  it('rejects missing Node and CLI targets before writing a plist', async () => {
    const { configured, plistPath } = installFixture();

    await expect(
      installLaunchAgent({
        execFile: async () => ({ stderr: '', stdout: 'v22.13.0' }),
        plistPath,
        renderOptions: {
          ...configured,
          nodePath: join(configured.workingDirectory, 'missing-node'),
        },
        uid: 501,
      }),
    ).rejects.toThrow(/Node executable/);
    const nodeDirectory = join(configured.workingDirectory, 'node-directory');
    mkdirSync(nodeDirectory);
    await expect(
      installLaunchAgent({
        execFile: async () => ({ stderr: '', stdout: 'v22.13.0' }),
        plistPath,
        renderOptions: { ...configured, nodePath: nodeDirectory },
        uid: 501,
      }),
    ).rejects.toThrow(/Node executable/);
    rmSync(configured.cliPath);
    await expect(
      installLaunchAgent({
        execFile: async () => ({ stderr: '', stdout: 'v22.13.0' }),
        plistPath,
        renderOptions: configured,
        uid: 501,
      }),
    ).rejects.toThrow(/compiled CLI/i);
    expect(existsSync(plistPath)).toBe(false);
  });

  it('unloads by service label even when the plist is missing', async () => {
    const directory = temporaryDirectory();
    const plistPath = join(directory, 'missing.plist');
    const commands: Array<{ args: readonly string[]; file: string }> = [];
    const fakeExecFile: ExecFile = async (file, args) => {
      commands.push({ args, file });
      return { stderr: '', stdout: '' };
    };

    await uninstallLaunchAgent({
      execFile: fakeExecFile,
      label: 'com.example.costco.matcher',
      plistPath,
      uid: 502,
    });

    expect(commands).toEqual([
      {
        file: '/bin/launchctl',
        args: ['bootout', 'gui/502/com.example.costco.matcher'],
      },
    ]);
  });

  it('does not ignore an unrelated launchctl code 3 failure', async () => {
    const directory = temporaryDirectory();
    const denied = commandError('Operation not permitted', 3);

    await expect(
      uninstallLaunchAgent({
        execFile: async () => {
          throw denied;
        },
        label: 'com.example.costco.matcher',
        plistPath: join(directory, 'costco.plist'),
        uid: 502,
      }),
    ).rejects.toBe(denied);
  });
});
