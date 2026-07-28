import { AGENT_ARTIFACT_START_PREFIX as ARTIFACT_START_PREFIX } from './contract.js';

import type {
  FunctionCall,
  HistoryItem,
  LLMChunk,
  ModelRoundStopReason,
  ProviderStructuredOutput,
  ProviderUsageTelemetry,
} from '../llm/index.js';
import {
  classifyStreamError,
  type StreamErrorCategory,
} from '../llm/provider/transport/stream-error.js';
import type { AgentArtifactCandidate } from './agent-result.js';
import {
  createAgentEvent,
  type AgentEvent,
  type AgentEventEmitter,
} from './events.js';

// Match the established web projection cadence so the daemon reduces journal
// and transport churn without adding a slower second buffering horizon.
const MODEL_ROUND_DELTA_BATCH_WINDOW_MS = 48;

type BatchableModelRoundEvent = Extract<
  AgentEvent,
  {
    type: 'commentary_delta' | 'final_answer_delta' | 'tool_call_delta';
  }
>;

type ScheduleModelRoundDeltaFlush = (flush: () => void) => () => void;

interface ModelRoundChunkSuccess {
  kind: 'success';
  assistantText: string;
  finalText: string;
  artifactCandidate: AgentArtifactCandidate | undefined;
  functionCalls: FunctionCall[];
  itemsToAppend: HistoryItem[] | undefined;
  structuredOutputs: ProviderStructuredOutput[];
  providerUsageTelemetry: ProviderUsageTelemetry | undefined;
  stopReason: ModelRoundStopReason | undefined;
}

interface ModelRoundChunkStreamError {
  kind: 'stream_error';
  category: StreamErrorCategory;
  error: unknown;
  message?: string;
  sawSemanticChunk: boolean;
}

interface ModelRoundChunkThrownError {
  kind: 'thrown_error';
  category: StreamErrorCategory;
  error: unknown;
  message?: string;
  sawSemanticChunk: boolean;
}

interface ModelRoundChunkAborted {
  kind: 'aborted';
}

/**
 * 사용자가 대기 중인 말을 "지금" 넣으라고 해서 이 라운드를 끊었다.
 *
 * `aborted`(런 취소)와 다르다: 대화를 끝내려는 것이 아니라 이어가려고 끊은
 * 것이므로 실패가 아니다. 여기까지 모델이 한 말은 그대로 싣는다 — 화면에 이미
 * 흘렀으므로 히스토리에서 사라지면 다음 라운드가 그 말을 안 한 것처럼 이어간다.
 *
 * 도구 호출은 싣지 않는다. 인자가 반쯤 온 호출을 실행하면 사용자가 부탁한 적
 * 없는 일을 하게 된다.
 */
interface ModelRoundChunkInterrupted {
  kind: 'interrupted';
  assistantText: string;
  finalText: string;
  itemsToAppend: HistoryItem[] | undefined;
  structuredOutputs: ProviderStructuredOutput[];
  providerUsageTelemetry: ProviderUsageTelemetry | undefined;
}

type ModelRoundChunkResult =
  | ModelRoundChunkSuccess
  | ModelRoundChunkStreamError
  | ModelRoundChunkThrownError
  | ModelRoundChunkAborted
  | ModelRoundChunkInterrupted;

