import type { HistoryItem } from '../wire/types.js';
import { createLogger } from '@geulbat/shared-utils/logger';
import type {
  AssistantDelta,
  AssistantPhase,
  AssistantPhaseIssue,
  CompletedAssistantItem,
  ResponsesParseState,
} from './responses-parser-shared.js';

const MAX_STREAM_ERROR_MESSAGE_CHARS = 500;
const logger = createLogger('responses-parser');

export function processResponseEvent(
  type: string,
  event: Record<string, unknown>,
  state: ResponsesParseState,
  onDelta?: (delta: AssistantDelta) => void,
): void {
  switch (type) {
    case 'response.output_item.added': {
      const item = asRecord(event.item);
      if (item?.id) {
        const itemId = String(item.id);
        const phase = normalizeAssistantPhase(item.phase);
        const phaseIssue = readAssistantPhaseIssue(item.phase);
        const invalidPhase = readInvalidAssistantPhase(item.phase);
        state.itemsById.set(itemId, {
          id: itemId,
          text: '',
          type: String(item.type ?? ''),
          ...(phase !== undefined ? { phase } : {}),
          ...(phaseIssue !== undefined ? { phaseIssue } : {}),
          ...(invalidPhase !== undefined ? { invalidPhase } : {}),
        });
      }
      break;
    }

    case 'response.output_text.delta': {
      const delta = typeof event.delta === 'string' ? event.delta : '';
      const itemId = String(event.item_id ?? '');
      const buf = state.itemsById.get(itemId);

      if (buf) {
        buf.text += delta;

        if (buf.phase && onDelta && delta) {
          buf.deltaEmitted = true;
          onDelta({ itemId, phase: buf.phase, text: delta });
        }
      }
      break;
    }

    case 'response.output_item.done': {
      const item = asRecord(event.item);
      if (!item?.id) break;
      const id = String(item.id);

      if (item.type === 'function_call') {
        const fc = {
          id,
          callId: String(item.call_id ?? ''),
          name: String(item.name ?? ''),
          arguments: String(item.arguments ?? '{}'),
        };
        state.functionCalls.push(fc);
        state.completedItems.push({
          kind: 'function_call',
          id: fc.id,
          callId: fc.callId,
          name: fc.name,
          arguments: fc.arguments,
        });
        state.itemsById.delete(id);
        break;
      }

      const buf = state.itemsById.get(id);
      if (buf) {
        const phase = normalizeAssistantPhase(item.phase);
        const phaseIssue = readAssistantPhaseIssue(item.phase);
        const invalidPhase = readInvalidAssistantPhase(item.phase);
        if (phase !== undefined) {
          buf.phase = phase;
        }
        if (phaseIssue !== undefined) {
          buf.phaseIssue = phaseIssue;
        }
        if (invalidPhase !== undefined) {
          buf.invalidPhase = invalidPhase;
        }

        if (buf.phase && onDelta && buf.text && !buf.deltaEmitted) {
          buf.deltaEmitted = true;
          onDelta({ itemId: id, phase: buf.phase, text: buf.text });
        }

        const text = buf.text || extractTextFromContent(item.content);
        if (text) {
          state.completedItems.push({
            kind: 'assistant_pending',
            data: toCompletedAssistantItem(buf, text),
          });
        }
        state.itemsById.delete(id);
      }

      if (
        item.type &&
        item.type !== 'message' &&
        item.type !== 'function_call'
      ) {
        state.completedItems.push({ kind: 'backend_item', data: item });
      }

      break;
    }

    case 'response.completed':
    case 'response.done':
      break;

    case 'error':
    case 'response.failed': {
      const errorRecord = asRecord(asRecord(event.response)?.error);
      const code = String(errorRecord?.code ?? event.code ?? '');
      const message = String(errorRecord?.message ?? event.message ?? '');
      const rawDetail = stringifyEventError(errorRecord ?? event);
      const msg = truncateStreamErrorMessage(
        message || code || rawDetail || 'API stream error',
      );
      throw new Error(msg);
    }

    default:
      break;
  }
}

