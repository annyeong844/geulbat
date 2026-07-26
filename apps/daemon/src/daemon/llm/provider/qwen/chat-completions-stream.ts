import { parseDaemonArtifactCandidateText } from '../../../artifact-candidate.js';
import { isRecord } from '../../../runtime-json.js';
import type { ProviderReplayScopeId } from '../../../runtime-contracts.js';
import { hashProviderTraceIdentity } from '../provider-cache-projection.js';
import type { ResponsesRequestPreparedHandler } from '../transport/responses-websocket.js';
import type {
  CallResult,
  FunctionCall,
  HistoryItem,
  ProviderUsageTelemetry,
  WireToolDefinition,
} from '../wire/types.js';
import { buildQwenChatMessages, type QwenChatMessage } from './chat-wire.js';
import type { QwenTokenPlanConfig } from './config.js';

interface QwenStreamCallbacks {
  onAssistantDelta?: (delta: {
    itemId: string;
    phase: 'commentary' | 'final_answer';
    text: string;
  }) => void;
  onFunctionCallArgsDelta?: (delta: {
    itemId: string;
    callId: string;
    name: string;
    argsDelta: string;
  }) => void;
}

export interface QwenChatCompletionsInput extends QwenStreamCallbacks {
  config: QwenTokenPlanConfig;
  history: HistoryItem[];
  providerReplayScopeId: ProviderReplayScopeId;
  instructions?: string;
  tools?: WireToolDefinition[];
  signal?: AbortSignal;
  onRequestPrepared?: ResponsesRequestPreparedHandler;
  onProviderWaiting?: () => void;
}

interface QwenChatCompletionsDependencies {
  fetchImpl: typeof fetch;
}

interface AccumulatedQwenToolCall {
  id?: string;
  name?: string;
  arguments: string;
}

