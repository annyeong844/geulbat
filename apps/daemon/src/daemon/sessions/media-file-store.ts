import { createHash, randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { copyFile, mkdir, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';

import { isThreadMediaRef } from '@geulbat/protocol/artifacts';

import { assertSessionThreadId } from './contract.js';
import { threadMediaDirPath } from './paths.js';
import { hasErrorCode } from '../utils/error.js';

// 스레드 스코프 media 파일 스토어(video-generation-open §4.6) — 동영상처럼
// 스냅샷에 인라인할 수 없는 바이트를 <sha256>.<ext> 파일로 두고, 아티팩트
// payload는 mediaRef 매니페스트로만 가리킨다. 쓰기는 임시 파일 + rename으로
// 부분 파일이 mediaRef 이름으로 노출되지 않게 한다.

export type ThreadMediaExtension = 'mp4' | 'webm' | 'png' | 'jpg' | 'webp';

export class MediaFileTooLargeError extends Error {
  readonly byteLimit: number;

  constructor(byteLimit: number) {
    super(`media file exceeds the configured limit (${byteLimit} bytes)`);
    this.name = 'MediaFileTooLargeError';
    this.byteLimit = byteLimit;
  }
}

export interface WrittenThreadMediaFile {
  mediaRef: string;
  sha256: string;
  byteLength: number;
}

export async function writeThreadMediaFileFromStream(args: {
  workspaceRoot: string;
  threadId: string;
  extension: ThreadMediaExtension;
  stream: AsyncIterable<Uint8Array> | ReadableStream<Uint8Array>;
  maxBytes: number;
}): Promise<WrittenThreadMediaFile> {
  const mediaDir = threadMediaDirPath(args.workspaceRoot, args.threadId);
  await mkdir(mediaDir, { recursive: true });

  const tempPath = join(mediaDir, `${randomUUID()}.tmp`);
  const hash = createHash('sha256');
  let byteLength = 0;

  const sink = createWriteStream(tempPath, { flags: 'wx' });
  try {
    for await (const chunk of args.stream) {
      byteLength += chunk.byteLength;
      if (byteLength > args.maxBytes) {
        throw new MediaFileTooLargeError(args.maxBytes);
      }
      hash.update(chunk);
      if (!sink.write(chunk)) {
        await new Promise<void>((resolve, reject) => {
          sink.once('drain', resolve);
          sink.once('error', reject);
        });
      }
    }
    await new Promise<void>((resolve, reject) => {
      sink.end(() => resolve());
      sink.once('error', reject);
    });

    const sha256 = hash.digest('hex');
    const mediaRef = `${sha256}.${args.extension}`;
    const finalPath = join(mediaDir, mediaRef);
    // 같은 내용이 이미 있으면(sha 동일) rename이 덮어써도 내용은 동일하다
    await rename(tempPath, finalPath);
    return { mediaRef, sha256, byteLength };
  } catch (error: unknown) {
    sink.destroy();
    await rm(tempPath, { force: true });
    throw error;
  }
}

export async function writeThreadMediaFile(args: {
  workspaceRoot: string;
  threadId: string;
  extension: ThreadMediaExtension;
  bytes: Uint8Array;
  maxBytes: number;
}): Promise<WrittenThreadMediaFile> {
  return writeThreadMediaFileFromStream({
    workspaceRoot: args.workspaceRoot,
    threadId: args.threadId,
    extension: args.extension,
    stream: (async function* () {
      yield args.bytes;
    })(),
    maxBytes: args.maxBytes,
  });
}

// 서빙/복사용 절대 경로 해석 — mediaRef 형식 가드가 경로 탈출을 원천
// 차단한다(패턴 밖은 null). 존재 확인은 하지 않는다(호출자가 stat).
export function resolveThreadMediaFilePath(args: {
  workspaceRoot: string;
  threadId: string;
  mediaRef: string;
}): string | null {
  if (!isThreadMediaRef(args.mediaRef)) {
    return null;
  }
  return join(
    threadMediaDirPath(args.workspaceRoot, args.threadId),
    args.mediaRef,
  );
}

export async function statThreadMediaFile(args: {
  workspaceRoot: string;
  threadId: string;
  mediaRef: string;
}): Promise<{ path: string; byteLength: number } | null> {
  const filePath = resolveThreadMediaFilePath(args);
  if (filePath === null) {
    return null;
  }
  try {
    const stats = await stat(filePath);
    return stats.isFile() ? { path: filePath, byteLength: stats.size } : null;
  } catch (error: unknown) {
    if (hasErrorCode(error, 'ENOENT')) {
      return null;
    }
    throw error;
  }
}

// 브랜치 복제용 — 파일을 복사한다(§4.6 수명: 스레드 삭제 독립성 우선,
// dedupe는 보관함 스펙 비목표). 소스 파일이 없으면 참조가 이미 깨진
// 상태이므로 조용히 넘기지 않고 던진다(fail-closed).
export async function copyThreadMediaFiles(args: {
  workspaceRoot: string;
  sourceThreadId: string;
  targetThreadId: string;
  mediaRefs: readonly string[];
}): Promise<number> {
  if (args.mediaRefs.length === 0) {
    return 0;
  }
  const targetDir = threadMediaDirPath(args.workspaceRoot, args.targetThreadId);
  await mkdir(targetDir, { recursive: true });
  let copied = 0;
  for (const mediaRef of args.mediaRefs) {
    const sourcePath = resolveThreadMediaFilePath({
      workspaceRoot: args.workspaceRoot,
      threadId: args.sourceThreadId,
      mediaRef,
    });
    if (sourcePath === null) {
      throw new Error(`invalid thread media ref: ${mediaRef}`);
    }
    await copyFile(sourcePath, join(targetDir, mediaRef));
    copied += 1;
  }
  return copied;
}

export async function deleteThreadMediaDir(
  workspaceRoot: string,
  threadId: string,
): Promise<boolean> {
  const mediaDir = threadMediaDirPath(
    workspaceRoot,
    assertSessionThreadId(threadId),
  );
  try {
    await rm(mediaDir, { recursive: true, force: false });
    return true;
  } catch (error: unknown) {
    if (hasErrorCode(error, 'ENOENT')) {
      return false;
    }
    throw error;
  }
}
