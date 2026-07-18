import type { Dirent } from 'node:fs';
import {
  access,
  mkdir,
  readdir,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';

import { stableStringify } from '@geulbat/shared-utils/stable-json';

import { getErrorCode } from '../utils/error.js';
import {
  parseToolLibraryProjectionManifestModule,
  parseToolLibraryProjectionPin,
  verifyToolLibraryProjectionManifest,
  verifyToolLibraryProjectionPinMatchesManifest,
  type ToolLibraryProjectionIdentity,
  type ToolLibraryProjectionManifest,
  type ToolLibraryProjectionPin,
} from '@geulbat/tool-library/projection-codec';
import {
  getToolLibraryProjectionIdentity,
  getToolLibraryProjectionManifest,
  projectionDirectoryNameForHash,
} from '@geulbat/tool-library/projection-manifest';
import type { ToolLibraryProjectionFile } from '@geulbat/tool-library/projection-descriptor';
import {
  getToolLibraryProjectionMount,
  type ToolLibraryProjectionMount,
} from './tool-library-projection-mount.js';
import {
  resolveToolLibraryProjectionFilePath,
  TOOL_LIBRARY_PROJECTION_MANIFEST_MODULE,
  TOOL_LIBRARY_PROJECTION_PIN_FILE,
} from './tool-library-projection-path.js';

type ToolLibraryProjectionReadFailureReason =
  | 'projection_identity_mismatch'
  | 'manifest_invalid'
  | 'manifest_mismatch'
  | 'manifest_parse_failed'
  | 'manifest_read_failed'
  | 'pin_invalid'
  | 'pin_mismatch'
  | 'pin_parse_failed'
  | 'pin_read_failed';

type ReadVerifiedToolLibraryPinnedProjectionResult =
  | {
      ok: true;
      manifest: ToolLibraryProjectionManifest;
      pin: ToolLibraryProjectionPin;
      projectionRootPath: string;
    }
  | {
      ok: false;
      reason: ToolLibraryProjectionReadFailureReason;
      message: string;
    };

export type ReadVerifiedToolLibraryProjectionMountResult =
  | {
      ok: true;
      manifest: ToolLibraryProjectionManifest;
      mount: ToolLibraryProjectionMount;
      pin: ToolLibraryProjectionPin;
    }
  | {
      ok: false;
      reason:
        | ToolLibraryProjectionReadFailureReason
        | 'import_specifier_mismatch'
        | 'mount_file_missing';
      message: string;
    };

interface ToolLibraryProjectionWriteResult {
  rootPath: string;
  writtenFiles: readonly string[];
}

interface ToolLibraryProjectionPruneResult {
  removedDirectories: readonly string[];
  failedDirectories: readonly string[];
}

type ExistingPinnedToolLibraryProjectionResult =
  | { kind: 'missing' }
  | {
      kind: 'present';
      manifest: ToolLibraryProjectionManifest;
      mount: ToolLibraryProjectionMount;
      pin: ToolLibraryProjectionPin;
    }
  | { kind: 'failed'; message: string };

type ReadToolLibraryProjectionManifestResult = ReturnType<
  typeof parseToolLibraryProjectionManifestModule
>;

type ReadToolLibraryProjectionPinResult = ReturnType<
  typeof parseToolLibraryProjectionPin
>;

async function readVerifiedToolLibraryPinnedProjection(args: {
  threadProjectionRootPath: string;
  expectedIdentity?: ToolLibraryProjectionIdentity;
  expectedPin?: ToolLibraryProjectionPin;
}): Promise<ReadVerifiedToolLibraryPinnedProjectionResult> {
  if (args.expectedPin !== undefined) {
    return await readVerifiedToolLibraryProjectionFromPin({
      threadProjectionRootPath: args.threadProjectionRootPath,
      pin: args.expectedPin,
      ...(args.expectedIdentity === undefined
        ? {}
        : { expectedIdentity: args.expectedIdentity }),
    });
  }

  if (args.expectedIdentity !== undefined) {
    return await readVerifiedToolLibraryProjectionFromIdentity({
      threadProjectionRootPath: args.threadProjectionRootPath,
      expectedIdentity: args.expectedIdentity,
    });
  }

  const pinResult = await readToolLibraryProjectionPin(
    args.threadProjectionRootPath,
  );

  if (!pinResult.ok) {
    return pinResult;
  }

  const projectionRootPath = join(
    args.threadProjectionRootPath,
    pinResult.pin.projectionDirectory,
  );
  const manifestResult =
    await readToolLibraryProjectionManifest(projectionRootPath);
  if (!manifestResult.ok) {
    return manifestResult;
  }
  const pinManifestResult = verifyToolLibraryProjectionPinMatchesManifest({
    manifest: manifestResult.manifest,
    pin: pinResult.pin,
  });
  if (!pinManifestResult.ok) {
    return pinManifestResult;
  }
  return {
    ok: true,
    manifest: manifestResult.manifest,
    pin: pinResult.pin,
    projectionRootPath,
  };
}

export async function readVerifiedToolLibraryProjectionMount(args: {
  threadProjectionRootPath: string;
  expectedIdentity?: ToolLibraryProjectionIdentity;
  expectedPin?: ToolLibraryProjectionPin;
  importSpecifier?: string;
}): Promise<ReadVerifiedToolLibraryProjectionMountResult> {
  const pinnedProjectionResult = await readVerifiedToolLibraryPinnedProjection({
    threadProjectionRootPath: args.threadProjectionRootPath,
    ...(args.expectedIdentity === undefined
      ? {}
      : { expectedIdentity: args.expectedIdentity }),
    ...(args.expectedPin === undefined
      ? {}
      : { expectedPin: args.expectedPin }),
  });
  if (!pinnedProjectionResult.ok) {
    return pinnedProjectionResult;
  }
  if (
    args.importSpecifier !== undefined &&
    pinnedProjectionResult.pin.importSpecifier !== args.importSpecifier
  ) {
    return {
      ok: false,
      reason: 'import_specifier_mismatch',
      message:
        'Tool library projection import specifier does not match expected runtime mount',
    };
  }

  const mount = getToolLibraryProjectionMount({
    pin: pinnedProjectionResult.pin,
    projectionRootPath: pinnedProjectionResult.projectionRootPath,
  });
  const missingFile = await findMissingToolLibraryProjectionMountFile(mount);
  if (missingFile !== null) {
    return {
      ok: false,
      reason: 'mount_file_missing',
      message: 'Tool library projection mount file could not be read',
    };
  }

  return {
    ok: true,
    manifest: pinnedProjectionResult.manifest,
    mount,
    pin: pinnedProjectionResult.pin,
  };
}

async function readToolLibraryProjectionManifest(
  rootPath: string,
): Promise<ReadToolLibraryProjectionManifestResult> {
  if (!isAbsolute(rootPath)) {
    return {
      ok: false,
      reason: 'manifest_read_failed',
      message: 'Tool library projection manifest root must be absolute',
    };
  }

  let source: string;
  try {
    source = await readFile(
      resolveToolLibraryProjectionFilePath(
        rootPath,
        TOOL_LIBRARY_PROJECTION_MANIFEST_MODULE,
      ),
      'utf8',
    );
  } catch {
    return {
      ok: false,
      reason: 'manifest_read_failed',
      message: 'Tool library projection manifest could not be read',
    };
  }

  return parseToolLibraryProjectionManifestModule(source);
}

async function readVerifiedToolLibraryProjectionManifest(args: {
  rootPath: string;
  expectedManifest: ToolLibraryProjectionManifest;
}): Promise<ReadToolLibraryProjectionManifestResult> {
  const result = await readToolLibraryProjectionManifest(args.rootPath);
  if (!result.ok) {
    return result;
  }
  return verifyToolLibraryProjectionManifest({
    manifest: result.manifest,
    expectedManifest: args.expectedManifest,
  });
}

async function readToolLibraryProjectionPin(
  threadProjectionRootPath: string,
): Promise<ReadToolLibraryProjectionPinResult> {
  if (!isAbsolute(threadProjectionRootPath)) {
    return {
      ok: false,
      reason: 'pin_read_failed',
      message: 'Tool library projection pin root must be absolute',
    };
  }

  let source: string;
  try {
    source = await readFile(
      resolveToolLibraryProjectionFilePath(
        threadProjectionRootPath,
        TOOL_LIBRARY_PROJECTION_PIN_FILE,
      ),
      'utf8',
    );
  } catch {
    return {
      ok: false,
      reason: 'pin_read_failed',
      message: 'Tool library projection pin could not be read',
    };
  }

  return parseToolLibraryProjectionPin(source);
}

export async function writeToolLibraryProjectionFiles(projection: {
  rootPath: string;
  files: readonly ToolLibraryProjectionFile[];
}): Promise<ToolLibraryProjectionWriteResult> {
  const seenPaths = new Set<string>();
  const writtenFiles: string[] = [];
  if (!isAbsolute(projection.rootPath)) {
    throw new Error('Tool library projection rootPath must be absolute');
  }

  for (const file of projection.files) {
    if (seenPaths.has(file.path)) {
      throw new Error(
        `Duplicate tool library projection file path: ${file.path}`,
      );
    }
    seenPaths.add(file.path);

    const targetPath = resolveToolLibraryProjectionFilePath(
      projection.rootPath,
      file.path,
    );
    await mkdir(dirname(targetPath), { recursive: true });
    await writeFile(targetPath, file.content, 'utf8');
    writtenFiles.push(file.path);
  }

  return {
    rootPath: projection.rootPath,
    writtenFiles,
  };
}

export async function writeToolLibraryProjectionPinFile(args: {
  threadProjectionRootPath: string;
  pin: ToolLibraryProjectionPin;
}): Promise<void> {
  if (!isAbsolute(args.threadProjectionRootPath)) {
    throw new Error('Tool library projection pin root must be absolute');
  }
  await mkdir(args.threadProjectionRootPath, { recursive: true });
  await writeFile(
    resolveToolLibraryProjectionFilePath(
      args.threadProjectionRootPath,
      TOOL_LIBRARY_PROJECTION_PIN_FILE,
    ),
    `${stableStringify(args.pin)}\n`,
    'utf8',
  );
}

export async function pruneInvalidToolLibraryProjectionDirectories(args: {
  threadProjectionRootPath: string;
  retainedProjectionDirectories: readonly string[];
}): Promise<ToolLibraryProjectionPruneResult> {
  if (!isAbsolute(args.threadProjectionRootPath)) {
    throw new Error('Tool library projection prune root must be absolute');
  }

  const retained = new Set(args.retainedProjectionDirectories);
  let entries: Dirent<string>[];
  try {
    entries = await readdir(args.threadProjectionRootPath, {
      withFileTypes: true,
    });
  } catch (error: unknown) {
    const code = getErrorCode(error);
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      return {
        removedDirectories: [],
        failedDirectories: [],
      };
    }
    throw error;
  }

  const removedDirectories: string[] = [];
  const failedDirectories: string[] = [];
  for (const entry of entries) {
    if (
      !entry.isDirectory() ||
      retained.has(entry.name) ||
      !isToolLibraryProjectionDirectoryName(entry.name)
    ) {
      continue;
    }

    const candidateRootPath = join(args.threadProjectionRootPath, entry.name);
    const manifestResult =
      await readToolLibraryProjectionManifest(candidateRootPath);
    if (manifestResult.ok) {
      continue;
    }

    try {
      await rm(candidateRootPath, { recursive: true, force: true });
      removedDirectories.push(entry.name);
    } catch {
      failedDirectories.push(entry.name);
    }
  }

  return {
    removedDirectories,
    failedDirectories,
  };
}

