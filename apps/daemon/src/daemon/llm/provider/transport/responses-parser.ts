import {
  finalizeAssistantHistoryItems,
  processResponseEvent,
  flushIncompleteAssistantItems,
} from './responses-parser-events.js';
import { nextResponseEvent } from './responses-parser-iterator.js';
import { parseDaemonArtifactCandidateText } from '../../../artifact-candidate.js';
import type { ProviderArtifactCandidate } from '../wire/types.js';
import type {
  AssistantDelta,
  ResponsesParseResult,
  ResponsesParseState,
} from './responses-parser-shared.js';
export type { ResponsesParseResult } from './responses-parser-shared.js';

export async function parseResponseEvents(
  events: AsyncIterable<Record<string, unknown>>,
  onAssistantDelta?: (delta: AssistantDelta) => void,
  options?: { signal?: AbortSignal; idleTimeoutMs?: number },
): Promise<ResponsesParseResult> {
  const iterator = events[Symbol.asyncIterator]();

  const state: ResponsesParseState = {
    itemsById: new Map(),
    completedItems: [],
    functionCalls: [],
  };
  let assistantText = '';
  let finalText = '';
  let parseError: unknown;

  try {
    while (true) {
      const { done, value } = await nextResponseEvent(iterator, options);
      if (done) break;

      processResponseEvent(
        String(value.type ?? ''),
        value,
        state,
        onAssistantDelta,
      );
    }
  } catch (error: unknown) {
    parseError = error;
    throw error;
  } finally {
    if (typeof iterator.return === 'function') {
      try {
        await iterator.return();
      } catch (error: unknown) {
        if (parseError === undefined) {
          throw error;
        }
      }
    }
  }

  flushIncompleteAssistantItems(state);
  finalizeAssistantHistoryItems(state);

  for (const item of state.completedItems) {
    if (item.kind === 'assistant') {
      assistantText += item.text;
      if (item.phase === 'final_answer') {
        finalText += item.text;
      }
    }
  }

  const artifactCandidate = readProviderArtifactCandidate(finalText);

  return {
    itemsToAppend:
      state.completedItems as ResponsesParseResult['itemsToAppend'],
    functionCalls: state.functionCalls,
    assistantText,
    finalText,
    ...(artifactCandidate !== undefined ? { artifactCandidate } : {}),
    ...(state.providerUsageTelemetry !== undefined
      ? { providerUsageTelemetry: state.providerUsageTelemetry }
      : {}),
  };
}

function readProviderArtifactCandidate(
  text: string,
): ProviderArtifactCandidate | undefined {
  if (!text.trim()) {
    return undefined;
  }
  return parseDaemonArtifactCandidateText(text);
}