export async function streamQwenChatCompletions(
  input: QwenChatCompletionsInput,
  deps: QwenChatCompletionsDependencies = { fetchImpl: fetch },
): Promise<CallResult> {
  const historyMessages = buildQwenChatMessages({
    history: input.history,
    providerReplayScopeId: input.providerReplayScopeId,
  });
  const systemMessages: QwenChatMessage[] =
    input.instructions === undefined
      ? []
      : [{ role: 'system', content: input.instructions }];
  const tools = input.tools?.map(toQwenToolDefinition);
  const body = {
    model: input.config.model,
    messages: [...systemMessages, ...historyMessages],
    stream: true,
    stream_options: { include_usage: true },
    enable_thinking: true,
    ...(tools === undefined || tools.length === 0
      ? {}
      : { tools, tool_choice: 'auto' }),
  };
  const serializedBody = JSON.stringify(body);
  const admission = await input.onRequestPrepared?.(
    measureQwenRequest({
      serializedBody,
      historyMessages,
      systemMessages,
      tools,
    }),
  );
  if (admission?.kind === 'prepare') {
    throw Object.assign(new Error('context preparation required'), {
      llmCode: 'llm_context_preparation_required' as const,
      preparationReason: admission.reason,
    });
  }

  input.onProviderWaiting?.();
  const headers = new Headers({
    authorization: `Bearer ${input.config.apiKey}`,
    accept: 'text/event-stream',
    'content-type': 'application/json',
  });
  const response = await deps.fetchImpl(input.config.chatCompletionsUrl, {
    method: 'POST',
    headers,
    body: serializedBody,
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  });
  if (!response.ok) {
    throw new QwenHttpError(response.status);
  }
  const contentType = response.headers.get('content-type')?.toLowerCase();
  if (contentType?.includes('text/event-stream') !== true) {
    throw new QwenStreamError('Qwen response is not an event stream');
  }
  if (response.body === null) {
    throw new QwenStreamError('Qwen event stream body is missing');
  }

  let responseId = '';
  let commentaryText = '';
  let finalText = '';
  let providerUsageTelemetry: ProviderUsageTelemetry | undefined;
  const toolCallsByIndex = new Map<number, AccumulatedQwenToolCall>();

  for await (const event of iterateQwenServerSentEvents(response.body)) {
    const error = isRecord(event['error']) ? event['error'] : undefined;
    if (error !== undefined) {
      throw new QwenStreamError('Qwen event stream reported an error');
    }
    if (typeof event['id'] === 'string' && event['id'].trim() !== '') {
      responseId = event['id'];
    }
    const telemetry = readQwenUsage(event['usage']);
    if (telemetry !== undefined) {
      providerUsageTelemetry = telemetry;
    }
    const choices = event['choices'];
    if (!Array.isArray(choices)) {
      continue;
    }
    for (const choice of choices) {
      if (!isRecord(choice)) {
        throw new QwenStreamError('Qwen stream choice is invalid');
      }
      const choiceIndex = choice['index'];
      if (choiceIndex !== undefined && choiceIndex !== 0) {
        continue;
      }
      const delta = choice['delta'];
      if (!isRecord(delta)) {
        continue;
      }
      const reasoningDelta = readOptionalDeltaString(
        delta,
        'reasoning_content',
      );
      if (reasoningDelta !== undefined) {
        commentaryText += reasoningDelta;
        input.onAssistantDelta?.({
          itemId: buildQwenItemId(responseId, 'reasoning'),
          phase: 'commentary',
          text: reasoningDelta,
        });
      }
      const contentDelta = readOptionalDeltaString(delta, 'content');
      if (contentDelta !== undefined) {
        finalText += contentDelta;
        input.onAssistantDelta?.({
          itemId: buildQwenItemId(responseId, 'answer'),
          phase: 'final_answer',
          text: contentDelta,
        });
      }
      appendQwenToolCallDeltas(
        delta['tool_calls'],
        toolCallsByIndex,
        input.onFunctionCallArgsDelta,
      );
    }
  }

  const functionCalls = finalizeQwenFunctionCalls(toolCallsByIndex, responseId);
  const itemIdentity =
    responseId.trim() === ''
      ? hashProviderTraceIdentity(
          JSON.stringify({ commentaryText, finalText, functionCalls }),
        )
      : responseId;
  const itemsToAppend: HistoryItem[] = [
    ...(commentaryText === ''
      ? []
      : [
          buildQwenAssistantBackendItem({
            id: `${itemIdentity}:reasoning`,
            phase: 'commentary',
            text: commentaryText,
          }),
        ]),
    ...(finalText === ''
      ? []
      : [
          buildQwenAssistantBackendItem({
            id: `${itemIdentity}:answer`,
            phase: 'final_answer',
            text: finalText,
          }),
        ]),
    ...functionCalls.map(buildQwenFunctionCallBackendItem),
  ];
  if (itemsToAppend.length === 0) {
    throw new QwenStreamError('Qwen event stream completed without output');
  }

  const artifactCandidate =
    finalText.trim() === ''
      ? undefined
      : parseDaemonArtifactCandidateText(finalText);
  return {
    itemsToAppend,
    functionCalls,
    assistantText: commentaryText + finalText,
    finalText,
    ...(artifactCandidate === undefined ? {} : { artifactCandidate }),
    ...(providerUsageTelemetry === undefined ? {} : { providerUsageTelemetry }),
  };
}

function toQwenToolDefinition(
  tool: WireToolDefinition,
): Record<string, unknown> {
  return {
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
      strict: tool.strict,
    },
  };
}