export function flushIncompleteAssistantItems(
  state: ResponsesParseState,
): void {
  for (const item of state.itemsById.values()) {
    if (item.text && item.type !== 'function_call') {
      state.completedItems.push({
        kind: 'assistant_pending',
        data: toCompletedAssistantItem(item, item.text),
      });
    }
  }
}

function isAssistantPhase(value: unknown): value is AssistantPhase {
  return value === 'commentary' || value === 'final_answer';
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

function extractTextFromContent(content: unknown): string {
  if (!Array.isArray(content)) return '';
  return content
    .map((part: { type?: string; text?: string }) =>
      part?.type === 'output_text' ? (part.text ?? '') : '',
    )
    .filter(Boolean)
    .join('');
}

function stringifyEventError(value: unknown): string {
  try {
    const text = JSON.stringify(value);
    return text && text !== '{}' ? text : '';
  } catch {
    return '';
  }
}

function truncateStreamErrorMessage(text: string): string {
  if (text.length <= MAX_STREAM_ERROR_MESSAGE_CHARS) {
    return text;
  }
  return `${text.slice(0, MAX_STREAM_ERROR_MESSAGE_CHARS)}...(truncated)`;
}

export function finalizeAssistantHistoryItems(
  state: ResponsesParseState,
): void {
  const finalizedItems: HistoryItem[] = [];

  for (const item of state.completedItems) {
    if (item.kind === 'assistant_pending') {
      finalizedItems.push(toAssistantHistoryItem(item.data));
      continue;
    }
    finalizedItems.push(item);
  }

  state.completedItems = finalizedItems;
}

function toCompletedAssistantItem(
  item: {
    id: string;
    phase?: AssistantPhase;
    phaseIssue?: AssistantPhaseIssue;
    invalidPhase?: string;
  },
  text: string,
): CompletedAssistantItem {
  return {
    itemId: item.id,
    ...(item.phase !== undefined ? { phase: item.phase } : {}),
    ...(item.phaseIssue !== undefined ? { phaseIssue: item.phaseIssue } : {}),
    ...(item.invalidPhase !== undefined
      ? { invalidPhase: item.invalidPhase }
      : {}),
    text,
  };
}

function toAssistantHistoryItem(item: CompletedAssistantItem): HistoryItem {
  if (item.phase) {
    return { kind: 'assistant', phase: item.phase, text: item.text };
  }

  logger.warn(
    'provider response assistant item phase unresolved; rejecting stream',
    {
      itemId: item.itemId,
      issue: item.phaseIssue ?? 'missing',
      ...(item.invalidPhase !== undefined ? { phase: item.invalidPhase } : {}),
    },
  );
  throw new Error(buildAssistantPhaseResolutionErrorMessage(item));
}

function normalizeAssistantPhase(phase: unknown): AssistantPhase | undefined {
  if (isAssistantPhase(phase)) {
    return phase;
  }
  return undefined;
}

function readAssistantPhaseIssue(
  phase: unknown,
): AssistantPhaseIssue | undefined {
  if (phase === undefined) {
    return 'missing';
  }
  if (isAssistantPhase(phase)) {
    return undefined;
  }
  return 'invalid';
}

function readInvalidAssistantPhase(phase: unknown): string | undefined {
  if (phase === undefined || isAssistantPhase(phase)) {
    return undefined;
  }
  return String(phase);
}

function buildAssistantPhaseResolutionErrorMessage(
  item: CompletedAssistantItem,
): string {
  if (item.phaseIssue === 'invalid' && item.invalidPhase !== undefined) {
    return `provider response declared invalid assistant item phase "${item.invalidPhase}" for item ${item.itemId}`;
  }
  return `provider response missing assistant item phase for item ${item.itemId}`;
}
