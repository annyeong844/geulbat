import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';

import {
  enumerateCanonicalChildren,
  resolveSourceDirectoryTarget,
  resolveSourceReadTarget,
  type SourceDirectoryTarget,
} from '../files/file-platform.js';
import { shouldExcludeWorkspaceEntry } from '../files/reserved-paths.js';
import { createVersionToken } from '../files/version-token.js';
import { decodeTextBuffer, isBinaryBuffer } from '../files/text-content.js';
import { getErrorCode } from '../utils/error.js';

const EXCLUDED_DIRECTORY_NAMES = new Set([
  'dist',
  'build',
  '.next',
  'coverage',
]);

const EXCLUDED_FILE_NAMES = new Set([
  'package-lock.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'bun.lockb',
  'npm-shrinkwrap.json',
  '.env',
]);

const EXCLUDED_FILE_SUFFIXES = ['.log', '.lock'];

export interface SourceFileData {
  path: string;
  sourceVersionToken: string;
  updatedAt: string;
  content: string;
  lines: string[];
}

export interface SourceSnapshot {
  files: SourceFileData[];
  sourceIndexVersionToken: string;
}

export async function buildSourceSnapshot(
  workspaceRoot: string,
): Promise<SourceSnapshot> {
  const candidatePaths = await collectCandidatePaths(workspaceRoot);
  const files: SourceFileData[] = [];

  for (const relativePath of candidatePaths) {
    const sourceFile = await loadSourceFile(workspaceRoot, relativePath);
    if (!sourceFile) {
      continue;
    }
    files.push(sourceFile);
  }

  return {
    files,
    sourceIndexVersionToken: createSourceIndexVersionToken(files),
  };
}

async function collectCandidatePaths(workspaceRoot: string): Promise<string[]> {
  const results: string[] = [];
  const rootTarget = await resolveSourceDirectoryTarget(workspaceRoot, '.');
  if (!rootTarget.exists) {
    return results;
  }
  await walkDirectory(rootTarget, results);
  results.sort((a, b) => a.localeCompare(b));
  return results;
}

async function walkDirectory(
  target: SourceDirectoryTarget,
  results: string[],
): Promise<void> {
  const entries = await enumerateCanonicalChildren(target);

  for (const entry of entries) {
    const relativePath = entry.relativePath;
    if (
      shouldExcludePath(relativePath, entry.name, entry.type === 'directory')
    ) {
      continue;
    }

    if (entry.type === 'directory') {
      if (entry.viaSymlink) {
        continue;
      }
      await walkDirectory(
        {
          ...target,
          requestedRelativePath: relativePath,
          relativePath,
          canonicalAbsolutePath: entry.canonicalAbsolutePath,
          absolutePath: entry.canonicalAbsolutePath,
          exists: true,
        },
        results,
      );
      continue;
    }

    if (entry.viaSymlink) {
      continue;
    }

    if (entry.type === 'file') {
      results.push(relativePath);
    }
  }
}

function shouldExcludePath(
  relativePath: string,
  entryName: string,
  isDirectory: boolean,
): boolean {
  if (isDirectory) {
    return (
      shouldExcludeWorkspaceEntry(relativePath, entryName) ||
      EXCLUDED_DIRECTORY_NAMES.has(entryName)
    );
  }

  if (EXCLUDED_FILE_NAMES.has(entryName)) {
    return true;
  }

  if (entryName === '.env' || entryName.startsWith('.env.')) {
    return true;
  }

  return EXCLUDED_FILE_SUFFIXES.some((suffix) => entryName.endsWith(suffix));
}

async function loadSourceFile(
  workspaceRoot: string,
  relativePath: string,
): Promise<SourceFileData | null> {
  let resolvedTarget: Awaited<ReturnType<typeof resolveSourceReadTarget>>;
  try {
    resolvedTarget = await resolveSourceReadTarget(workspaceRoot, relativePath);
  } catch (error: unknown) {
    const code = getErrorCode(error);
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      return null;
    }
    throw error;
  }

  let fileStat;
  try {
    fileStat = await stat(resolvedTarget.absolutePath);
  } catch (error: unknown) {
    const code = getErrorCode(error);
    if (code === 'ENOENT') {
      return null;
    }
    throw error;
  }

  const buf = await readFile(resolvedTarget.absolutePath);
  if (isBinaryBuffer(buf)) {
    return null;
  }

  const content = decodeTextBuffer(buf);
  const lines = splitLinesForMemory(content);

  return {
    path: relativePath,
    sourceVersionToken: createVersionToken(content),
    updatedAt: fileStat.mtime.toISOString(),
    content,
    lines,
  };
}

function createSourceIndexVersionToken(
  files: Array<{ path: string; sourceVersionToken: string }>,
): string {
  const hash = createHash('sha256');
  for (const file of files) {
    hash.update(file.path, 'utf8');
    hash.update('\0', 'utf8');
    hash.update(file.sourceVersionToken, 'utf8');
    hash.update('\n', 'utf8');
  }
  return hash.digest('hex');
}

function splitLinesForMemory(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') {
    lines.pop();
  }
  return lines;
}
