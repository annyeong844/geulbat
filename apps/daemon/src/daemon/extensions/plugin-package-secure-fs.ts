import { isRecord } from '@geulbat/protocol/runtime-utils';
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { constants, lstat, open, readdir, realpath } from 'node:fs/promises';
import { isAbsolute, relative, sep } from 'node:path';

import { getErrorCode } from '../utils/error.js';
import { PluginPackageAdmissionError } from './plugin-package-admission-contract.js';
import { toAbsolutePackagePath } from './plugin-package-paths.js';

export interface PackageEntry {
  relativePath: string;
  kind: 'directory' | 'file';
  size: number;
  device: number;
  inode: number;
}

interface DirectoryIdentity {
  device: number;
  inode: number;
  birthtimeMs: number;
}

export async function inventoryPackageTree(
  packageRoot: string,
): Promise<Map<string, PackageEntry>> {
  let rootStats;
  try {
    rootStats = await lstat(packageRoot);
  } catch (error: unknown) {
    throw new PluginPackageAdmissionError(
      'invalid_request',
      getErrorCode(error) === 'ENOENT'
        ? 'managed plugin package is missing'
        : 'managed plugin package cannot be inspected',
    );
  }
  if (!rootStats.isDirectory() || rootStats.isSymbolicLink()) {
    throw new PluginPackageAdmissionError(
      'invalid_request',
      'plugin package root must be a directory',
    );
  }

  const entries = new Map<string, PackageEntry>();
  const normalizedPaths = new Map<string, string>();
  const canonicalPackageRoot = await realpath(packageRoot);

  async function inspectDirectory(relativeDirectory: string): Promise<void> {
    const directoryPath = toAbsolutePackagePath(packageRoot, relativeDirectory);
    const expectedDirectory = await inspectContainedDirectory({
      path: directoryPath,
      canonicalRoot: canonicalPackageRoot,
      displayPath: relativeDirectory || '.',
    });
    const children = await readdir(directoryPath, { withFileTypes: true });
    children.sort((left, right) => left.name.localeCompare(right.name));
    for (const child of children) {
      const relativePath = relativeDirectory
        ? `${relativeDirectory}/${child.name}`
        : child.name;
      registerNormalizedPath(normalizedPaths, relativePath);
      const stats = await lstat(
        toAbsolutePackagePath(packageRoot, relativePath),
      );
      assertSupportedPackageEntry(stats, relativePath);
      const kind = stats.isDirectory() ? 'directory' : 'file';
      entries.set(relativePath, {
        relativePath,
        kind,
        size: stats.size,
        device: stats.dev,
        inode: stats.ino,
      });
      if (kind === 'directory') {
        await inspectDirectory(relativePath);
      }
    }
    await assertDirectoryIdentity(
      directoryPath,
      expectedDirectory,
      relativeDirectory || '.',
    );
  }

  await inspectDirectory('');
  return entries;
}

export function assertSupportedPackageEntry(
  stats: Awaited<ReturnType<typeof lstat>>,
  relativePath: string,
): void {
  if (stats.isSymbolicLink()) {
    throw new PluginPackageAdmissionError(
      'invalid_request',
      `plugin package contains a link: ${relativePath}`,
    );
  }
  if (stats.isFile()) {
    if (stats.nlink > 1) {
      throw new PluginPackageAdmissionError(
        'invalid_request',
        `plugin package contains a hard-linked file: ${relativePath}`,
      );
    }
    return;
  }
  if (!stats.isDirectory()) {
    throw new PluginPackageAdmissionError(
      'invalid_request',
      `plugin package contains an unsupported file kind: ${relativePath}`,
    );
  }
}

export function registerNormalizedPath(
  normalizedPaths: Map<string, string>,
  relativePath: string,
): void {
  const normalized = relativePath.normalize('NFC').toLocaleLowerCase('en-US');
  const previous = normalizedPaths.get(normalized);
  if (previous !== undefined && previous !== relativePath) {
    throw new PluginPackageAdmissionError(
      'invalid_request',
      `plugin package contains colliding paths: ${previous}, ${relativePath}`,
    );
  }
  normalizedPaths.set(normalized, relativePath);
}

export async function inspectContainedDirectory(args: {
  path: string;
  canonicalRoot: string;
  displayPath: string;
}): Promise<DirectoryIdentity> {
  const stats = await lstat(args.path);
  assertSupportedPackageEntry(stats, args.displayPath);
  if (!stats.isDirectory()) {
    throw new PluginPackageAdmissionError(
      'invalid_request',
      `plugin package directory changed during import: ${args.displayPath}`,
    );
  }
  const canonicalPath = await realpath(args.path);
  if (!isSameOrContainedPath(args.canonicalRoot, canonicalPath)) {
    throw new PluginPackageAdmissionError(
      'invalid_request',
      `plugin package directory escaped during import: ${args.displayPath}`,
    );
  }
  return directoryIdentity(stats);
}

