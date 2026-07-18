import { randomUUID } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import {
  copyFile,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';

import type { RunAttachmentInput } from '@geulbat/protocol/run-contract';
import { createLogger } from '@geulbat/shared-utils/logger';

import {
  claimFileBinaryInputRefPath,
  deleteFileBinaryInputRefPath,
} from '../../../daemon/files/binary-input-ref-store.js';
import { extractAttachmentText } from '../../../daemon/files/attachment-text-extract.js';
import {
  RUN_ATTACHMENT_IMAGE_INLINE_MAX_BYTES,
  RUN_ATTACHMENT_MAX_BYTES,
  RUN_ATTACHMENT_MAX_COUNT,
  RUN_ATTACHMENT_PDF_INLINE_MAX_BYTES,
  RUN_ATTACHMENT_TEXT_EXTRACT_MAX_BYTES,
  RUN_ATTACHMENT_TEXT_INLINE_MAX_CHARS,
  RUN_ATTACHMENT_WORKSPACE_DIR,
  type ResolvedRunAttachment,
} from '../../../daemon/agent/run-attachments.js';
import { getErrorCode, hasErrorCode } from '../../../daemon/utils/error.js';

const logger = createLogger('run-channel/attachments');

const PDF_MIME_TYPE = 'application/pdf';

type ResolveRunAttachmentsResult =
  | { ok: true; attachments: ResolvedRunAttachment[] }
  | {
      ok: false;
      status: 400 | 404 | 409;
      code: 'bad_request' | 'conflict' | 'not_found';
      message: string;
    };

// 업로드된 binary-input ref들을 실제 첨부로 확정한다. ref 파일은 여기서
// 소비되므로(읽거나 작업 폴더로 commit) 실패해도 재사용할 수 없다 —
// 셸은 다시 업로드한다.
export async function resolveRunAttachments(
  inputs: RunAttachmentInput[] | undefined,
  args: { workspaceRoot: string },
): Promise<ResolveRunAttachmentsResult> {
  if (inputs === undefined || inputs.length === 0) {
    return { ok: true, attachments: [] };
  }
  if (inputs.length > RUN_ATTACHMENT_MAX_COUNT) {
    await discardAttachmentRefs(inputs, args);
    return {
      ok: false,
      status: 400,
      code: 'bad_request',
      message: `첨부는 한 번에 ${RUN_ATTACHMENT_MAX_COUNT}개까지입니다`,
    };
  }

  const attachments: ResolvedRunAttachment[] = [];
  for (const [index, input] of inputs.entries()) {
    const claimed = await claimFileBinaryInputRefPath({
      workspaceRoot: args.workspaceRoot,
      contentRef: input.contentRef,
    });
    if (!claimed.ok) {
      await discardAttachmentRefs(inputs.slice(index + 1), args);
      return {
        ok: false,
        status:
          claimed.code === 'bad_request'
            ? 400
            : claimed.code === 'conflict'
              ? 409
              : 404,
        code: claimed.code,
        message: `첨부 ${input.name}: ${claimed.message}`,
      };
    }

    const resolved = await resolveOneAttachment(input, claimed.path, {
      workspaceRoot: args.workspaceRoot,
    });
    if (!resolved.ok) {
      await deleteConsumedAttachmentRef(claimed.path, input.contentRef);
      await discardAttachmentRefs(inputs.slice(index + 1), args);
      return resolved;
    }
    attachments.push(resolved.attachment);
  }
  return { ok: true, attachments };
}

// 시작 요청이 거부되면 남은 ref는 재사용 경로가 없다 — 셸은 칩을 비우고
// 다시 업로드하므로, 여기서 지워 고아 blob이 디스크에 남지 않게 한다.
async function discardAttachmentRefs(
  inputs: RunAttachmentInput[],
  args: { workspaceRoot: string },
): Promise<void> {
  for (const input of inputs) {
    const claimed = await claimFileBinaryInputRefPath({
      workspaceRoot: args.workspaceRoot,
      contentRef: input.contentRef,
    });
    if (claimed.ok) {
      await deleteConsumedAttachmentRef(claimed.path, input.contentRef);
    }
  }
}

type ResolveOneResult =
  | { ok: true; attachment: ResolvedRunAttachment }
  | {
      ok: false;
      status: 400;
      code: 'bad_request';
      message: string;
    };

async function resolveOneAttachment(
  input: RunAttachmentInput,
  refPath: string,
  args: { workspaceRoot: string },
): Promise<ResolveOneResult> {
  const mimeType = (input.mimeType ?? '').trim().toLowerCase();
  const { size } = await stat(refPath);
  if (size > RUN_ATTACHMENT_MAX_BYTES) {
    return {
      ok: false,
      status: 400,
      code: 'bad_request',
      message: `파일이 너무 큽니다 (최대 ${Math.floor(RUN_ATTACHMENT_MAX_BYTES / (1024 * 1024))}MB): ${input.name}`,
    };
  }

  // 프로바이더가 네이티브로 이해하는 형식은 바이트를 그대로 인라인한다
  if (
    mimeType.startsWith('image/') &&
    size <= RUN_ATTACHMENT_IMAGE_INLINE_MAX_BYTES
  ) {
    const bytes = await readFile(refPath);
    await deleteConsumedAttachmentRef(refPath, input.contentRef);
    return {
      ok: true,
      attachment: { name: input.name, mimeType, kind: 'image', bytes },
    };
  }
  if (
    (mimeType === PDF_MIME_TYPE || input.name.toLowerCase().endsWith('.pdf')) &&
    size <= RUN_ATTACHMENT_PDF_INLINE_MAX_BYTES
  ) {
    const bytes = await readFile(refPath);
    await deleteConsumedAttachmentRef(refPath, input.contentRef);
    return {
      ok: true,
      attachment: {
        name: input.name,
        mimeType: PDF_MIME_TYPE,
        kind: 'pdf',
        bytes,
      },
    };
  }

  // 본문 추출은 파일 전체를 메모리에 올린다 — 상한을 넘는 파일은 읽지 않고
  // 원본 보관 경로(streamed filesystem copy, 메모리 0)로 바로 보낸다. 업로드 자체는 512MB까지
  // 그대로 받는다.
  if (size > RUN_ATTACHMENT_TEXT_EXTRACT_MAX_BYTES) {
    return storeOriginalAsWorkspaceAttachment(input, refPath, {
      workspaceRoot: args.workspaceRoot,
      size,
      mimeType,
      reason: `파일이 커서(본문 자동 추출 한도 ${Math.floor(RUN_ATTACHMENT_TEXT_EXTRACT_MAX_BYTES / (1024 * 1024))}MB 초과) 본문을 인라인하지 않았습니다.`,
    });
  }

  // 그 외 형식은 본문 추출 파이프라인으로 소화한다 (txt/md/docx/xlsx/hwpx…
  // — 새 포맷은 attachment-text-extract에 추출기만 추가하면 된다)
  const bytes = await readFile(refPath);
  const extracted = extractAttachmentText(input.name, bytes);

  if (extracted !== null) {
    await deleteConsumedAttachmentRef(refPath, input.contentRef);
    if (extracted.length <= RUN_ATTACHMENT_TEXT_INLINE_MAX_CHARS) {
      return {
        ok: true,
        attachment: {
          name: input.name,
          mimeType: mimeType || 'text/plain',
          kind: 'text',
          bytes: Buffer.from(extracted, 'utf8'),
        },
      };
    }
    // 컨텍스트를 넘는 본문 — 앞부분을 인라인하고 전체 추출본은 작업 폴더
    // 사본으로 남긴다. 어시스턴트가 도구로 이어 읽어 스스로 소화한다.
    const sidecarPath = await writeWorkspaceAttachmentFile({
      workspaceRoot: args.workspaceRoot,
      name: buildSidecarFileName(input.name),
      content: Buffer.from(extracted, 'utf8'),
    });
    const head = extracted.slice(0, RUN_ATTACHMENT_TEXT_INLINE_MAX_CHARS);
    const note = [
      `(첨부 본문이 길어 앞부분만 여기 실려 있습니다. 전체 추출본: "${sidecarPath}" —`,
      '나머지가 필요하면 read_file/search_files 도구로 어시스턴트가 직접 이어 읽고,',
      '사용자에게 파일을 읽으라고 안내하지 마세요.)',
    ].join(' ');
    return {
      ok: true,
      attachment: {
        name: input.name,
        mimeType: mimeType || 'text/plain',
        kind: 'text',
        bytes: Buffer.from(
          `${note}\n\n${head}\n\n…(이후 ${extracted.length - head.length}자 생략)`,
          'utf8',
        ),
      },
    };
  }

  // 본문 추출이 아직 안 되는 형식 — 원본 보관 경로로 보낸다.
  return storeOriginalAsWorkspaceAttachment(input, refPath, {
    workspaceRoot: args.workspaceRoot,
    size,
    mimeType,
    reason: '이 형식은 아직 본문 자동 추출을 지원하지 않습니다.',
  });
}

// 원본을 작업 폴더로 옮기고(즉시 rename) 어시스턴트가 도구로 직접
// 분석하도록 지시한다 — 인라인 불가 사유만 다르고 처리 방식은 같다.
async function storeOriginalAsWorkspaceAttachment(
  input: RunAttachmentInput,
  refPath: string,
  args: {
    workspaceRoot: string;
    size: number;
    mimeType: string;
    reason: string;
  },
): Promise<ResolveOneResult> {
  const savedPath = await moveIntoWorkspaceAttachments({
    refPath,
    workspaceRoot: args.workspaceRoot,
    name: input.name,
    contentRef: input.contentRef,
  });
  const sizeMb = (args.size / (1024 * 1024)).toFixed(1);
  const note = [
    `[첨부: ${input.name} (${sizeMb}MB${args.mimeType ? `, ${args.mimeType}` : ''})]`,
    `${args.reason} 원본 사본이 "${savedPath}"에 있습니다.`,
    '내용 확인이 필요하면 어시스턴트가 도구(read_file/exec 등)로 직접 분석해 결과만 전하세요.',
    '사용자에게 파일을 직접 읽으라고 안내하지 마세요.',
  ].join('\n');
  return {
    ok: true,
    attachment: {
      name: input.name,
      mimeType: 'text/plain',
      kind: 'text',
      bytes: Buffer.from(note, 'utf8'),
    },
  };
}

// 파일명에서 경로 성분 제거 — 브라우저 File.name엔 없지만 계약상 방어
function sanitizeAttachmentFileName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? 'attachment';
  const trimmed = base.trim();
  return trimmed === '' || trimmed === '.' || trimmed === '..'
    ? 'attachment'
    : trimmed;
}

