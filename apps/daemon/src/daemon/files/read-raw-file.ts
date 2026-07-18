import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import type { Readable } from 'node:stream';

import { FileAccessError } from './file-domain-error.js';
import { openReadHandle, resolveSourceReadTarget } from './file-platform.js';
import { getErrorCode } from '../utils/error.js';

// 미리보기(이미지 등) 용도의 원본 바이트 읽기 상한 — 초과분은 셸이
// 미리보기 미지원으로 안내한다.
const MAX_RAW_READ_BYTES = 32 * 1024 * 1024;

interface RawFileReadResult {
  bytes: Buffer;
  byteLength: number;
}

/**
 * Read raw bytes from any OS-accessible host path. Unlike text reads, binary
 * content is accepted.
 */
export async function readRawFile(
  workspaceRoot: string,
  relativePath: string,
): Promise<RawFileReadResult> {
  const target = await resolveSourceReadTarget(workspaceRoot, relativePath);
  let handle;
  try {
    handle = await openReadHandle(target);
  } catch (err: unknown) {
    if (getErrorCode(err) === 'ENOENT') {
      throw FileAccessError.notFound(target.relativePath);
    }
    throw err;
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) {
      throw FileAccessError.notFound(target.relativePath);
    }
    if (stat.size > MAX_RAW_READ_BYTES) {
      throw new FileAccessError(
        'buffer_limit_exceeded',
        `file exceeds raw read limit: ${target.relativePath}`,
        target.relativePath,
      );
    }
    const bytes = await handle.readFile();
    return { bytes, byteLength: bytes.byteLength };
  } finally {
    await handle.close();
  }
}

export class UnsatisfiableRangeError extends FileAccessError {
  readonly totalSize: number;

  constructor(relativePath: string, totalSize: number) {
    super(
      'bad_request',
      `unsatisfiable byte range for ${relativePath}`,
      relativePath,
    );
    this.name = 'UnsatisfiableRangeError';
    this.totalSize = totalSize;
  }
}

interface RawFileStream {
  stream: Readable;
  totalSize: number;
  // 요청 구간 (전체 스트림이면 0..totalSize-1)
  start: number;
  end: number;
}

/**
 * Raw bytes as a stream — 미디어 재생/구간 탐색용. 같은 boundary 검증을
 * 거치며, 버퍼 상한 대신 스트리밍이라 파일 크기 제한이 없다.
 * range가 주어지면 해당 바이트 구간만 흘려보낸다(HTTP Range 대응).
 */
export async function createRawFileStream(
  workspaceRoot: string,
  relativePath: string,
  range?: { start: number; end?: number },
): Promise<RawFileStream> {
  const target = await resolveSourceReadTarget(workspaceRoot, relativePath);
  const absolutePath = target.canonicalAbsolutePath ?? target.absolutePath;
  let fileStat;
  try {
    fileStat = await stat(absolutePath);
  } catch (err: unknown) {
    if (getErrorCode(err) === 'ENOENT') {
      throw FileAccessError.notFound(target.relativePath);
    }
    throw err;
  }
  if (!fileStat.isFile()) {
    throw FileAccessError.notFound(target.relativePath);
  }
  const totalSize = fileStat.size;
  const start = range?.start ?? 0;
  const end = Math.min(range?.end ?? totalSize - 1, totalSize - 1);
  if (totalSize === 0 || start > end || start >= totalSize) {
    throw new UnsatisfiableRangeError(target.relativePath, totalSize);
  }
  return {
    stream: createReadStream(absolutePath, { start, end }),
    totalSize,
    start,
    end,
  };
}
