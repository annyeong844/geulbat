import type { Dirent } from 'node:fs';
import {
  access,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';

import { stableStringify } from '@geulbat/content-identity/stable-json';

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
  isThreadProjectionDirectoryName,
  resolveToolLibraryProjectionFilePath,
  threadProjectionDirectoryName,
  toolLibraryProjectionsRootPath,
  TOOL_LIBRARY_PROJECTION_MANIFEST_MODULE,
  TOOL_LIBRARY_PROJECTION_PIN_FILE,
} from './tool-library-projection-path.js';

type ToolLibraryProjectionReadFailureReason =
  | 'content_missing'
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
  /**
   * pin은 읽혔지만 그 pin이 가리키는 콘텐츠가 없다. 콘텐츠는 pin에서 다시 만들 수
   * 있는 파생물이므로 이것은 손상이 아니라 재생성 대상이다. 콘텐츠가 있는데 내용이
   * 어긋나는 경우와 구분해야 공유 콘텐츠 GC가 스레드를 깨뜨리지 않는다.
   */
  | { kind: 'content_missing'; pin: ToolLibraryProjectionPin }
  | { kind: 'failed'; message: string };

type ReadToolLibraryProjectionManifestResult = ReturnType<
  typeof parseToolLibraryProjectionManifestModule
>;

type ReadToolLibraryProjectionPinResult = ReturnType<
  typeof parseToolLibraryProjectionPin
>;