export async function consumeModelRoundChunks(args: {
  chunks: AsyncIterable<LLMChunk>;
  signal: AbortSignal | undefined;
  /**
   * 이 라운드만 끊는 신호. 사용자가 대기 중인 말을 "지금" 넣으라고 했을 때
   * 켜진다.
   *
   * 런 취소(`signal`)와 구별해야 한다: 런 취소는 대화를 끝내지만, 이쪽은
   * 대화를 이어가려고 끊는 것이다. 그래서 여기까지 모은 말을 버리지 않고
   * 정상 종료로 돌려준다 — 모델이 방금까지 한 말은 화면에 이미 흘렀고,
   * 히스토리에서 사라지면 다음 라운드가 그 말을 안 한 것처럼 이어간다.
   *
   * 도구 호출은 싣지 않는다. 스트리밍 도중이라 인자가 반쯤 온 호출을 실행하면
   * 사용자가 부탁한 적 없는 일을 하게 된다.
   */
  interruptSignal?: AbortSignal;
  emit: AgentEventEmitter;
  attemptIndex: number;
  now: () => number;
  onProviderEventObserved?: (observedAtMs: number) => void;
  round?: number;
  // 인자 스트리밍 opt-in 도구 목록 (ToolMeta.streamsArgsDelta) — 목록에
  // 없는 도구의 델타는 버린다 (전송 낭비 방지)
  streamArgsToolNames?: ReadonlySet<string>;
  scheduleDeltaFlush?: ScheduleModelRoundDeltaFlush;
}): Promise<ModelRoundChunkResult> {
  const { chunks, signal, interruptSignal, emit, now } = args;
  const functionCalls: FunctionCall[] = [];
  let assistantText = '';
  let finalText = '';
  let artifactCandidate: AgentArtifactCandidate | undefined;
  let structuredOutputs: ProviderStructuredOutput[] = [];
  let itemsToAppend: HistoryItem[] | undefined;
  let providerUsageTelemetry: ProviderUsageTelemetry | undefined;
  let stopReason: ModelRoundStopReason | undefined;
  let sawSemanticChunk = false;
  const deltaBatcher = createModelRoundDeltaBatcher({
    emit,
    scheduleFlush:
      args.scheduleDeltaFlush ?? scheduleDefaultModelRoundDeltaFlush,
  });
  const finalAnswerDeltaEmitter = createFinalAnswerDeltaEmitter(
    deltaBatcher.emit,
  );

  // 런 취소가 함께 걸렸다면 그쪽이 이긴다 — 끝내라는 지시가 이어가라는
  // 지시보다 강하다.
  const interruptedForSteer = (): boolean =>
    interruptSignal?.aborted === true && signal?.aborted !== true;
  const buildInterruptedResult = (): ModelRoundChunkResult => {
    deltaBatcher.flush();
    return {
      kind: 'interrupted',
      assistantText,
      finalText,
      itemsToAppend,
      structuredOutputs,
      providerUsageTelemetry,
    };
  };

  try {
    for await (const chunk of chunks) {
      if (interruptedForSteer()) {
        return buildInterruptedResult();
      }
      if (signal?.aborted) {
        deltaBatcher.flush();
        return { kind: 'aborted' };
      }

      const chunkReceivedAtMs = now();
      args.onProviderEventObserved?.(chunkReceivedAtMs);

      switch (chunk.type) {
        case 'text_delta': {
          sawSemanticChunk = true;
          if (chunk.phase === 'final_answer') {
            finalText += chunk.text;
            finalAnswerDeltaEmitter.push(chunk.text);
          } else {
            deltaBatcher.emit('commentary_delta', { text: chunk.text });
          }
          assistantText += chunk.text;
          break;
        }
        case 'tool_call_delta':
          if (
            chunk.argsDelta &&
            args.streamArgsToolNames?.has(chunk.toolName) === true
          ) {
            sawSemanticChunk = true;
            deltaBatcher.emit('tool_call_delta', {
              callId: chunk.callId,
              step: args.round ?? 0,
              tool: chunk.toolName,
              argsDelta: chunk.argsDelta,
            });
          }
          break;
        case 'tool_call':
          sawSemanticChunk = true;
          functionCalls.push({
            id: chunk.id,
            callId: chunk.callId,
            name: chunk.toolName,
            arguments: chunk.argumentsJson,
          });
          break;
        case 'done':
          assistantText = chunk.assistantText ?? assistantText;
          finalText = chunk.finalText ?? finalText;
          artifactCandidate = chunk.artifactCandidate ?? artifactCandidate;
          structuredOutputs =
            chunk.structuredOutputs !== undefined
              ? [...chunk.structuredOutputs]
              : structuredOutputs;
          itemsToAppend =
            chunk.itemsToAppend !== undefined
              ? [...chunk.itemsToAppend]
              : itemsToAppend;
          providerUsageTelemetry =
            chunk.providerUsageTelemetry ?? providerUsageTelemetry;
          stopReason = chunk.stopReason ?? stopReason;
          break;
        case 'error':
          deltaBatcher.flush();
          return {
            kind: 'stream_error',
            category: classifyStreamError(chunk),
            error: chunk,
            ...(chunk.message !== undefined ? { message: chunk.message } : {}),
            sawSemanticChunk,
          };
      }
    }

    if (interruptedForSteer()) {
      return buildInterruptedResult();
    }
    if (signal?.aborted) {
      deltaBatcher.flush();
      return { kind: 'aborted' };
    }

    const finalProse = finalText || assistantText;
    if (
      functionCalls.length === 0 &&
      artifactCandidate === undefined &&
      finalProse
    ) {
      finalAnswerDeltaEmitter.flushOrEmitFallback(finalProse);
    } else {
      finalAnswerDeltaEmitter.clear();
    }
    deltaBatcher.flush();

    return {
      kind: 'success',
      assistantText,
      finalText,
      artifactCandidate,
      functionCalls,
      itemsToAppend,
      structuredOutputs,
      providerUsageTelemetry,
      stopReason,
    };
  } catch (error: unknown) {
    let failure = error;
    try {
      deltaBatcher.flush();
    } catch (flushError: unknown) {
      failure = flushError;
    }
    // 요청이 인터럽트 신호로 끊기면 여기로 떨어진다 — 전송 오류가 아니다.
    if (interruptedForSteer()) {
      return buildInterruptedResult();
    }
    if (signal?.aborted) {
      return { kind: 'aborted' };
    }
    return {
      kind: 'thrown_error',
      category: classifyStreamError(failure),
      error: failure,
      sawSemanticChunk,
    };
  }
}

