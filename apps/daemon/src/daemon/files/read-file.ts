import { createHash } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
import type { FileReadResponse } from './contract.js';
import {
  openReadHandle,
  resolveSourceReadTarget,
  type SourceReadTarget,
} from './file-platform.js';
import { createVersionToken } from './version-token.js';
import {
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

interface ReadFilePageCoordinates {
  offset: number;
  limit: number;
}

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
  const resolvedPath = await resolveReadTarget(workspaceRoot, relativePath);

  return readResolvedFile(resolvedPath, options);
}

export async function readFilePage(
  workspaceRoot: string,
  relativePath: string,
  page: ReadFilePageCoordinates,
): Promise<ReadFileResult> {
  const resolvedPath = await resolveReadTarget(workspaceRoot, relativePath);
  return readResolvedFilePage(resolvedPath, page);
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
  };
}

async function resolveReadTarget(
  workspaceRoot: string,
  relativePath: string,
): Promise<SourceReadTarget> {
  try {
    return await resolveSourceReadTarget(workspaceRoot, relativePath);
  } catch (err: unknown) {
    const code = getErrorCode(err);
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      throw FileAccessError.notFound(normalizeDisplayPath(relativePath));
    }
    throw err;
  }
}

async function readResolvedFilePage(
  resolvedPath: ResolvedReadPath,
  page: ReadFilePageCoordinates,
): Promise<ReadFileResult> {
  const canonicalAbsolutePath =
    resolvedPath.canonicalAbsolutePath ?? resolvedPath.absolutePath;
  try {
    const pageResult = await streamResolvedTextPage({
      canonicalAbsolutePath,
      limit: page.limit,
      offset: page.offset,
      relativePath: resolvedPath.relativePath,
    });
    return {
      path: resolvedPath.relativePath,
      content: pageResult.content,
      versionToken: pageResult.versionToken,
      totalLines: pageResult.totalLines,
      startLine: page.offset + 1,
      endLine: page.offset + pageResult.selectedLineCount,
    };
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

async function streamResolvedTextPage(args: {
  canonicalAbsolutePath: string;
  offset: number;
  limit: number;
  relativePath: string;
}): Promise<{
  content: string;
  selectedLineCount: number;
  totalLines: number;
  versionToken: string;
}> {
  const hash = createHash('sha256');
  const decoder = new StringDecoder('utf8');
  const accumulator = createTextPageAccumulator(args.offset, args.limit);
  const normalization = createStreamingTextNormalizationState();
  const readBuffer = Buffer.alloc(64 * 1024);
  let handle: Awaited<ReturnType<typeof openReadHandle>> | null = null;
  let sniffedBytes = 0;

  const processText = (text: string): void => {
    if (text === '') {
      return;
    }
    const normalized = normalizeStreamingTextChunk(text, normalization);
    if (normalized === '') {
      return;
    }
    hash.update(normalized, 'utf8');
    appendTextPageChunk(accumulator, normalized);
  };

  try {
    handle = await openReadHandle({
      canonicalAbsolutePath: args.canonicalAbsolutePath,
    });
    while (true) {
      const { bytesRead } = await handle.read(
        readBuffer,
        0,
        readBuffer.length,
        null,
      );
      if (bytesRead === 0) {
        break;
      }
      const chunk = readBuffer.subarray(0, bytesRead);
      if (sniffedBytes < 8192) {
        const sniffLength = Math.min(chunk.length, 8192 - sniffedBytes);
        if (isBinaryBuffer(chunk.subarray(0, sniffLength))) {
          throw FileAccessError.binaryFile(args.relativePath);
        }
        sniffedBytes += sniffLength;
      }
      processText(decoder.write(chunk));
    }
    processText(decoder.end());
    if (normalization.pendingCarriageReturn) {
      hash.update('\r', 'utf8');
      appendTextPageChunk(accumulator, '\r');
      normalization.pendingCarriageReturn = false;
    }
    finishTextPageAccumulator(accumulator);
  } finally {
    await handle?.close();
  }

  return {
    content: buildSelectedPageContent(accumulator),
    selectedLineCount: accumulator.selectedLines.length,
    totalLines: accumulator.totalLines,
    versionToken: hash.digest('hex'),
  };
}

interface StreamingTextNormalizationState {
  atStart: boolean;
  pendingCarriageReturn: boolean;
}

function createStreamingTextNormalizationState(): StreamingTextNormalizationState {
  return {
    atStart: true,
    pendingCarriageReturn: false,
  };
}

function normalizeStreamingTextChunk(
  chunk: string,
  state: StreamingTextNormalizationState,
): string {
  let text = chunk;
  if (state.pendingCarriageReturn) {
    text = `\r${text}`;
    state.pendingCarriageReturn = false;
  }
  if (state.atStart && text.length > 0) {
    state.atStart = false;
    text = text.replace(/^\uFEFF/, '');
  }
  if (text.endsWith('\r')) {
    text = text.slice(0, -1);
    state.pendingCarriageReturn = true;
  }
  return text.replace(/\r\n/g, '\n');
}

interface TextPageAccumulator {
  currentLine: string;
  currentLineHasContent: boolean;
  lineEndOffset: number;
  lineIndex: number;
  offset: number;
  selectedLines: string[];
  totalLines: number;
}

function createTextPageAccumulator(
  offset: number,
  limit: number,
): TextPageAccumulator {
  return {
    currentLine: '',
    currentLineHasContent: false,
    lineEndOffset: offset + limit,
    lineIndex: 0,
    offset,
    selectedLines: [],
    totalLines: 0,
  };
}

function appendTextPageChunk(
  accumulator: TextPageAccumulator,
  chunk: string,
): void {
  let cursor = 0;
  while (true) {
    const newlineIndex = chunk.indexOf('\n', cursor);
    if (newlineIndex === -1) {
      appendTextPageSegment(accumulator, chunk.slice(cursor));
      return;
    }

    appendTextPageSegment(accumulator, chunk.slice(cursor, newlineIndex));
    commitTextPageLine(accumulator);
    cursor = newlineIndex + 1;
  }
}

function appendTextPageSegment(
  accumulator: TextPageAccumulator,
  segment: string,
): void {
  if (segment.length > 0) {
    accumulator.currentLineHasContent = true;
  }
  if (
    accumulator.lineIndex >= accumulator.offset &&
    accumulator.lineIndex < accumulator.lineEndOffset
  ) {
    accumulator.currentLine += segment;
  }
}

function commitTextPageLine(accumulator: TextPageAccumulator): void {
  if (
    accumulator.lineIndex >= accumulator.offset &&
    accumulator.lineIndex < accumulator.lineEndOffset
  ) {
    accumulator.selectedLines.push(accumulator.currentLine);
    accumulator.currentLine = '';
  }
  accumulator.currentLineHasContent = false;
  accumulator.totalLines += 1;
  accumulator.lineIndex += 1;
}

function finishTextPageAccumulator(accumulator: TextPageAccumulator): void {
  if (accumulator.currentLineHasContent) {
    commitTextPageLine(accumulator);
  }
}

function buildSelectedPageContent(accumulator: TextPageAccumulator): string {
  return (
    accumulator.selectedLines.join('\n') +
    (accumulator.selectedLines.length > 0 ? '\n' : '')
  );
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
