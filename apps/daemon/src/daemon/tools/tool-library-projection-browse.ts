import { lstat } from 'node:fs/promises';
import { posix, win32 } from 'node:path';

import type { ToolLibraryProjectionFile } from '@geulbat/tool-library/projection-descriptor';
import type { ToolExecutionContext } from './types.js';
import { resolveComputerFileToolPath } from './file-tool-root.js';

export const TOOL_LIBRARY_MODEL_FACING_ROOT = 'geulbat-sdk' as const;

interface ToolLibraryProjectionBrowseIdentity {
  sdkVersion: string;
  sdkProjectionHash: `sha256:${string}`;
  policyId: string;
}

export type ToolLibraryProjectionBrowsePathResult =
  | { kind: 'computer_path' }
  | {
      kind: 'failure';
      message: string;
    }
  | {
      kind: 'projection_path';
      identity: ToolLibraryProjectionBrowseIdentity;
      logicalPath: string;
      relativePath: string;
      file: ToolLibraryProjectionFile | undefined;
      files: readonly ToolLibraryProjectionFile[];
      computerFileShadowIgnored: boolean;
    };

export async function resolveToolLibraryProjectionBrowsePath(args: {
  ctx: ToolExecutionContext;
  inputPath: string;
}): Promise<ToolLibraryProjectionBrowsePathResult> {
  if (!isToolLibraryProjectionBrowsePath(args.inputPath)) {
    return { kind: 'computer_path' };
  }

  const identity = args.ctx.toolLibraryProjectionIdentity;
  const projectionPort = args.ctx.agentSpawnRuntime?.toolLibraryProjection;
  const threadId = args.ctx.threadId;
  const stateRoot = args.ctx.stateRoot;
  if (
    identity === undefined ||
    projectionPort === undefined ||
    !threadId ||
    stateRoot === undefined
  ) {
    return {
      kind: 'failure',
      message: 'The pinned tool library projection is unavailable',
    };
  }

  try {
    const result = await projectionPort.rehydrateProjectionMount({
      stateRoot,
      threadId,
      expectedIdentity: identity,
    });
    if (
      !result.ok ||
      result.mount.importSpecifier !== TOOL_LIBRARY_MODEL_FACING_ROOT
    ) {
      return {
        kind: 'failure',
        message: 'The pinned tool library projection could not be verified',
      };
    }

    const relativePath = resolveProjectedRelativePath({
      inputPath: args.inputPath,
      modelFacingCatalogRef: result.mount.modelFacingCatalogRef,
      files: result.projection.files,
      tools: result.projection.tools,
    });
    if (relativePath === null) {
      return {
        kind: 'failure',
        message: 'The requested tool library path is not projected',
      };
    }

    return {
      kind: 'projection_path',
      identity: {
        sdkVersion: result.pin.sdkVersion,
        sdkProjectionHash: result.pin.sdkProjectionHash,
        policyId: result.pin.policyId,
      },
      logicalPath: args.inputPath,
      relativePath,
      file: result.projection.files.find((file) => file.path === relativePath),
      files: result.projection.files,
      computerFileShadowIgnored: await computerFileShadowExists(args.ctx),
    };
  } catch {
    return {
      kind: 'failure',
      message: 'The pinned tool library projection could not be verified',
    };
  }
}

function isToolLibraryProjectionBrowsePath(inputPath: string): boolean {
  return (
    inputPath === TOOL_LIBRARY_MODEL_FACING_ROOT ||
    inputPath.startsWith(`${TOOL_LIBRARY_MODEL_FACING_ROOT}/`) ||
    inputPath.startsWith(`${TOOL_LIBRARY_MODEL_FACING_ROOT}://`)
  );
}

function resolveProjectedRelativePath(args: {
  inputPath: string;
  modelFacingCatalogRef: string;
  files: readonly ToolLibraryProjectionFile[];
  tools: readonly {
    signatureRef: string;
    signatureModule: string;
  }[];
}): string | null {
  if (args.inputPath === TOOL_LIBRARY_MODEL_FACING_ROOT) {
    return '';
  }
  if (args.inputPath === args.modelFacingCatalogRef) {
    return args.files.find((file) => file.role === 'catalog')?.path ?? null;
  }
  const signature = args.tools.find(
    (tool) => tool.signatureRef === args.inputPath,
  );
  if (signature !== undefined) {
    return signature.signatureModule;
  }
  if (!args.inputPath.startsWith(`${TOOL_LIBRARY_MODEL_FACING_ROOT}/`)) {
    return null;
  }
  const relativePath = args.inputPath.slice(
    `${TOOL_LIBRARY_MODEL_FACING_ROOT}/`.length,
  );
  if (!isSafeProjectionRelativePath(relativePath)) {
    return null;
  }
  return relativePath;
}

function isSafeProjectionRelativePath(relativePath: string): boolean {
  if (relativePath.length === 0 || relativePath.includes('\\')) {
    return false;
  }
  return relativePath
    .split('/')
    .every(
      (segment) => segment.length > 0 && segment !== '.' && segment !== '..',
    );
}

async function computerFileShadowExists(
  ctx: ToolExecutionContext,
): Promise<boolean> {
  try {
    const filePath = resolveComputerFileToolPath(
      ctx,
      TOOL_LIBRARY_MODEL_FACING_ROOT,
    );
    const pathModule = posix.isAbsolute(filePath.absoluteRoot) ? posix : win32;
    await lstat(pathModule.resolve(filePath.absoluteRoot, filePath.path));
    return true;
  } catch {
    return false;
  }
}