function createModelRoundDeltaBatcher(args: {
  emit: AgentEventEmitter;
  scheduleFlush: ScheduleModelRoundDeltaFlush;
}): { emit: AgentEventEmitter; flush(): void } {
  let activeEvent: BatchableModelRoundEvent | undefined;
  let pendingEvent: BatchableModelRoundEvent | undefined;
  let cancelScheduledFlush: (() => void) | undefined;
  let scheduledFailure: Error | undefined;

  const throwScheduledFailure = () => {
    if (scheduledFailure !== undefined) {
      throw scheduledFailure;
    }
  };
  const dispatch = (event: BatchableModelRoundEvent) => {
    switch (event.type) {
      case 'commentary_delta':
        args.emit('commentary_delta', event.payload);
        return;
      case 'final_answer_delta':
        args.emit('final_answer_delta', event.payload);
        return;
      case 'tool_call_delta':
        args.emit('tool_call_delta', event.payload);
    }
  };
  const scheduleWindow = () => {
    cancelScheduledFlush = args.scheduleFlush(() => {
      cancelScheduledFlush = undefined;
      if (pendingEvent === undefined) {
        activeEvent = undefined;
        return;
      }
      const event = pendingEvent;
      pendingEvent = undefined;
      try {
        dispatch(event);
        activeEvent = event;
        scheduleWindow();
      } catch (error: unknown) {
        activeEvent = undefined;
        scheduledFailure =
          error instanceof Error
            ? error
            : new Error('model-round delta delivery failed', { cause: error });
      }
    });
  };
  const cancelWindow = () => {
    cancelScheduledFlush?.();
    cancelScheduledFlush = undefined;
  };
  const flushPending = () => {
    const event = pendingEvent;
    pendingEvent = undefined;
    if (event !== undefined) {
      dispatch(event);
    }
  };
  const flush = () => {
    cancelWindow();
    throwScheduledFailure();
    activeEvent = undefined;
    flushPending();
  };
  const batchedEmit: AgentEventEmitter = (type, payload) => {
    throwScheduledFailure();
    const event = createAgentEvent(type, payload);
    if (!isBatchableModelRoundEvent(event)) {
      flush();
      args.emit(type, payload);
      return;
    }
    if (cancelScheduledFlush === undefined || activeEvent === undefined) {
      dispatch(event);
      activeEvent = event;
      scheduleWindow();
      return;
    }
    if (isSameModelRoundDeltaLane(activeEvent, event)) {
      pendingEvent =
        pendingEvent === undefined
          ? event
          : mergeBatchableModelRoundEvents(pendingEvent, event);
      return;
    }
    cancelWindow();
    flushPending();
    dispatch(event);
    activeEvent = event;
    scheduleWindow();
  };

  return { emit: batchedEmit, flush };
}

