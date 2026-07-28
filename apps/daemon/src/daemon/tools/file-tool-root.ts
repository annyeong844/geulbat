import { posix, win32 } from 'node:path';

import { FileAccessError } from '../files/file-domain-error.js';
import { normalizePath } from '../files/normalize-path.js';

const WINDOWS_ABSOLUTE_PATH = /^(?:[a-zA-Z]:[\\/]|\\\\)/;
const LOCAL_WSL_UNC_PATH =
  /^(?:\\\\|\/\/)(?:wsl\.localhost|wsl\$)[\\/]([^\\/]+)(?:[\\/](.*))?$/iu;

interface ComputerFileToolContext {
  computerFileRoot?: string;
  workingDirectory?: string;
}

interface ComputerFileToolPath {
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
  const projectedInputPath = projectLocalWslUncPath(absoluteRoot, inputPath);
  const projectedWorkingDirectory = projectLocalWslUncPath(
    absoluteRoot,
    ctx.workingDirectory ?? '',
  );
  const candidatePath = isAbsolutePath(projectedInputPath)
    ? projectedInputPath
    : joinPortablePath(
        normalizePath(absoluteRoot, projectedWorkingDirectory),
        projectedInputPath,
        absoluteRoot,
      );

  return {
    root: 'computer',
    absoluteRoot,
    path: normalizePath(absoluteRoot, candidatePath),
  };
}

function projectLocalWslUncPath(
  absoluteRoot: string,
  inputPath: string,
): string {
  if (process.platform !== 'linux' || !posix.isAbsolute(absoluteRoot)) {
    return inputPath;
  }

  const currentDistroName = process.env.WSL_DISTRO_NAME?.trim();
  const match = LOCAL_WSL_UNC_PATH.exec(inputPath);
  if (
    !currentDistroName ||
    !match ||
    match[1]?.toLowerCase() !== currentDistroName.toLowerCase()
  ) {
    return inputPath;
  }

  const pathWithinDistro = match[2]?.replaceAll('\\', '/') ?? '';
  return posix.resolve('/', pathWithinDistro);
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