export async function assertDirectoryIdentity(
  path: string,
  expected: DirectoryIdentity,
  displayPath: string,
): Promise<void> {
  const stats = await lstat(path);
  assertSupportedPackageEntry(stats, displayPath);
  if (
    !stats.isDirectory() ||
    !sameDirectoryIdentity(expected, directoryIdentity(stats))
  ) {
    throw new PluginPackageAdmissionError(
      'invalid_request',
      `plugin package directory changed during import: ${displayPath}`,
    );
  }
}

function directoryIdentity(
  stats: Awaited<ReturnType<typeof lstat>>,
): DirectoryIdentity {
  return {
    device: Number(stats.dev),
    inode: Number(stats.ino),
    birthtimeMs: Number(stats.birthtimeMs),
  };
}

function sameDirectoryIdentity(
  left: DirectoryIdentity,
  right: DirectoryIdentity,
): boolean {
  return (
    left.device === right.device &&
    left.inode === right.inode &&
    left.birthtimeMs === right.birthtimeMs
  );
}

export function isSameOrContainedPath(
  root: string,
  candidate: string,
): boolean {
  const relativePath = relative(root, candidate);
  return (
    relativePath === '' ||
    (relativePath !== '..' &&
      !relativePath.startsWith(`..${sep}`) &&
      !isAbsolute(relativePath))
  );
}

export async function digestPackage(
  packageRoot: string,
  entries: Map<string, PackageEntry>,
): Promise<string> {
  const digest = createHash('sha256');
  const orderedEntries = [...entries.values()].sort((left, right) =>
    Buffer.compare(
      Buffer.from(left.relativePath, 'utf8'),
      Buffer.from(right.relativePath, 'utf8'),
    ),
  );
  for (const entry of orderedEntries) {
    if (entry.kind === 'directory') {
      digest.update(`D\0${entry.relativePath}\0`);
    } else {
      digest.update(`F\0${entry.relativePath}\0${entry.size}\0`);
      const file = await openPackageFile(
        toAbsolutePackagePath(packageRoot, entry.relativePath),
        entry,
      );
      try {
        for await (const chunk of file.createReadStream()) {
          if (!Buffer.isBuffer(chunk)) {
            throw new PluginPackageAdmissionError(
              'invalid_request',
              `plugin package file stream produced non-binary data: ${entry.relativePath}`,
            );
          }
          digest.update(chunk);
        }
      } finally {
        await file.close().catch(() => undefined);
      }
    }
    digest.update('\0');
  }
  return `sha256:${digest.digest('hex')}`;
}

async function openPackageFile(
  absolutePath: string,
  expectedEntry: PackageEntry,
): Promise<Awaited<ReturnType<typeof open>>> {
  const expectedStats = await lstat(absolutePath);
  assertSupportedPackageEntry(expectedStats, expectedEntry.relativePath);
  if (
    expectedEntry.kind !== 'file' ||
    !expectedStats.isFile() ||
    expectedStats.dev !== expectedEntry.device ||
    expectedStats.ino !== expectedEntry.inode ||
    expectedStats.size !== expectedEntry.size
  ) {
    throw new PluginPackageAdmissionError(
      'invalid_request',
      `plugin package entry changed during inspection: ${expectedEntry.relativePath}`,
    );
  }

  const file = await open(
    absolutePath,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
  );
  try {
    const openedStats = await file.stat();
    assertSupportedPackageEntry(openedStats, expectedEntry.relativePath);
    if (
      !openedStats.isFile() ||
      openedStats.dev !== expectedEntry.device ||
      openedStats.ino !== expectedEntry.inode ||
      openedStats.size !== expectedEntry.size
    ) {
      throw new PluginPackageAdmissionError(
        'invalid_request',
        `plugin package entry changed during inspection: ${expectedEntry.relativePath}`,
      );
    }
    return file;
  } catch (error: unknown) {
    await file.close().catch(() => undefined);
    throw error;
  }
}

export async function readPackageBuffer(
  absolutePath: string,
  expectedEntry: PackageEntry,
): Promise<Buffer> {
  const file = await openPackageFile(absolutePath, expectedEntry);
  try {
    return await file.readFile();
  } finally {
    await file.close().catch(() => undefined);
  }
}

export async function readJsonObject(
  absolutePath: string,
  displayPath: string,
  expectedEntry: PackageEntry,
): Promise<Record<string, unknown>> {
  let parsed: unknown;
  try {
    const file = await openPackageFile(absolutePath, expectedEntry);
    try {
      parsed = JSON.parse(await file.readFile('utf8')) as unknown;
    } finally {
      await file.close().catch(() => undefined);
    }
  } catch (error: unknown) {
    if (error instanceof PluginPackageAdmissionError) {
      throw error;
    }
    throw new PluginPackageAdmissionError(
      'invalid_request',
      `plugin JSON is invalid: ${displayPath}`,
    );
  }
  if (!isRecord(parsed)) {
    throw new PluginPackageAdmissionError(
      'invalid_request',
      `plugin JSON must contain an object: ${displayPath}`,
    );
  }
  return parsed;
}
