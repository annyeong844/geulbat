import type {
  HistoryItem,
  HistoryUserAttachment,
  FunctionCall,
} from '../llm/index.js';
import {
  appendTranscriptEntry,
  readTranscriptEntries,
} from '../sessions/transcript-log.js';
import {
  collectTranscriptArtifactRefs,
  loadThreadArtifactVersionsByRefs,
} from '../sessions/artifact-store.js';
import { readRunAttachment } from '../sessions/run-attachment-store.js';
import type { PendingInterject } from '../sessions/active-run-interject-buffer.js';
import type { TranscriptEntry } from '../sessions/transcript-log.js';
import { createAgentArtifactRefKey as createArtifactRefKey } from './contract.js';
import { buildCompactionAwareHistory } from './memory/compaction-rebuild.js';

interface LoadInitialHistoryArgs {
  workspaceRoot: string;
  threadId: string;
  prompt: string;
}

export interface AgentLoopHistoryPort {
  loadInitialHistory(args: LoadInitialHistoryArgs): Promise<HistoryItem[]>;
}

export function createAgentLoopHistoryPort(): AgentLoopHistoryPort {
  return {
    async loadInitialHistory(args) {
      return await loadInitialHistory(
        args.workspaceRoot,
        args.threadId,
        args.prompt,
      );
    },
  };
}

export async function loadInitialHistory(
  workspaceRoot: string,
  threadId: string,
  prompt: string,
): Promise<HistoryItem[]> {
  const transcriptEntries = await readTranscriptEntries(
    workspaceRoot,
    threadId,
  );
  const artifactVersions = await loadThreadArtifactVersionsByRefs(
    workspaceRoot,
    threadId,
    collectTranscriptArtifactRefs(transcriptEntries),
  );
  const artifactVersionsByRef = new Map(
    artifactVersions.map(
      (artifact) =>
        [
          createArtifactRefKey({
            artifactId: artifact.artifactId,
            version: artifact.version,
          }),
          artifact,
        ] as const,
    ),
  );
  const attachmentsById = await loadTranscriptAttachmentContents(
    workspaceRoot,
    threadId,
    transcriptEntries,
  );
  const history = buildCompactionAwareHistory(
    transcriptEntries,
    threadId,
    artifactVersionsByRef,
    attachmentsById,
  );
  const lastItem = history.at(-1);
  if (lastItem?.kind !== 'user' || lastItem.text !== prompt) {
    history.push({ kind: 'user', text: prompt });
  }
  return history;
}

// 트랜스크립트가 참조하는 첨부 바이트를 스토어에서 읽어 모델 입력 형태로
// 준비한다. 유실된 첨부는 건너뛴다 — 히스토리 재구성이 막히면 안 된다.
async function loadTranscriptAttachmentContents(
  workspaceRoot: string,
  threadId: string,
  transcriptEntries: TranscriptEntry[],
): Promise<Map<string, HistoryUserAttachment>> {
  const contents = new Map<string, HistoryUserAttachment>();
  for (const entry of transcriptEntries) {
    if (entry.role !== 'user' || !entry.metadata) {
      continue;
    }
    const metadata = entry.metadata;
    if (!('attachments' in metadata) || !metadata.attachments) {
      continue;
    }
    for (const record of metadata.attachments) {
      const bytes = await readRunAttachment({
        workspaceRoot,
        threadId,
        attachmentId: record.attachmentId,
      });
      if (bytes === null) {
        continue;
      }
      contents.set(
        record.attachmentId,
        record.kind === 'text'
          ? {
              kind: 'text',
              name: record.name,
              text: bytes.toString('utf8'),
            }
          : {
              kind: record.kind,
              name: record.name,
              mimeType: record.mimeType,
              dataBase64: bytes.toString('base64'),
            },
      );
    }
  }
  return contents;
}

export function appendAssistantTextToHistory(
  history: HistoryItem[],
  assistantText: string,
  functionCalls: FunctionCall[],
): void {
  if (!assistantText) {
    return;
  }
  history.push({
    kind: 'assistant',
    phase: functionCalls.length > 0 ? 'commentary' : 'final_answer',
    text: assistantText,
  });
}

export function appendFunctionCallsToHistory(
  history: HistoryItem[],
  functionCalls: FunctionCall[],
): void {
  for (const functionCall of functionCalls) {
    history.push({
      kind: 'function_call',
      id: functionCall.id,
      callId: functionCall.callId,
      name: functionCall.name,
      arguments: functionCall.arguments,
    });
  }
}

export function appendInterjectToHistory(
  history: HistoryItem[],
  interject: PendingInterject,
): void {
  history.push({ kind: 'user', text: interject.text });
}

export async function persistSingleInterjectToTranscript(
  workspaceRoot: string,
  threadId: string,
  interject: PendingInterject,
): Promise<void> {
  await appendTranscriptEntry(workspaceRoot, threadId, {
    role: 'user',
    content: interject.text,
    timestamp: new Date().toISOString(),
    metadata: {
      source: 'interject',
    },
  });
}