async function readVerifiedToolLibraryPinnedProjection(args: {
  contentRootPath: string;
  threadProjectionRootPath: string;
  expectedIdentity?: ToolLibraryProjectionIdentity;
  expectedPin?: ToolLibraryProjectionPin;
}): Promise<ReadVerifiedToolLibraryPinnedProjectionResult> {
  if (args.expectedPin !== undefined) {
    return await readVerifiedToolLibraryProjectionFromPin({
      contentRootPath: args.contentRootPath,
      threadProjectionRootPath: args.threadProjectionRootPath,
      pin: args.expectedPin,
      ...(args.expectedIdentity === undefined
        ? {}
        : { expectedIdentity: args.expectedIdentity }),
    });
  }

  if (args.expectedIdentity !== undefined) {
    return await readVerifiedToolLibraryProjectionFromIdentity({
      contentRootPath: args.contentRootPath,
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

  const content = await resolveToolLibraryProjectionContentPath({
    contentRootPath: args.contentRootPath,
    threadProjectionRootPath: args.threadProjectionRootPath,
    projectionDirectory: pinResult.pin.projectionDirectory,
  });
  if (content === null) {
    return toolLibraryProjectionContentMissing();
  }
  const projectionRootPath = content.path;
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
  contentRootPath: string;
  threadProjectionRootPath: string;
  expectedIdentity?: ToolLibraryProjectionIdentity;
  expectedPin?: ToolLibraryProjectionPin;
  importSpecifier?: string;
}): Promise<ReadVerifiedToolLibraryProjectionMountResult> {
  const pinnedProjectionResult = await readVerifiedToolLibraryPinnedProjection({
    contentRootPath: args.contentRootPath,
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
  contentRootPath: string;
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
    contentRootPath: args.contentRootPath,
    threadProjectionRootPath: args.threadProjectionRootPath,
    importSpecifier: args.importSpecifier,
  });
  if (!mountResult.ok) {
    if (
      mountResult.reason === 'content_missing' ||
      mountResult.reason === 'mount_file_missing'
    ) {
      const pinResult = await readToolLibraryProjectionPin(
        args.threadProjectionRootPath,
      );
      if (pinResult.ok) {
        return { kind: 'content_missing', pin: pinResult.pin };
      }
    }
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
  contentRootPath: string;
  threadProjectionRootPath: string;
  pin: ToolLibraryProjectionPin;
  expectedIdentity?: ToolLibraryProjectionIdentity;
}): Promise<ReadVerifiedToolLibraryPinnedProjectionResult> {
  const content = await resolveToolLibraryProjectionContentPath({
    contentRootPath: args.contentRootPath,
    threadProjectionRootPath: args.threadProjectionRootPath,
    projectionDirectory: args.pin.projectionDirectory,
  });
  if (content === null) {
    return toolLibraryProjectionContentMissing();
  }
  const projectionRootPath = content.path;
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
  contentRootPath: string;
  threadProjectionRootPath: string;
  expectedIdentity: ToolLibraryProjectionIdentity;
}): Promise<ReadVerifiedToolLibraryPinnedProjectionResult> {
  const projectionDirectory = projectionDirectoryNameForHash(
    args.expectedIdentity.sdkProjectionHash,
  );
  const content = await resolveToolLibraryProjectionContentPath({
    contentRootPath: args.contentRootPath,
    threadProjectionRootPath: args.threadProjectionRootPath,
    projectionDirectory,
  });
  if (content === null) {
    return toolLibraryProjectionContentMissing();
  }
  const projectionRootPath = content.path;
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

/**
 * pin은 콘텐츠 디렉터리의 **이름**만 담고 위치는 담지 않는다. 그래서 공유 위치를
 * 먼저 보고, 없으면 구 레이아웃(thread 디렉터리 안)을 본다. 구 상태를 가진 설치가
 * 계속 동작하면서 다음 재생성 때 자연히 공유 위치로 옮겨간다.
 */
async function resolveToolLibraryProjectionContentPath(args: {
  contentRootPath: string;
  threadProjectionRootPath: string;
  projectionDirectory: string;
}): Promise<{ path: string; location: 'shared' | 'legacy' } | null> {
  for (const candidate of [
    {
      path: join(args.contentRootPath, args.projectionDirectory),
      location: 'shared' as const,
    },
    {
      path: join(args.threadProjectionRootPath, args.projectionDirectory),
      location: 'legacy' as const,
    },
  ]) {
    try {
      await access(
        resolveToolLibraryProjectionFilePath(
          candidate.path,
          TOOL_LIBRARY_PROJECTION_MANIFEST_MODULE,
        ),
      );
      return candidate;
    } catch {
      continue;
    }
  }
  return null;
}

export function toolLibraryProjectionContentPathForDirectory(args: {
  contentRootPath: string;
  projectionDirectory: string;
}): string {
  if (!isToolLibraryProjectionDirectoryName(args.projectionDirectory)) {
    throw new Error(
      `Invalid tool library projection directory: ${args.projectionDirectory}`,
    );
  }
  return join(args.contentRootPath, args.projectionDirectory);
}

/**
 * 구 레이아웃의 thread 안 콘텐츠를 공유 위치로 옮긴다. 공유 위치에 같은 digest가
 * 이미 있으면 콘텐츠가 동일하므로 thread 사본만 지운다. 이름이 digest이므로 옮기는
 * 도중 다른 thread가 같은 digest를 만들어도 결과는 같은 바이트다.
 */
export async function migrateLegacyToolLibraryProjectionContent(args: {
  contentRootPath: string;
  threadProjectionRootPath: string;
}): Promise<{ migratedDirectories: string[]; failedDirectories: string[] }> {
  let entries: Dirent<string>[];
  try {
    entries = await readdir(args.threadProjectionRootPath, {
      withFileTypes: true,
    });
  } catch (error: unknown) {
    const code = getErrorCode(error);
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      return { migratedDirectories: [], failedDirectories: [] };
    }
    throw error;
  }

  const migratedDirectories: string[] = [];
  const failedDirectories: string[] = [];
  for (const entry of entries) {
    if (
      !entry.isDirectory() ||
      !isToolLibraryProjectionDirectoryName(entry.name)
    ) {
      continue;
    }
    const legacyPath = join(args.threadProjectionRootPath, entry.name);
    const sharedPath = join(args.contentRootPath, entry.name);
    try {
      await mkdir(args.contentRootPath, { recursive: true });
      try {
        await rename(legacyPath, sharedPath);
      } catch (error: unknown) {
        const code = getErrorCode(error);
        // 공유 위치가 이미 있으면(동일 digest) thread 사본은 불필요하다.
        if (code !== 'ENOTEMPTY' && code !== 'EEXIST' && code !== 'EPERM') {
          throw error;
        }
        await rm(legacyPath, { recursive: true, force: true });
      }
      migratedDirectories.push(entry.name);
    } catch {
      failedDirectories.push(entry.name);
    }
  }
  return { migratedDirectories, failedDirectories };
}

/**
 * 어떤 thread pin도 가리키지 않는 공유 콘텐츠를 제거한다.
 *
 * 스캔과 삭제 사이에 새 pin이 생겨도 안전하다. 콘텐츠는 pin에서 다시 만들 수 있고,
 * 해석 경로가 `content_missing`을 재생성으로 처리하기 때문이다. 반대로 pin을 읽지
 * 못한 thread 디렉터리가 하나라도 있으면 참조 집합을 신뢰할 수 없으므로 아무것도
 * 지우지 않는다.
 */
export async function pruneUnreferencedToolLibraryProjectionContent(args: {
  projectionsRootPath: string;
  contentRootPath: string;
}): Promise<{
  removedDirectories: string[];
  failedDirectories: string[];
  retainedDirectories: string[];
  unreadableThreadDirectories: string[];
}> {
  let rootEntries: Dirent<string>[];
  try {
    rootEntries = await readdir(args.projectionsRootPath, {
      withFileTypes: true,
    });
  } catch (error: unknown) {
    const code = getErrorCode(error);
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      return {
        removedDirectories: [],
        failedDirectories: [],
        retainedDirectories: [],
        unreadableThreadDirectories: [],
      };
    }
    throw error;
  }

  const retained = new Set<string>();
  const unreadableThreadDirectories: string[] = [];
  for (const entry of rootEntries) {
    if (!entry.isDirectory() || !isThreadProjectionDirectoryName(entry.name)) {
      continue;
    }
    const threadProjectionRootPath = join(args.projectionsRootPath, entry.name);
    const pinResult = await readToolLibraryProjectionPin(
      threadProjectionRootPath,
    );
    if (!pinResult.ok) {
      unreadableThreadDirectories.push(entry.name);
      continue;
    }
    retained.add(pinResult.pin.projectionDirectory);
  }

  if (unreadableThreadDirectories.length > 0) {
    return {
      removedDirectories: [],
      failedDirectories: [],
      retainedDirectories: [...retained].sort(),
      unreadableThreadDirectories,
    };
  }

  let contentEntries: Dirent<string>[];
  try {
    contentEntries = await readdir(args.contentRootPath, {
      withFileTypes: true,
    });
  } catch (error: unknown) {
    const code = getErrorCode(error);
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      return {
        removedDirectories: [],
        failedDirectories: [],
        retainedDirectories: [...retained].sort(),
        unreadableThreadDirectories: [],
      };
    }
    throw error;
  }

  const removedDirectories: string[] = [];
  const failedDirectories: string[] = [];
  for (const entry of contentEntries) {
    if (
      !entry.isDirectory() ||
      !isToolLibraryProjectionDirectoryName(entry.name) ||
      retained.has(entry.name)
    ) {
      continue;
    }
    try {
      await rm(join(args.contentRootPath, entry.name), {
        recursive: true,
        force: true,
      });
      removedDirectories.push(entry.name);
    } catch {
      failedDirectories.push(entry.name);
    }
  }

  return {
    removedDirectories,
    failedDirectories,
    retainedDirectories: [...retained].sort(),
    unreadableThreadDirectories: [],
  };
}