export async function readExistingPinnedToolLibraryProjection(args: {
  threadProjectionRootPath: string;
  importSpecifier: string;
}): Promise<ExistingPinnedToolLibraryProjectionResult> {
  const pinPath = resolveToolLibraryProjectionFilePath(
    args.threadProjectionRootPath,
    TOOL_LIBRARY_PROJECTION_PIN_FILE,
  );
  try {
    await access(pinPath);
  } catch (error) {
    const code = getErrorCode(error);
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      return { kind: 'missing' };
    }
    return {
      kind: 'failed',
      message: 'Tool library projection pin could not be checked',
    };
  }

  const mountResult = await readVerifiedToolLibraryProjectionMount({
    threadProjectionRootPath: args.threadProjectionRootPath,
    importSpecifier: args.importSpecifier,
  });
  if (!mountResult.ok) {
    return {
      kind: 'failed',
      message: 'Existing tool library projection pin could not be verified',
    };
  }

  return {
    kind: 'present',
    manifest: mountResult.manifest,
    mount: mountResult.mount,
    pin: mountResult.pin,
  };
}

async function readVerifiedToolLibraryProjectionFromPin(args: {
  threadProjectionRootPath: string;
  pin: ToolLibraryProjectionPin;
  expectedIdentity?: ToolLibraryProjectionIdentity;
}): Promise<ReadVerifiedToolLibraryPinnedProjectionResult> {
  const projectionRootPath = join(
    args.threadProjectionRootPath,
    args.pin.projectionDirectory,
  );
  const manifestResult = await readVerifiedToolLibraryProjectionManifest({
    rootPath: projectionRootPath,
    expectedManifest: getToolLibraryProjectionManifest(args.pin),
  });
  if (!manifestResult.ok) {
    return manifestResult;
  }
  if (
    args.expectedIdentity !== undefined &&
    !doesToolLibraryProjectionIdentityMatch({
      projection: args.pin,
      expectedIdentity: args.expectedIdentity,
    })
  ) {
    return projectionIdentityMismatch();
  }
  return {
    ok: true,
    manifest: manifestResult.manifest,
    pin: args.pin,
    projectionRootPath,
  };
}

