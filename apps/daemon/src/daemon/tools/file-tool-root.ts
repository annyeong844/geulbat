import { posix, win32 } from 'node:path';

import { FileAccessError } from '../files/file-domain-error.js';
import { normalizePath } from '../files/normalize-path.js';

const WINDOWS_ABSOLUTE_PATH = /^(?:[a-zA-Z]:[\\/]|\\\\)/;

interface ComputerFileToolContext {
  computerFileRoot?: string;
  workingDirectory?: string;
}

export interface ComputerFileToolPath {
  root: 'computer';
  absoluteRoot: string;
  path: string;
}

/**
 * Resolve a model-facing path from the run's current directory. The Computer
 * root is a portable coordinate base, not a host-filesystem sandbox.
 */
export function resolveComputerFileToolPath(
  ctx: ComputerFileToolContext,
  inputPath: string,
): ComputerFileToolPath {
  const absoluteRoot = requireComputerFileRoot(ctx);
  const candidatePath = isAbsolutePath(inputPath)
    ? inputPath
    : joinPortablePath(
        normalizePath(absoluteRoot, ctx.workingDirectory ?? ''),
        inputPath,
        absoluteRoot,
      );

  return {
    root: 'computer',
    absoluteRoot,
    path: normalizePath(absoluteRoot, candidatePath),
  };
}

function requireComputerFileRoot(ctx: ComputerFileToolContext): string {
  const computerFileRoot = ctx.computerFileRoot?.trim();
  if (!computerFileRoot) {
    throw new FileAccessError(
      'access_denied',
      'computer filesystem is unavailable',
    );
  }
  return computerFileRoot;
}

function joinPortablePath(
  workingDirectory: string,
  inputPath: string,
  absoluteRoot: string,
): string {
  const pathModule = WINDOWS_ABSOLUTE_PATH.test(absoluteRoot) ? win32 : posix;
  return pathModule.join(workingDirectory, inputPath);
}

function isAbsolutePath(inputPath: string): boolean {
  return posix.isAbsolute(inputPath) || win32.isAbsolute(inputPath);
}