function buildSidecarFileName(name: string): string {
  const safe = sanitizeAttachmentFileName(name);
  return `${safe}.추출.txt`;
}

// 작업 폴더 첨부 디렉터리에 빈 이름을 선점한다("이름 (n)" 순회, 덮어쓰기
// 없음). 기존 이름은 디렉터리 snapshot에서 건너뛰고, 동시 생성 경합은
// atomic `wx`의 EEXIST로만 재시도한다. 성공하면 workspace 상대 경로를 돌려준다.
async function allocateWorkspaceAttachmentPath(args: {
  workspaceRoot: string;
  name: string;
}): Promise<{ relativePath: string; absolutePath: string }> {
  const safeName = sanitizeAttachmentFileName(args.name);
  const dir = join(args.workspaceRoot, RUN_ATTACHMENT_WORKSPACE_DIR);
  await mkdir(dir, { recursive: true });

  const dotIndex = safeName.lastIndexOf('.');
  const base = dotIndex > 0 ? safeName.slice(0, dotIndex) : safeName;
  const ext = dotIndex > 0 ? safeName.slice(dotIndex) : '';
  const occupiedNames = new Set(await readdir(dir));
  let collisionIndex = 0;
  while (true) {
    const candidate =
      collisionIndex === 0 ? safeName : `${base} (${collisionIndex})${ext}`;
    if (occupiedNames.has(candidate)) {
      collisionIndex += 1;
      continue;
    }
    const absolutePath = join(dir, candidate);
    try {
      const handle = await open(absolutePath, 'wx');
      await handle.close();
      return {
        relativePath: `${RUN_ATTACHMENT_WORKSPACE_DIR}/${candidate}`,
        absolutePath,
      };
    } catch (error: unknown) {
      if (!hasErrorCode(error, 'EEXIST')) {
        throw error;
      }
      occupiedNames.add(candidate);
      collisionIndex += 1;
    }
  }
}