async function readVerifiedToolLibraryProjectionFromIdentity(args: {
  threadProjectionRootPath: string;
  expectedIdentity: ToolLibraryProjectionIdentity;
}): Promise<ReadVerifiedToolLibraryPinnedProjectionResult> {
  const projectionDirectory = projectionDirectoryNameForHash(
    args.expectedIdentity.sdkProjectionHash,
  );
  const projectionRootPath = join(
    args.threadProjectionRootPath,
    projectionDirectory,
  );
  const manifestResult =
    await readToolLibraryProjectionManifest(projectionRootPath);
  if (!manifestResult.ok) {
    return manifestResult;
  }
  if (
    !doesToolLibraryProjectionIdentityMatch({
      projection: manifestResult.manifest,
      expectedIdentity: args.expectedIdentity,
    })
  ) {
    return projectionIdentityMismatch();
  }
  return {
    ok: true,
    manifest: manifestResult.manifest,
    pin: {
      ...manifestResult.manifest,
      projectionDirectory,
    },
    projectionRootPath,
  };
}

function isToolLibraryProjectionDirectoryName(value: string): boolean {
  return /^sha256-[0-9a-f]{64}$/u.test(value);
}

function projectionIdentityMismatch(): ReadVerifiedToolLibraryPinnedProjectionResult {
  return {
    ok: false,
    reason: 'projection_identity_mismatch',
    message:
      'Tool library projection identity does not match expected replay projection',
  };
}

async function findMissingToolLibraryProjectionMountFile(
  mount: ToolLibraryProjectionMount,
): Promise<string | null> {
  for (const filePath of [
    mount.manifestModulePath,
    mount.catalogModulePath,
    mount.searchModulePath,
    mount.searchRuntimeModulePath,
    mount.indexModulePath,
    mount.indexDeclarationPath,
    ...mount.importableModules.map((module) => module.filePath),
  ]) {
    try {
      await access(filePath);
    } catch {
      return filePath;
    }
  }
  return null;
}

function doesToolLibraryProjectionIdentityMatch(args: {
  projection: ToolLibraryProjectionIdentity;
  expectedIdentity: ToolLibraryProjectionIdentity;
}): boolean {
  return (
    stableStringify(getToolLibraryProjectionIdentity(args.projection)) ===
    stableStringify(args.expectedIdentity)
  );
}
