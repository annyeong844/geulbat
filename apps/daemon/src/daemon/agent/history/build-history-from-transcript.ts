import { createArtifactRefKey } from '@geulbat/protocol/artifacts';
import { tryParseJsonRecord } from '@geulbat/protocol/runtime-utils';
import type { ThreadArtifactVersion } from '@geulbat/protocol/artifacts';
import { readArtifactRefsFromMetadata } from '@geulbat/protocol/thread-metadata';
import type { HistoryItem } from '../../llm/index.js';
import type { TranscriptEntry } from '../../sessions/transcript-log.js';

export function buildHistoryFromTranscript(
  messages: TranscriptEntry[],
  artifactVersionsByRef: ReadonlyMap<string, ThreadArtifactVersion> = new Map(),
): HistoryItem[] {
  const history: HistoryItem[] = [];

  for (const message of messages) {
    switch (message.role) {
      case 'user':
        history.push({ kind: 'user', text: readUserPrompt(message) });
        break;
      case 'assistant':
        history.push({
          kind: 'assistant',
          phase: readAssistantPhase(message.metadata),
          text: readAssistantText(message, artifactVersionsByRef),
        });
        break;
      case 'tool_call': {
        const parsedResult = tryParseJsonRecord(message.content);
        const parsed = parsedResult.ok ? parsedResult.value : null;
        const callId = readString(parsed?.callId);
        const toolName = readString(parsed?.tool);
        if (!callId || !toolName) break;

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
        if (!callId) break;

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
  lines.push('payload:');
  lines.push(artifact.payload);
  return lines.join('\n');
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function stringifyJson(value: unknown): string {
  if (typeof value === 'string') return value;
  return JSON.stringify(value);
}

function readToolOutput(parsed: Record<string, unknown> | null): string {
  if (!parsed) return '{}';
  if ('output' in parsed) {
    return stringifyJson(parsed.output);
  }
  return JSON.stringify(parsed);
}
