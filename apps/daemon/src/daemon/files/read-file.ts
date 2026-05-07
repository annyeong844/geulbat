import type { FileReadResponse } from '@geulbat/protocol/files';
import {
  openReadHandle,
  resolveSourceReadTarget,
  type SourceReadTarget,
} from './file-platform.js';
import { createVersionToken } from './version-token.js';
import {
  MAX_TEXT_FILE_SIZE_BYTES,
  countTextLines,
  decodeTextBuffer,
  isBinaryBuffer,
} from './text-content.js';
import { getErrorCode } from '../utils/error.js';
import { FileAccessError } from './file-domain-error.js';
import type { FileStateCache } from '../utils/file-state-cache.js';

export type ReadFileResult = FileReadResponse;

type ResolvedReadPath = Pick<
  SourceReadTarget,
  'relativePath' | 'absolutePath' | 'canonicalAbsolutePath'
>;

interface ReadFileOptions {
  fileStateCache?: FileStateCache;
}

/**
 * Read a text file within the workspace boundary.
 * Rejects binary files, reserved paths, and workspace escapes.
 */
export async function readFile(
  workspaceRoot: string,
  relativePath: string,
  options: ReadFileOptions = {},
): Promise<ReadFileResult> {
  let resolvedPath: SourceReadTarget;
  try {
    resolvedPath = await resolveSourceReadTarget(workspaceRoot, relativePath);
  } catch (err: unknown) {
    const code = getErrorCode(err);
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      throw FileAccessError.notFound(normalizeDisplayPath(relativePath));
    }
    throw err;
  }

  return readResolvedFile(resolvedPath, options);
}

export async function readResolvedFile(
  resolvedPath: ResolvedReadPath,
  options: ReadFileOptions = {},
): Promise<ReadFileResult> {
  const { relativePath } = resolvedPath;
  const content = await readResolvedTextContent(resolvedPath, options);
  const versionToken = createVersionToken(content);
  const totalLines = countTextLines(content);

  return {
    path: relativePath,
    content,
    versionToken,
    totalLines,
    startLine: 1,
    endLine: totalLines,
    truncated: false,
  };
}

async function readResolvedTextContent(
  resolvedPath: ResolvedReadPath,
  options: ReadFileOptions,
): Promise<string> {
  const canonicalAbsolutePath =
    resolvedPath.canonicalAbsolutePath ?? resolvedPath.absolutePath;
  try {
    return options.fileStateCache
      ? await options.fileStateCache.read(canonicalAbsolutePath, (cacheKey) =>
          loadResolvedTextContent(cacheKey, resolvedPath.relativePath),
        )
      : await loadResolvedTextContent(
          canonicalAbsolutePath,
          resolvedPath.relativePath,
        );
  } catch (err: unknown) {
    const code = getErrorCode(err);
    if (code === 'ENOENT') {
      throw FileAccessError.notFound(resolvedPath.relativePath);
    }
    if (code === 'EISDIR') {
      throw FileAccessError.directoryPath(resolvedPath.relativePath);
    }
    throw err;
  }
}

async function loadResolvedTextContent(
  canonicalAbsolutePath: string,
  relativePath: string,
): Promise<string> {
  let handle: Awaited<ReturnType<typeof openReadHandle>> | null = null;
  let buf: Buffer;
  try {
    handle = await openReadHandle({
      canonicalAbsolutePath,
    });
    buf = await handle.readFile();
  } finally {
    await handle?.close();
  }

  if (buf.length > MAX_TEXT_FILE_SIZE_BYTES) {
    throw FileAccessError.tooLarge(relativePath, buf.length);
  }

  if (isBinaryBuffer(buf)) {
    throw FileAccessError.binaryFile(relativePath);
  }

  return decodeTextBuffer(buf);
}

function normalizeDisplayPath(value: string): string {
  const normalized = String(value ?? '')
    .replace(/\\/g, '/')
    .replace(/^(?:\.\/)+/, '');
  return normalized === '' ? '.' : normalized;
}
