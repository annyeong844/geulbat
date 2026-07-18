import { posix, win32 } from 'node:path';

function isWindowsRipgrepBinary(rgPath: string): boolean {
  return rgPath.toLowerCase().endsWith('.exe');
}

function isWindowsFsPath(filePath: string): boolean {
  return /^[a-z]:[\\/]/i.test(filePath);
}

export function toRipgrepFsPath(filePath: string, rgPath: string): string {
  if (!isWindowsRipgrepBinary(rgPath)) {
    return filePath;
  }

  const match = /^\/mnt\/([a-z])\/(.*)$/i.exec(filePath);
  if (!match) {
    return filePath;
  }

  return `${match[1]?.toUpperCase()}:\\${(match[2] ?? '').replace(/\//g, '\\')}`;
}

export function fromRipgrepFsPath(
  filePath: string,
  rgPath: string,
  workspaceRoot: string,
): string {
  if (!isWindowsRipgrepBinary(rgPath)) {
    return filePath;
  }

  return fromWindowsFsPath(filePath, workspaceRoot);
}

export function fromWindowsFsPath(
  filePath: string,
  workspaceRoot: string,
): string {
  const match = /^([a-z]):\\(.*)$/i.exec(filePath);
  if (!match) {
    return filePath;
  }

  if (isWindowsFsPath(workspaceRoot)) {
    return filePath;
  }

  return `/mnt/${match[1]?.toLowerCase()}/${(match[2] ?? '').replace(/\\/g, '/')}`;
}

export function toWorkspaceRelativeSearchPath(
  workspaceRoot: string,
  absPath: string,
): string {
  if (isWindowsFsPath(workspaceRoot) || isWindowsFsPath(absPath)) {
    return win32.relative(workspaceRoot, absPath).split(win32.sep).join('/');
  }
  return posix.relative(workspaceRoot, absPath).split(posix.sep).join('/');
}
