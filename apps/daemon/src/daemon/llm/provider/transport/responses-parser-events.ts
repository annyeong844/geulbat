import { isRecord } from '../../../runtime-json.js';
import type { HistoryItem } from '../wire/types.js';
import { createLogger } from '@geulbat/structured-logger/logger';
import { normalizeProviderUsageTelemetry } from '../provider-cache-telemetry.js';
import type {
  AssistantDelta,
  AssistantPhase,
  AssistantPhaseIssue,
  CompletedAssistantItem,
  FunctionCallArgsDelta,
  ResponsesParseState,
} from './responses-parser-shared.js';

const logger = createLogger('responses-parser');

export function processResponseEvent(
  type: string,
  event: Record<string, unknown>,
  state: ResponsesParseState,
  onDelta?: (delta: AssistantDelta) => void,
  onFunctionCallArgsDelta?: (delta: FunctionCallArgsDelta) => void,
): void {
  switch (type) {
    case 'response.output_item.added': {
      const item = asRecord(event.item);
      const itemId = readEventString(item?.id);
      if (item && itemId) {
        const phase = normalizeAssistantPhase(item.phase);
        const phaseIssue = readAssistantPhaseIssue(item.phase);
        const invalidPhase = readInvalidAssistantPhase(item.phase);
        const callId = readEventString(item.call_id);
        const name = readEventString(item.name);
        state.itemsById.set(itemId, {
          id: itemId,
          text: '',
          type: readEventString(item.type) ?? '',
          ...(phase !== undefined ? { phase } : {}),
          ...(phaseIssue !== undefined ? { phaseIssue } : {}),
          ...(invalidPhase !== undefined ? { invalidPhase } : {}),
          ...(callId !== undefined ? { callId } : {}),
          ...(name !== undefined ? { name } : {}),
        });
      }
      break;
    }

    case 'response.output_text.delta': {
      const delta = typeof event.delta === 'string' ? event.delta : '';
      const itemId = readEventString(event.item_id) ?? '';
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

    // 스트리밍 function-call 인자 — 도구가 원하면(visualize 등) 델타를
    // 위로 흘린다. 완성본은 여전히 output_item.done이 정본이다.
    case 'response.function_call_arguments.delta': {
      const delta = typeof event.delta === 'string' ? event.delta : '';
      const itemId = readEventString(event.item_id) ?? '';
      const buf = state.itemsById.get(itemId);
      if (buf && buf.type === 'function_call' && delta && buf.name) {
        onFunctionCallArgsDelta?.({
          itemId,
          callId: buf.callId ?? '',
          name: buf.name,
          argsDelta: delta,
        });
      }
      break;
    }

    case 'response.output_item.done': {
      const item = asRecord(event.item);
      const id = readEventString(item?.id);
      if (!item || !id) {
        break;
      }

      const outputIndex = readProviderOutputIndex(event);
      state.providerOutputItems.push({
        completionOrder: state.providerOutputItems.length,
        item,
        ...(outputIndex !== undefined ? { outputIndex } : {}),
      });

      if (item.type === 'function_call') {
        const fc = {
          id,
          callId: readEventString(item.call_id) ?? '',
          name: readEventString(item.name) ?? '',
          arguments: readEventString(item.arguments) ?? '{}',
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
    case 'response.done': {
      const telemetry = normalizeProviderUsageTelemetry(
        readResponseUsage(event),
      );
      if (telemetry) {
        state.providerUsageTelemetry = telemetry;
      }
      break;
    }

    case 'error':
    case 'response.failed': {
      const errorRecord =
        asRecord(asRecord(event.response)?.error) ?? asRecord(event.error);
      const code =
        readEventString(errorRecord?.code) ?? readEventString(event.code) ?? '';
      const message =
        readEventString(errorRecord?.message) ??
        readEventString(event.message) ??
        '';
      const rawDetail = stringifyEventError(errorRecord ?? event);
      const msg = message || code || rawDetail || 'API stream error';
      throw new Error(msg);
    }

    default:
      break;
  }
}

function readResponseUsage(event: Record<string, unknown>): unknown {
  const response = asRecord(event.response);
  return response?.usage ?? event.usage;
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
  return isRecord(v) ? v : null;
}

function readEventString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function readProviderOutputIndex(
  event: Record<string, unknown>,
): number | undefined {
  const value = event.output_index;
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error('provider output item has an invalid output_index');
  }
  return value;
}

function extractTextFromContent(content: unknown): string {
  if (!Array.isArray(content)) {
    return '';
  }
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

export function finalizeAssistantHistoryItems(
  state: ResponsesParseState,
): HistoryItem[] {
  const finalizedItems: HistoryItem[] = [];

  for (const item of state.completedItems) {
    if (item.kind === 'assistant_pending') {
      finalizedItems.push(toAssistantHistoryItem(item.data));
      continue;
    }
    finalizedItems.push(item);
  }

  state.completedItems = finalizedItems;
  return finalizedItems;
}

export function finalizeProviderOutputHistoryItems(
  state: ResponsesParseState,
): HistoryItem[] {
  const hasIndexedItems = state.providerOutputItems.some(
    (item) => item.outputIndex !== undefined,
  );
  const allItemsAreIndexed = state.providerOutputItems.every(
    (item) => item.outputIndex !== undefined,
  );
  if (hasIndexedItems && !allItemsAreIndexed) {
    throw new Error('provider output item ordering is incomplete');
  }

  const orderedItems = [...state.providerOutputItems];
  if (allItemsAreIndexed) {
    const seenOutputIndexes = new Set<number>();
    for (const item of orderedItems) {
      const outputIndex = item.outputIndex;
      if (outputIndex === undefined || seenOutputIndexes.has(outputIndex)) {
        throw new Error('provider output item ordering is ambiguous');
      }
      seenOutputIndexes.add(outputIndex);
    }
    orderedItems.sort(
      (left, right) =>
        (left.outputIndex ?? left.completionOrder) -
        (right.outputIndex ?? right.completionOrder),
    );
  }

  return orderedItems.map(({ item }) => ({
    kind: 'backend_item',
    data: item,
  }));
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
  if (typeof phase === 'string') {
    return phase;
  }
  return stringifyEventError(phase) || typeof phase;
}

function buildAssistantPhaseResolutionErrorMessage(
  item: CompletedAssistantItem,
): string {
  if (item.phaseIssue === 'invalid' && item.invalidPhase !== undefined) {
    return `provider response declared invalid assistant item phase "${item.invalidPhase}" for item ${item.itemId}`;
  }
  return `provider response missing assistant item phase for item ${item.itemId}`;
}