function measureQwenRequest(args: {
  serializedBody: string;
  historyMessages: QwenChatMessage[];
  systemMessages: QwenChatMessage[];
  tools: Record<string, unknown>[] | undefined;
}): Parameters<ResponsesRequestPreparedHandler>[0] {
  const serializedBytes = Buffer.byteLength(args.serializedBody, 'utf8');
  const history = measureSerializedValue(args.historyMessages);
  const instructions = measureSerializedValue(args.systemMessages);
  const toolDefinitions = measureSerializedValue(args.tools);
  const envelope = Math.max(
    0,
    serializedBytes - history - instructions - toolDefinitions,
  );
  const dominantPressureSource = (
    [
      ['history', history],
      ['instructions', instructions],
      ['tool_definitions', toolDefinitions],
      ['envelope', envelope],
    ] as const
  ).reduce((dominant, candidate) =>
    candidate[1] > dominant[1] ? candidate : dominant,
  )[0];
  return {
    serializedBytes,
    dominantPressureSource,
    serializedBytesBySource: {
      history,
      instructions,
      toolDefinitions,
      envelope,
    },
  };
}

function measureSerializedValue(value: unknown): number {
  return value === undefined
    ? 0
    : Buffer.byteLength(JSON.stringify(value), 'utf8');
}

async function* iterateQwenServerSentEvents(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<Record<string, unknown>> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let completed = false;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) {
        buffer += decoder.decode();
        break;
      }
      buffer += decoder.decode(next.value, { stream: true });
      const drained = drainSseBlocks(buffer);
      buffer = drained.remainder;
      for (const block of drained.blocks) {
        const event = parseQwenSseBlock(block);
        if (event === 'done') {
          completed = true;
          return;
        }
        if (event !== undefined) {
          yield event;
        }
      }
    }
    if (buffer.trim() !== '') {
      const event = parseQwenSseBlock(buffer);
      if (event !== undefined && event !== 'done') {
        yield event;
      }
    }
    completed = true;
  } finally {
    if (!completed) {
      try {
        await reader.cancel();
      } catch {
        // The owned fetch stream is already closing; cancellation is best-effort.
      }
    }
    reader.releaseLock();
  }
}

function drainSseBlocks(value: string): {
  blocks: string[];
  remainder: string;
} {
  const normalized = value.replaceAll('\r\n', '\n');
  const parts = normalized.split('\n\n');
  return {
    blocks: parts.slice(0, -1),
    remainder: parts.at(-1) ?? '',
  };
}

function parseQwenSseBlock(
  block: string,
): Record<string, unknown> | 'done' | undefined {
  const data = block
    .split('\n')
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trimStart())
    .join('\n');
  if (data === '') {
    return undefined;
  }
  if (data === '[DONE]') {
    return 'done';
  }
  let value: unknown;
  try {
    value = JSON.parse(data);
  } catch {
    throw new QwenStreamError('Qwen event stream contains invalid JSON');
  }
  if (!isRecord(value)) {
    throw new QwenStreamError('Qwen event stream contains a non-object event');
  }
  return value;
}

function readOptionalDeltaString(
  record: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = record[key];
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== 'string') {
    throw new QwenStreamError(`Qwen ${key} delta is invalid`);
  }
  return value;
}

function appendQwenToolCallDeltas(
  value: unknown,
  toolCallsByIndex: Map<number, AccumulatedQwenToolCall>,
  onDelta: QwenStreamCallbacks['onFunctionCallArgsDelta'],
): void {
  if (value === undefined || value === null) {
    return;
  }
  if (!Array.isArray(value)) {
    throw new QwenStreamError('Qwen tool call delta is invalid');
  }
  for (const raw of value) {
    if (!isRecord(raw)) {
      throw new QwenStreamError('Qwen tool call delta is invalid');
    }
    const index = raw['index'] ?? 0;
    if (
      typeof index !== 'number' ||
      !Number.isSafeInteger(index) ||
      index < 0
    ) {
      throw new QwenStreamError('Qwen tool call index is invalid');
    }
    const existing = toolCallsByIndex.get(index) ?? { arguments: '' };
    const id = raw['id'];
    if (id !== undefined && id !== null) {
      if (typeof id !== 'string') {
        throw new QwenStreamError('Qwen tool call id is invalid');
      }
      if (id.trim() !== '') {
        existing.id = id;
      }
    }
    const fn = raw['function'];
    let argumentsDelta = '';
    if (fn !== undefined) {
      if (!isRecord(fn)) {
        throw new QwenStreamError('Qwen tool call function is invalid');
      }
      const name = fn['name'];
      if (name !== undefined && name !== null) {
        if (typeof name !== 'string') {
          throw new QwenStreamError('Qwen tool call name is invalid');
        }
        if (name.trim() !== '') {
          existing.name = name;
        }
      }
      const argumentsValue = fn['arguments'];
      if (argumentsValue !== undefined && argumentsValue !== null) {
        if (typeof argumentsValue !== 'string') {
          throw new QwenStreamError('Qwen tool call arguments are invalid');
        }
        argumentsDelta = argumentsValue;
        existing.arguments += argumentsDelta;
      }
    }
    toolCallsByIndex.set(index, existing);
    if (
      argumentsDelta !== '' &&
      existing.id !== undefined &&
      existing.name !== undefined
    ) {
      onDelta?.({
        itemId: existing.id,
        callId: existing.id,
        name: existing.name,
        argsDelta: argumentsDelta,
      });
    }
  }
}

