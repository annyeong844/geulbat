import {
  finalizeAssistantHistoryItems,
  processResponseEvent,
  flushIncompleteAssistantItems,
} from './responses-parser-events.js';
import { nextResponseEvent } from './responses-parser-iterator.js';
import { parseCanonicalArtifactEnvelopeText } from '@geulbat/protocol/artifacts';
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
  } finally {
    if (typeof iterator.return === 'function') {
      await iterator.return();
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
  };
}

function readProviderArtifactCandidate(
  text: string,
): ProviderArtifactCandidate | undefined {
  if (!text.trim()) {
    return undefined;
  }
  return parseCanonicalArtifactEnvelopeText(text) ?? undefined;
}
