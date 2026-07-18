import type {
  ThreadMessageAttachment,
  ThreadMessageInput,
  ThreadMessageMetadata,
} from './contract.js';

import type { ResolvedExecuteForegroundRunDeps } from './execute-foreground-run-contracts.js';
import { upsertCurrentThreadSummary } from './foreground-thread-state-persistence.js';
import type { AgentInput } from './loop-types.js';
import type { ResolvedRunAttachment } from './run-attachments.js';
import {
  createRunAttachmentId,
  writeRunAttachment,
} from '../sessions/run-attachment-store.js';

export async function persistRequiredForegroundInput(args: {
  agentInput: Pick<AgentInput, 'prompt' | 'runContext' | 'attachments'>;
  transcriptPrompt: string;
  // UI 발 자동 요청 — 감사용으로 기록하되 채팅에는 그리지 않는다
  silentPrompt?: boolean;
  // 아티팩트 프레임 발 턴 — metadata.origin으로 각인해 귀속 렌더한다
  promptOrigin?: 'artifact_frame';
  deps: ResolvedExecuteForegroundRunDeps;
  onTranscriptPersisted?: () => void;
}): Promise<void> {
  const { agentInput, transcriptPrompt, deps } = args;
  const { runContext, prompt } = agentInput;

  const attachments = await persistRunAttachments({
    workspaceRoot: runContext.stateRoot,
    threadId: runContext.threadId,
    attachments: agentInput.attachments ?? [],
  });

  await deps.appendTranscriptEntry(
    runContext.stateRoot,
    runContext.threadId,
    buildForegroundUserTranscriptEntry({
      prompt,
      transcriptPrompt,
      attachments,
      silentPrompt: args.silentPrompt === true,
      ...(args.promptOrigin !== undefined
        ? { promptOrigin: args.promptOrigin }
        : {}),
      timestamp: deps.now(),
    }),
  );
  args.onTranscriptPersisted?.();

  await upsertCurrentThreadSummary({
    workspaceRoot: runContext.stateRoot,
    threadId: runContext.threadId,
    transcriptPrompt,
    deps,
  });
}

// 첨부 바이트를 스레드 스토어에 옮기고 메타데이터 레코드로 바꾼다 —
// 트랜스크립트 자체에는 바이트를 싣지 않는다(스레드 조회 응답 비대 방지).
async function persistRunAttachments(args: {
  workspaceRoot: string;
  threadId: string;
  attachments: ResolvedRunAttachment[];
}): Promise<ThreadMessageAttachment[]> {
  const records: ThreadMessageAttachment[] = [];
  for (const attachment of args.attachments) {
    const attachmentId = createRunAttachmentId();
    await writeRunAttachment({
      workspaceRoot: args.workspaceRoot,
      threadId: args.threadId,
      attachmentId,
      bytes: attachment.bytes,
    });
    records.push({
      attachmentId,
      name: attachment.name,
      mimeType: attachment.mimeType,
      kind: attachment.kind,
      byteLength: attachment.bytes.byteLength,
    });
  }
  return records;
}

function buildForegroundUserTranscriptEntry(args: {
  prompt: string;
  transcriptPrompt: string;
  attachments: ThreadMessageAttachment[];
  silentPrompt: boolean;
  promptOrigin?: 'artifact_frame';
  timestamp: string;
}): ThreadMessageInput {
  const entry: ThreadMessageInput = {
    role: 'user',
    content: args.transcriptPrompt,
    timestamp: args.timestamp,
  };
  const metadata = buildUserTranscriptMetadata(args);

  if (metadata !== undefined) {
    entry.metadata = metadata;
  }

  return entry;
}

function buildUserTranscriptMetadata(args: {
  prompt: string;
  transcriptPrompt: string;
  attachments: ThreadMessageAttachment[];
  silentPrompt: boolean;
  promptOrigin?: 'artifact_frame';
}): ThreadMessageMetadata | undefined {
  const hiddenPrompt =
    args.transcriptPrompt === args.prompt ? undefined : args.prompt;
  if (
    hiddenPrompt === undefined &&
    args.attachments.length === 0 &&
    !args.silentPrompt &&
    args.promptOrigin === undefined
  ) {
    return undefined;
  }

  return {
    ...(hiddenPrompt !== undefined ? { hiddenPrompt } : {}),
    ...(args.attachments.length > 0 ? { attachments: args.attachments } : {}),
    ...(args.silentPrompt ? { silent: true } : {}),
    ...(args.promptOrigin !== undefined ? { origin: args.promptOrigin } : {}),
  };
}
