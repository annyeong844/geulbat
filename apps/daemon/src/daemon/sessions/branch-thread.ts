import { randomUUID } from 'node:crypto';

import { createLogger } from '@geulbat/shared-utils/logger';

import { assertSessionThreadId, type ThreadId } from './contract.js';
import {
  collectTranscriptArtifactRefs,
  copyThreadArtifactVersionsByRefs,
} from './artifact-store.js';
import {
  readRunAttachment,
  writeRunAttachment,
} from './run-attachment-store.js';
import { loadThreadIndex, upsertThreadSummary } from './threads-index.js';
import {
  readTranscriptEntries,
  replaceTranscriptEntries,
  type TranscriptEntry,
} from './transcript-log.js';

const logger = createLogger('sessions/branch-thread');

type BranchThreadSessionResult =
  | { ok: true; threadId: ThreadId; copiedMessageCount: number }
  | { ok: false; code: 'not_found'; message: string };

// 스레드 브랜치 — 원 스레드 transcript의 앞부분(prefix)을 새 스레드로
// 복제한다. 원 스레드는 불변. entryId를 보존하므로 복사된 메시지의
// artifact/첨부 참조가 그대로 유효하다. tool outputs 등 실행 산출물은
// v1에서 복사하지 않는다(대화 맥락은 transcript가 담는다).
export async function branchThreadSession(args: {
  workspaceRoot: string;
  sourceThreadId: ThreadId;
  // 이 entryId를 포함한 앞부분까지 복사. 생략하면 전체 복제.
  upToEntryId?: string;
}): Promise<BranchThreadSessionResult> {
  const sourceEntries = await readTranscriptEntries(
    args.workspaceRoot,
    args.sourceThreadId,
  );
  if (sourceEntries.length === 0) {
    return {
      ok: false,
      code: 'not_found',
      message: `thread has no transcript to branch: ${args.sourceThreadId}`,
    };
  }

  let copiedEntries: TranscriptEntry[];
  if (args.upToEntryId === undefined) {
    copiedEntries = [...sourceEntries];
  } else {
    const cutIndex = sourceEntries.findIndex(
      (entry) => entry.entryId === args.upToEntryId,
    );
    if (cutIndex < 0) {
      return {
        ok: false,
        code: 'not_found',
        message: `entry not found in thread: ${args.upToEntryId}`,
      };
    }
    copiedEntries = sourceEntries.slice(0, cutIndex + 1);
  }

  const branchedThreadId = assertSessionThreadId(randomUUID());
  await replaceTranscriptEntries(
    args.workspaceRoot,
    branchedThreadId,
    copiedEntries,
  );
  await copyThreadArtifactVersionsByRefs({
    workspaceRoot: args.workspaceRoot,
    sourceThreadId: args.sourceThreadId,
    targetThreadId: branchedThreadId,
    refs: collectTranscriptArtifactRefs(copiedEntries),
  });
  await copyReferencedRunAttachments({
    workspaceRoot: args.workspaceRoot,
    sourceThreadId: args.sourceThreadId,
    targetThreadId: branchedThreadId,
    entries: copiedEntries,
  });
  await upsertThreadSummary(args.workspaceRoot, {
    threadId: branchedThreadId,
    title: await resolveBranchedThreadTitle(
      args.workspaceRoot,
      args.sourceThreadId,
    ),
    lastUpdated: new Date().toISOString(),
    messageCount: copiedEntries.length,
  });

  return {
    ok: true,
    threadId: branchedThreadId,
    copiedMessageCount: copiedEntries.length,
  };
}

async function resolveBranchedThreadTitle(
  workspaceRoot: string,
  sourceThreadId: ThreadId,
): Promise<string> {
  const entries = await loadThreadIndex(workspaceRoot);
  const source = entries.find((entry) => entry.threadId === sourceThreadId);
  const sourceTitle = source?.title?.trim();
  return sourceTitle ? `${sourceTitle} (브랜치)` : '브랜치된 대화';
}

// 복사된 사용자 메시지가 참조하는 첨부 blob만 새 스레드 스토어로 복사.
// 원본 blob이 이미 지워졌으면 건너뛴다 — transcript 표시는 메타데이터로
// 유지되고, 바이트 서빙만 실패한다(원 스레드와 동일한 열화 방식).
async function copyReferencedRunAttachments(args: {
  workspaceRoot: string;
  sourceThreadId: ThreadId;
  targetThreadId: ThreadId;
  entries: readonly TranscriptEntry[];
}): Promise<void> {
  for (const entry of args.entries) {
    if (entry.role !== 'user' || !entry.metadata) {
      continue;
    }
    const metadata = entry.metadata;
    if (!('attachments' in metadata) || !metadata.attachments) {
      continue;
    }
    for (const attachment of metadata.attachments) {
      try {
        const bytes = await readRunAttachment({
          workspaceRoot: args.workspaceRoot,
          threadId: args.sourceThreadId,
          attachmentId: attachment.attachmentId,
        });
        if (!bytes) {
          continue;
        }
        await writeRunAttachment({
          workspaceRoot: args.workspaceRoot,
          threadId: args.targetThreadId,
          attachmentId: attachment.attachmentId,
          bytes,
        });
      } catch (error: unknown) {
        logger.warn('branch attachment copy skipped:', {
          sourceThreadId: args.sourceThreadId,
          attachmentId: attachment.attachmentId,
          cause: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }
}