function isBatchableModelRoundEvent(
  event: AgentEvent,
): event is BatchableModelRoundEvent {
  return (
    event.type === 'commentary_delta' ||
    event.type === 'final_answer_delta' ||
    event.type === 'tool_call_delta'
  );
}

function isSameModelRoundDeltaLane(
  left: BatchableModelRoundEvent,
  right: BatchableModelRoundEvent,
): boolean {
  if (left.type !== right.type) {
    return false;
  }
  if (left.type !== 'tool_call_delta' || right.type !== 'tool_call_delta') {
    return true;
  }
  return (
    left.payload.callId === right.payload.callId &&
    left.payload.step === right.payload.step &&
    left.payload.tool === right.payload.tool
  );
}

function mergeBatchableModelRoundEvents(
  left: BatchableModelRoundEvent,
  right: BatchableModelRoundEvent,
): BatchableModelRoundEvent {
  if (left.type === 'tool_call_delta' && right.type === 'tool_call_delta') {
    return {
      ...left,
      payload: {
        ...left.payload,
        argsDelta: left.payload.argsDelta + right.payload.argsDelta,
      },
    };
  }
  if (left.type === 'commentary_delta' && right.type === 'commentary_delta') {
    return {
      ...left,
      payload: { text: left.payload.text + right.payload.text },
    };
  }
  if (
    left.type === 'final_answer_delta' &&
    right.type === 'final_answer_delta'
  ) {
    return {
      ...left,
      payload: { text: left.payload.text + right.payload.text },
    };
  }
  return right;
}

function scheduleDefaultModelRoundDeltaFlush(flush: () => void): () => void {
  const timeout = setTimeout(flush, MODEL_ROUND_DELTA_BATCH_WINDOW_MS);
  return () => clearTimeout(timeout);
}

function createFinalAnswerDeltaEmitter(emit: AgentEventEmitter): {
  push(text: string): void;
  flushOrEmitFallback(fallbackText: string): void;
  clear(): void;
} {
  let bufferedPrefix = '';
  let streaming = false;
  let emitted = false;
  // 아티팩트 전용 답변으로 확정된 뒤 artifact_stream_delta로 이미 흘려보낸
  // bufferedPrefix 길이 — 채팅 억제는 유지하면서 생성 과정을 중앙 아티팩트
  // 창에 실시간으로 보여준다.
  let artifactStreamedLength = 0;

  const emitDelta = (text: string) => {
    if (!text) {
      return;
    }
    emitted = true;
    emit('final_answer_delta', { text });
  };

  return {
    push(text) {
      if (streaming) {
        emitDelta(text);
        return;
      }

      bufferedPrefix += text;
      if (isPotentialArtifactOnlyEnvelopePrefix(bufferedPrefix)) {
        if (isConfirmedArtifactEnvelopePrefix(bufferedPrefix)) {
          const chunk = bufferedPrefix.slice(artifactStreamedLength);
          if (chunk) {
            emit('artifact_stream_delta', { text: chunk });
            artifactStreamedLength = bufferedPrefix.length;
          }
        }
        return;
      }

      streaming = true;
      emitDelta(bufferedPrefix);
      bufferedPrefix = '';
      artifactStreamedLength = 0;
    },
    flushOrEmitFallback(fallbackText) {
      if (bufferedPrefix) {
        emitDelta(bufferedPrefix);
        bufferedPrefix = '';
        streaming = true;
        return;
      }
      if (!emitted) {
        emitDelta(fallbackText);
      }
    },
    clear() {
      bufferedPrefix = '';
      artifactStreamedLength = 0;
    },
  };
}

function isPotentialArtifactOnlyEnvelopePrefix(text: string): boolean {
  const trimmedStart = text.trimStart();
  return (
    trimmedStart === '' ||
    ARTIFACT_START_PREFIX.startsWith(trimmedStart) ||
    trimmedStart.startsWith(ARTIFACT_START_PREFIX)
  );
}

// 접두가 봉투 시작 마커를 완전히 지나 아티팩트 전용 답변으로 확정된 상태 —
// 이때부터 artifact_stream_delta 라이브 스트림을 흘린다.
function isConfirmedArtifactEnvelopePrefix(text: string): boolean {
  return text.trimStart().startsWith(ARTIFACT_START_PREFIX);
}
