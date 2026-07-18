import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { joinWorkspaceGeulbatPath } from '../files/geulbat-internal-paths.js';
import { hasErrorCode } from '../utils/error.js';
import { assertSessionThreadId as assertValidThreadId } from './contract.js';

// 사용자 업로드 첨부의 바이트 저장소 — 트랜스크립트에는 참조(metadata)만
// 남기고 바이트는 여기 둔다. 히스토리 재구성 때 다시 읽어 모델에 전달한다.

const ATTACHMENT_ID_PATTERN = /^[0-9a-f-]{36}$/;

export function createRunAttachmentId(): string {
  return randomUUID();
}

function threadAttachmentsDirPath(
  workspaceRoot: string,
  threadId: string,
): string {
  return join(
    joinWorkspaceGeulbatPath(workspaceRoot, 'sessions'),
    `${assertValidThreadId(threadId)}.attachments`,
  );
}

function attachmentFilePath(
  workspaceRoot: string,
  threadId: string,
  attachmentId: string,
): string {
  if (!ATTACHMENT_ID_PATTERN.test(attachmentId)) {
    // 손으로 고친 트랜스크립트의 경로 탈출 방지 — id 형식이 아니면 거부
    throw new Error(`invalid attachment id: ${attachmentId}`);
  }
  return join(
    threadAttachmentsDirPath(workspaceRoot, threadId),
    `${attachmentId}.bin`,
  );
}

export async function writeRunAttachment(args: {
  workspaceRoot: string;
  threadId: string;
  attachmentId: string;
  bytes: Buffer;
}): Promise<void> {
  const path = attachmentFilePath(
    args.workspaceRoot,
    args.threadId,
    args.attachmentId,
  );
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, args.bytes, { flag: 'wx' });
}

export async function deleteThreadRunAttachments(args: {
  workspaceRoot: string;
  threadId: string;
}): Promise<boolean> {
  try {
    await rm(threadAttachmentsDirPath(args.workspaceRoot, args.threadId), {
      recursive: true,
      force: false,
    });
    return true;
  } catch (error: unknown) {
    if (hasErrorCode(error, 'ENOENT')) {
      return false;
    }
    throw error;
  }
}

export async function readRunAttachment(args: {
  workspaceRoot: string;
  threadId: string;
  attachmentId: string;
}): Promise<Buffer | null> {
  try {
    return await readFile(
      attachmentFilePath(args.workspaceRoot, args.threadId, args.attachmentId),
    );
  } catch (error: unknown) {
    if (hasErrorCode(error, 'ENOENT')) {
      return null;
    }
    throw error;
  }
}
