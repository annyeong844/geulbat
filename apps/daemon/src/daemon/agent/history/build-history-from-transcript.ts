import {
  createAgentArtifactRefKey as createArtifactRefKey,
  readAgentArtifactRefsFromMetadata as readArtifactRefsFromMetadata,
  type ThreadArtifactVersion,
} from '../contract.js';
import { isRecord, tryParseJsonRecord } from '../../runtime-json.js';
import type { HistoryItem, HistoryUserAttachment } from '../../llm/index.js';
import type { TranscriptEntry } from '../../sessions/transcript-log.js';

export function buildHistoryFromTranscript(
  messages: TranscriptEntry[],
  artifactVersionsByRef: ReadonlyMap<string, ThreadArtifactVersion> = new Map(),
  attachmentsById: ReadonlyMap<string, HistoryUserAttachment> = new Map(),
): HistoryItem[] {
  const history: HistoryItem[] = [];
  const skippedToolCallIds = new Set<string>();

  for (const message of messages) {
    switch (message.role) {
      case 'user': {
        const attachments = readUserAttachments(message, attachmentsById);
        history.push({
          kind: 'user',
          text: readUserPrompt(message),
          ...(attachments.length > 0 ? { attachments } : {}),
        });
        break;
      }
      case 'assistant':
        history.push({
          kind: 'assistant',
          phase: readAssistantPhase(message.metadata),
          text: readAssistantText(message, artifactVersionsByRef),
        });
        break;
      case 'compaction':
        break;
      case 'tool_call': {
        const parsedResult = tryParseJsonRecord(message.content);
        const parsed = parsedResult.ok ? parsedResult.value : null;
        const callId = readString(parsed?.callId);
        if (isHistoryReplaySkipped(parsed)) {
          if (callId) {
            skippedToolCallIds.add(callId);
          }
          break;
        }
        const toolName = readString(parsed?.tool);
        if (!callId || !toolName) {
          break;
        }
        history.push({
          kind: 'function_call',
          id: readString(parsed?.id) ?? callId,
          callId,
          name: toolName,
          arguments: stringifyJson(parsed?.args ?? {}),
        });
        break;
      }
      case 'tool_result': {
        const parsedResult = tryParseJsonRecord(message.content);
        const parsed = parsedResult.ok ? parsedResult.value : null;
        const callId = readString(parsed?.callId);
        if (!callId) {
          break;
        }
        if (skippedToolCallIds.has(callId) || isHistoryReplaySkipped(parsed)) {
          break;
        }

        history.push({
          kind: 'function_call_output',
          callId,
          output: readToolOutput(parsed),
        });
        break;
      }
    }
  }

  return history;
}

function readAssistantPhase(
  metadata: TranscriptEntry['metadata'],
): 'commentary' | 'final_answer' {
  if (metadata && typeof metadata.phase === 'string') {
    if (metadata.phase === 'commentary' || metadata.phase === 'final_answer') {
      return metadata.phase;
    }
  }
  return 'final_answer';
}

// 트랜스크립트 메타데이터의 첨부 참조를 미리 로드된 내용으로 치환한다.
// 스토어에서 사라진 첨부는 조용히 건너뛴다(대화는 계속되어야 한다).
function readUserAttachments(
  message: TranscriptEntry,
  attachmentsById: ReadonlyMap<string, HistoryUserAttachment>,
): HistoryUserAttachment[] {
  const metadata = message.metadata;
  if (!metadata || !('attachments' in metadata) || !metadata.attachments) {
    return [];
  }
  return metadata.attachments
    .map((record) => attachmentsById.get(record.attachmentId))
    .filter(
      (attachment): attachment is HistoryUserAttachment =>
        attachment !== undefined,
    );
}

function readUserPrompt(message: TranscriptEntry): string {
  if (
    message.metadata &&
    typeof message.metadata.hiddenPrompt === 'string' &&
    message.metadata.hiddenPrompt.trim()
  ) {
    return message.metadata.hiddenPrompt;
  }
  return message.content;
}

function readAssistantText(
  message: TranscriptEntry,
  artifactVersionsByRef: ReadonlyMap<string, ThreadArtifactVersion>,
): string {
  const artifactText = readAssistantArtifactText(
    message.metadata,
    artifactVersionsByRef,
  );
  if (!artifactText) {
    return message.content;
  }
  if (!message.content.trim()) {
    return artifactText;
  }
  return `${message.content}\n\n${artifactText}`;
}

function readAssistantArtifactText(
  metadata: TranscriptEntry['metadata'],
  artifactVersionsByRef: ReadonlyMap<string, ThreadArtifactVersion>,
): string {
  if (!metadata) {
    return '';
  }
  const parts = readArtifactRefsFromMetadata(metadata)
    .map((ref) => artifactVersionsByRef.get(createArtifactRefKey(ref)))
    .filter(
      (artifact): artifact is ThreadArtifactVersion => artifact !== undefined,
    )
    .map((artifact) => buildArtifactCarryText(artifact));

  return parts.join('\n\n');
}

function buildArtifactCarryText(artifact: ThreadArtifactVersion): string {
  const lines = [
    '[Committed artifact]',
    `artifactRef: ${artifact.artifactId}@${artifact.version}`,
    `renderer: ${artifact.renderer}`,
  ];
  if (artifact.digest) {
    lines.push(`digest: ${artifact.digest}`);
  }
  // 이미지 payload는 inline base64 매니페스트라 히스토리에 원문 재주입하면
  // 컨텍스트가 수 MB로 불어난다. 참조/요약만 싣는다.
  if (artifact.renderer === 'image') {
    lines.push(`title: ${artifact.title ?? ''}`);
    lines.push('payload: (generated image manifest omitted from history)');
    return lines.join('\n');
  }
  lines.push('payload:');
  lines.push(artifact.payload);
  return lines.join('\n');
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function isHistoryReplaySkipped(
  parsed: Record<string, unknown> | null,
): boolean {
  if (!parsed) {
    return false;
  }
  if (parsed.historyMode === 'audit_only') {
    return true;
  }
  const source = parsed.source;
  return isRecord(source) && source.kind === 'ptc_callback';
}

function stringifyJson(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  return JSON.stringify(value);
}

function readToolOutput(parsed: Record<string, unknown> | null): string {
  if (!parsed) {
    return '{}';
  }
  const output = 'output' in parsed ? parsed.output : parsed;
  return stringifyJson(output);
}
