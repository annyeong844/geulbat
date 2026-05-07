import type { HistoryItem, FunctionCall } from '../llm/index.js';
import {
  collectTranscriptArtifactRefs,
  loadThreadArtifactVersionsByRefs,
} from '../sessions/artifact-store.js';
import { readTranscriptEntries } from '../sessions/transcript-log.js';
import { createArtifactRefKey } from '@geulbat/protocol/artifacts';
import { buildHistoryFromTranscript } from './history/build-history-from-transcript.js';

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
  const history = buildHistoryFromTranscript(
    transcriptEntries,
    artifactVersionsByRef,
  );
  const lastItem = history.at(-1);
  if (lastItem?.kind !== 'user' || lastItem.text !== prompt) {
    history.push({ kind: 'user', text: prompt });
  }
  return history;
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
