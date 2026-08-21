import {
  chmodSync,
  closeSync,
  constants as fsConstants,
  fchmodSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  type Stats,
  writeFileSync,
} from 'node:fs';

const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;

export class UnsafeFilesystemPathError extends Error {
  constructor(path: string, reason: string, options?: ErrorOptions) {
    super(`Unsafe filesystem path ${path}: ${reason}`, options);
    this.name = 'UnsafeFilesystemPathError';
  }
}

export function ensurePrivateDirectory(path: string): void {
  const existing = lstatIfPresent(path);
  if (existing !== null) {
    assertOwnedDirectory(path, existing);
  } else {
    mkdirSync(path, { mode: PRIVATE_DIRECTORY_MODE, recursive: true });
    assertOwnedDirectory(path, lstatSync(path));
  }
  chmodSync(path, PRIVATE_DIRECTORY_MODE);
}

export function pathExistsWithoutFollowing(path: string): boolean {
  return lstatIfPresent(path) !== null;
}

export interface PrivateFileOpenOptions {
  readonly create?: boolean;
  readonly exclusive?: boolean;
  readonly harden?: boolean;
  readonly readOnly?: boolean;
}

export function openPrivateRegularFile(
  path: string,
  options: PrivateFileOpenOptions = {},
): number {
  const existing = lstatIfPresent(path);
  if (existing !== null) assertOwnedRegularFile(path, existing);

  let flags =
    options.readOnly === true ? fsConstants.O_RDONLY : fsConstants.O_RDWR;
  flags |= fsConstants.O_NOFOLLOW;
  if (options.create === true) flags |= fsConstants.O_CREAT;
  if (options.exclusive === true) flags |= fsConstants.O_EXCL;

  let fd: number;
  try {
    fd = openSync(path, flags, PRIVATE_FILE_MODE);
  } catch (error) {
    throw new UnsafeFilesystemPathError(
      path,
      'expected an owned regular file and refused to follow symbolic links',
      { cause: error },
    );
  }

  try {
    assertOwnedRegularFile(path, fstatSync(fd));
    if (options.harden === true) fchmodSync(fd, PRIVATE_FILE_MODE);
    return fd;
  } catch (error) {
    closeSync(fd);
    throw error;
  }
}

export function preparePrivateRegularFile(path: string): void {
  const fd = openPrivateRegularFile(path, { create: true, harden: true });
  closeSync(fd);
}

export function hardenPrivateRegularFileIfPresent(path: string): void {
  if (lstatIfPresent(path) === null) return;
  const fd = openPrivateRegularFile(path, { harden: true });
  closeSync(fd);
}

export function inspectRegularFileWithoutMutation(path: string): void {
  const fd = openPrivateRegularFile(path, { readOnly: true });
  closeSync(fd);
}

export function readPrivateTextFile(path: string): string {
  const fd = openPrivateRegularFile(path, {
    harden: true,
    readOnly: true,
  });
  try {
    return readFileSync(fd, 'utf8');
  } finally {
    closeSync(fd);
  }
}

export function createPrivateTextFile(path: string, contents: string): void {
  const fd = openPrivateRegularFile(path, {
    create: true,
    exclusive: true,
    harden: true,
  });
  try {
    writeFileSync(fd, contents, 'utf8');
  } finally {
    closeSync(fd);
  }
}

function lstatIfPresent(path: string): Stats | null {
  try {
    return lstatSync(path);
  } catch (error) {
    if (hasCode(error, 'ENOENT')) return null;
    throw error;
  }
}

function assertOwnedDirectory(path: string, stat: Stats): void {
  if (stat.isSymbolicLink()) {
    throw new UnsafeFilesystemPathError(path, 'symbolic links are not allowed');
  }
  if (!stat.isDirectory()) {
    throw new UnsafeFilesystemPathError(path, 'expected a directory');
  }
  assertOwned(path, stat);
}

function assertOwnedRegularFile(path: string, stat: Stats): void {
  if (stat.isSymbolicLink()) {
    throw new UnsafeFilesystemPathError(path, 'symbolic links are not allowed');
  }
  if (!stat.isFile()) {
    throw new UnsafeFilesystemPathError(path, 'expected a regular file');
  }
  assertOwned(path, stat);
}

function assertOwned(path: string, stat: Stats): void {
  const uid = process.getuid?.();
  if (uid !== undefined && stat.uid !== uid) {
    throw new UnsafeFilesystemPathError(
      path,
      `path is owned by uid ${String(stat.uid)}, expected ${String(uid)}`,
    );
  }
}

function hasCode(error: unknown, code: string): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === code
  );
}