async function moveIntoWorkspaceAttachments(args: {
  refPath: string;
  workspaceRoot: string;
  name: string;
  contentRef: string;
}): Promise<string> {
  const allocated = await allocateWorkspaceAttachmentPath(args);
  const tempPath = `${allocated.absolutePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await copyFile(args.refPath, tempPath, fsConstants.COPYFILE_EXCL);
    const handle = await open(tempPath, 'r');
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(tempPath, allocated.absolutePath);
  } catch (error: unknown) {
    await rm(tempPath, { force: true });
    await rm(allocated.absolutePath, { force: true });
    throw error;
  }
  await deleteConsumedAttachmentRef(args.refPath, args.contentRef);
  return allocated.relativePath;
}

async function writeWorkspaceAttachmentFile(args: {
  workspaceRoot: string;
  name: string;
  content: Buffer;
}): Promise<string> {
  const allocated = await allocateWorkspaceAttachmentPath(args);
  await writeFile(allocated.absolutePath, args.content);
  return allocated.relativePath;
}

async function deleteConsumedAttachmentRef(
  path: string,
  contentRef: string,
): Promise<void> {
  try {
    await deleteFileBinaryInputRefPath(path);
  } catch (error: unknown) {
    logger.warn('failed to delete consumed attachment ref:', {
      contentRef,
      code: getErrorCode(error) ?? 'unknown',
    });
  }
}