function finalizeQwenFunctionCalls(
  toolCallsByIndex: Map<number, AccumulatedQwenToolCall>,
  responseId: string,
): FunctionCall[] {
  return [...toolCallsByIndex.entries()]
    .sort(([left], [right]) => left - right)
    .map(([index, call]) => {
      if (call.name === undefined) {
        throw new QwenStreamError('Qwen tool call is incomplete');
      }
      const callId =
        call.id ??
        `qwen-tool-${hashProviderTraceIdentity(
          JSON.stringify({
            responseId,
            index,
            name: call.name,
            arguments: call.arguments,
          }),
        )}`;
      return {
        id: callId,
        callId,
        name: call.name,
        arguments: call.arguments,
      };
    });
}

function buildQwenAssistantBackendItem(args: {
  id: string;
  phase: 'commentary' | 'final_answer';
  text: string;
}): HistoryItem {
  return {
    kind: 'backend_item',
    data: {
      type: 'message',
      id: args.id,
      role: 'assistant',
      status: 'completed',
      phase: args.phase,
      content: [
        {
          type: 'output_text',
          text: args.text,
          annotations: [],
        },
      ],
    },
  };
}

function buildQwenFunctionCallBackendItem(call: FunctionCall): HistoryItem {
  return {
    kind: 'backend_item',
    data: {
      type: 'function_call',
      id: call.id,
      call_id: call.callId,
      name: call.name,
      arguments: call.arguments,
      status: 'completed',
    },
  };
}

function readQwenUsage(value: unknown): ProviderUsageTelemetry | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const inputTokens = readNonNegativeSafeInteger(value['prompt_tokens']);
  const outputTokens = readNonNegativeSafeInteger(value['completion_tokens']);
  const promptDetails = isRecord(value['prompt_tokens_details'])
    ? value['prompt_tokens_details']
    : undefined;
  const cachedInputTokens = readNonNegativeSafeInteger(
    promptDetails?.['cached_tokens'],
  );
  if (inputTokens !== undefined) {
    return {
      inputTokens,
      ...(outputTokens === undefined ? {} : { outputTokens }),
      ...(cachedInputTokens === undefined ? {} : { cachedInputTokens }),
    };
  }
  if (outputTokens !== undefined) {
    return {
      outputTokens,
      ...(cachedInputTokens === undefined ? {} : { cachedInputTokens }),
    };
  }
  return cachedInputTokens === undefined ? undefined : { cachedInputTokens };
}

function readNonNegativeSafeInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined;
}

function buildQwenItemId(responseId: string, suffix: string): string {
  return `${responseId.trim() === '' ? 'qwen-stream' : responseId}:${suffix}`;
}

class QwenHttpError extends Error {
  readonly status: number;

  constructor(status: number) {
    super(`Qwen request failed with status ${status}`);
    this.name = 'QwenHttpError';
    this.status = status;
  }
}

class QwenStreamError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'QwenStreamError';
  }
}