/**
 * 스레드 삭제 시 그 스레드의 pin 디렉터리를 지운다. 공유 콘텐츠는 다른 스레드가
 * 참조할 수 있으므로 건드리지 않는다. 회수는 GC가 담당한다.
 */
export async function deleteThreadToolLibraryProjection(args: {
  projectionsRootPath: string;
  threadId: string;
}): Promise<boolean> {
  const threadProjectionRootPath = join(
    args.projectionsRootPath,
    threadProjectionDirectoryName(args.threadId),
  );
  try {
    await rm(threadProjectionRootPath, { recursive: true });
    return true;
  } catch (error: unknown) {
    const code = getErrorCode(error);
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      return false;
    }
    throw error;
  }
}

function toolLibraryProjectionContentMissing(): ReadVerifiedToolLibraryPinnedProjectionResult {
  return {
    ok: false,
    reason: 'content_missing',
    message:
      'Tool library projection content is absent for the pinned projection',
  };
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

/**
 * 세션 삭제 경로가 쓰는 pin 삭제 어댑터. projections 루트 경로는 tools 계층이
 * 소유하므로 경계를 넘지 않고 여기서 조립한다.
 */
export const threadProjectionPinDeletionPort = {
  async deleteThreadProjectionPin(args: {
    stateRoot: string;
    threadId: string;
  }): Promise<boolean> {
    return await deleteThreadToolLibraryProjection({
      projectionsRootPath: toolLibraryProjectionsRootPath(args.stateRoot),
      threadId: args.threadId,
    });
  },
};
