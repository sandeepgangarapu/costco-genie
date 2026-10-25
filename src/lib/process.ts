import { execFile as nodeExecFile } from 'node:child_process';
import { close as nodeClose } from 'node:fs';

import fsExt from 'fs-ext';

import { openPrivateRegularFile } from './filesystem.js';

export interface ExecFileResult {
  readonly stderr: string;
  readonly stdout: string;
}

export type ExecFile = (
  file: string,
  args: readonly string[],
  options?: ExecFileOptions,
) => Promise<ExecFileResult>;

export interface ExecFileOptions {
  readonly timeoutMilliseconds?: number;
}

export type NodeExecFile = (
  file: string,
  args: readonly string[],
  options: { readonly encoding: 'utf8'; readonly timeout: number },
  callback: (
    error:
      (Error & NodeJS.ErrnoException & { readonly killed?: boolean }) | null,
    stdout: string,
    stderr: string,
  ) => void,
) => void;

// Scheduled and notification subprocesses must not hold the run lock forever.
const NONINTERACTIVE_PROCESS_TIMEOUT_MILLISECONDS = 30_000;

export class ExecFileError extends Error {
  readonly code: number | string | null | undefined;
  readonly stderr: string;
  readonly stdout: string;

  constructor(
    file: string,
    error: Error & {
      readonly code?: number | string | null;
      readonly killed?: boolean;
    },
    stdout: string,
    stderr: string,
    timeoutMilliseconds?: number,
  ) {
    super(
      error.killed === true && timeoutMilliseconds !== undefined
        ? `Command timed out after ${String(timeoutMilliseconds)}ms: ${file}`
        : `Command failed: ${file}${stderr.trim() ? `: ${stderr.trim()}` : ''}`,
      {
        cause: error,
      },
    );
    this.name = 'ExecFileError';
    this.code = error.code;
    this.stderr = stderr;
    this.stdout = stdout;
  }
}

export function createExecFile(
  runner: NodeExecFile = nodeExecFile as NodeExecFile,
): ExecFile {
  return (file, args, options = {}) =>
    new Promise((resolve, reject) => {
      const timeoutMilliseconds =
        options.timeoutMilliseconds ??
        NONINTERACTIVE_PROCESS_TIMEOUT_MILLISECONDS;
      runner(
        file,
        [...args],
        { encoding: 'utf8', timeout: timeoutMilliseconds },
        (error, stdout, stderr) => {
          if (error) {
            reject(
              new ExecFileError(
                file,
                error,
                stdout,
                stderr,
                timeoutMilliseconds,
              ),
            );
            return;
          }
          resolve({ stderr, stdout });
        },
      );
    });
}

export const execFile: ExecFile = createExecFile();

export class RunOverlapError extends Error {
  constructor(lockPath: string, options?: ErrorOptions) {
    super(`Another Costco price check holds the lock: ${lockPath}`, options);
    this.name = 'RunOverlapError';
  }
}

export type FileLockOperation = 'exnb' | 'un';

export interface FileRunLockOperations {
  readonly close: (fd: number) => Promise<void>;
  readonly flock: (fd: number, operation: FileLockOperation) => Promise<void>;
  readonly open: (lockPath: string) => Promise<number>;
}

const fileRunLockOperations: FileRunLockOperations = {
  close: (fd) =>
    new Promise((resolve, reject) => {
      nodeClose(fd, (error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    }),
  flock: (fd, operation) =>
    new Promise((resolve, reject) => {
      fsExt.flock(fd, operation, (error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    }),
  open: async (lockPath) =>
    openPrivateRegularFile(lockPath, { create: true, harden: true }),
};

export interface FileRunLockOptions {
  readonly operations?: FileRunLockOperations;
  readonly readOnly?: boolean;
}

export class FileRunLock {
  private readonly operations: FileRunLockOperations;

  constructor(
    private readonly lockPath: string,
    options: FileRunLockOptions = {},
  ) {
    this.operations = options.operations ?? {
      ...fileRunLockOperations,
      ...(options.readOnly
        ? {
            open: async (path: string) =>
              openPrivateRegularFile(path, { readOnly: true }),
          }
        : {}),
    };
  }

  async runExclusive<T>(action: () => Promise<T>): Promise<T> {
    const fd = await this.operations.open(this.lockPath);

    try {
      await this.operations.flock(fd, 'exnb');
    } catch (error) {
      try {
        await this.operations.close(fd);
      } catch {
        // The acquisition error is primary; closing must not replace it.
      }

      if (isLockContention(error)) {
        throw new RunOverlapError(this.lockPath, { cause: error });
      }
      throw error;
    }

    let actionCompleted = false;
    let actionError: unknown;
    let result: T | undefined;
    let cleanupFailed = false;
    let cleanupError: unknown;
    try {
      try {
        result = await action();
        actionCompleted = true;
      } catch (error) {
        actionError = error;
      }
    } finally {
      try {
        await this.operations.flock(fd, 'un');
      } catch (error) {
        cleanupFailed = true;
        cleanupError = error;
      }
      try {
        await this.operations.close(fd);
      } catch (error) {
        if (!cleanupFailed) {
          cleanupFailed = true;
          cleanupError = error;
        }
      }
    }

    if (!actionCompleted) throw actionError;
    if (cleanupFailed) throw cleanupError;
    return result as T;
  }
}

function isLockContention(error: unknown): boolean {
  if (typeof error !== 'object' || error === null || !('code' in error)) {
    return false;
  }
  return error.code === 'EAGAIN' || error.code === 'EWOULDBLOCK';
}
