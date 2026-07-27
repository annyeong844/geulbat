import {
  callModel,
  type CallModelInput,
  type HistoryItem,
  type FunctionCall,
  type ProviderStructuredOutput,
  type ProviderUsageTelemetry,
} from '../llm/index.js';
import { createLogger } from '@geulbat/structured-logger/logger';
import type { ToolDefinition } from '../tools/types.js';
import type { AgentEventEmitter, AgentEventPayloadMap } from './events.js';
import {
  getErrorCode,
  getErrorMessage,
  getErrorStringProperty,
} from '../utils/error.js';
import { isRecord } from '../runtime-json.js';
import type { CallModelFn } from './loop-types.js';
import type { AgentResult } from './agent-result.js';
import type { StreamErrorCategory } from '../llm/provider/transport/stream-error.js';
import { composeAgentResult } from './agent-result.js';
import { emitTerminalFailure, type StepResult } from './loop-shared.js';
import { consumeModelRoundChunks } from './loop-model-round-chunks.js';
import {
  decideModelRoundRetry,
  emitClassifiedStreamError,
  sleepForModelRoundRetry,
} from './loop-model-round-retry.js';
type ProviderRuntimeStatusPayload = AgentEventPayloadMap['provider_status'];
type ProviderRuntimePhase = ProviderRuntimeStatusPayload['phase'];
type ProviderRequestDiagnostics = NonNullable<
  ProviderRuntimeStatusPayload['request']
>;
type ProviderRetryDiagnostics = NonNullable<
  ProviderRequestDiagnostics['retry']
>;

interface ModelRoundData {
  assistantText: string;
  terminalResult: AgentResult;
  functionCalls: FunctionCall[];
  itemsToAppend?: HistoryItem[];
  structuredOutputs?: ProviderStructuredOutput[];
  providerUsageTelemetry?: ProviderUsageTelemetry;
}

export interface RunModelRoundArgs {
  history: HistoryItem[];
  systemPrompt: string;
  round: number;
  toolDefs: ToolDefinition[];
  providerDeferredToolDefs?: ToolDefinition[];
  threadId: string;
  providerWebSocketSessions: CallModelInput['providerWebSocketSessions'];
  providerAuthRuntime: CallModelInput['providerAuthRuntime'];
  providerRequestOptions: CallModelInput['providerRequestOptions'];
  providerReplayScopeId?: CallModelInput['providerReplayScopeId'];
  signal?: AbortSignal;
  /**
   * 이 라운드만 끊는 신호 — 대기 중인 말을 지금 넣으라는 요청. 런 취소와
   * 달리 대화를 이어가려고 끊는 것이라 실패로 다루지 않는다.
   */
  interruptSignal?: AbortSignal;
  emit: AgentEventEmitter;
  callModelImpl?: CallModelFn;
  retrySleep?: (delayMs: number) => Promise<void>;
  onProviderRequestPrepared?: CallModelInput['onProviderRequestPrepared'];
  onContextPreparationRequired?: () => Promise<
    { kind: 'prepared' } | { kind: 'failed'; message: string }
  >;
  onContextOverflow?: () => Promise<boolean>;
  now?: () => number;
  streamArgsToolNames?: ReadonlySet<string>;
}

type RunModelRoundResult = StepResult<ModelRoundData>;

export interface ModelRoundPort {
  runModelRound(args: RunModelRoundArgs): Promise<RunModelRoundResult>;
}

export function createModelRoundPort(): ModelRoundPort {
  return {
    async runModelRound(args) {
      return await runModelRound(args);
    },
  };
}

type ModelRoundFailureResolution =
  | { kind: 'retry'; delayMs: number }
  | { kind: 'terminal'; result: AgentResult };

const logger = createLogger('agent/model-round');

/**
 * Model round가 턴을 이어가거나 자연 종료할 재료를 갖고 있는지.
 *
 * - tool call / structured output / artifact → 가시 prose 없이도 usable
 * - whitespace-only prose → 없음으로 본다
 * - provider history item(itemsToAppend)만 있는 thinking-only → usable 아님
 *   (opaque reasoning 항목이 있다고 빈 답을 성공으로 승격하지 않는다)
 * - stopReason=tool_calls 인데 functionCalls가 비면 usable 아님.
 *   (Qwen HTTP SSE finish_reason 전용 신호. Codex/Grok WS는 stopReason 없음.)
 */
function modelRoundSuccessHasUsableContent(args: {
  assistantText: string;
  finalText: string;
  functionCalls: readonly FunctionCall[];
  structuredOutputs: readonly ProviderStructuredOutput[];
  artifactCandidate: unknown;
  stopReason: string | undefined;
}): boolean {
  if (args.stopReason === 'tool_calls' && args.functionCalls.length === 0) {
    return false;
  }
  if (args.functionCalls.length > 0) {
    return true;
  }
  if (args.structuredOutputs.length > 0) {
    return true;
  }
  if (args.artifactCandidate !== undefined) {
    return true;
  }
  const visibleProse = (args.finalText || args.assistantText).trim();
  return visibleProse !== '';
}

function describeUnusableModelRoundContent(args: {
  stopReason: string | undefined;
  functionCalls: readonly FunctionCall[];
}): string {
  if (args.stopReason === 'tool_calls' && args.functionCalls.length === 0) {
    return 'model signaled tool calls but returned none';
  }
  return 'model returned no usable content';
}

/**
 * Responses WS history의 encrypted reasoning backend item을 제거한다.
 * provider가 blob 검증을 거부했을 때 1회 재시도 전에 호출한다.
 */
export function stripEncryptedReasoningReplayItems(
  history: HistoryItem[],
): number {
  let stripped = 0;
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const item = history[index];
    if (item === undefined || item.kind !== 'backend_item') {
      continue;
    }
    if (!isRecord(item.data)) {
      continue;
    }
    if (item.data['type'] !== 'reasoning') {
      continue;
    }
    const encrypted = item.data['encrypted_content'];
    if (typeof encrypted !== 'string' || encrypted.trim() === '') {
      continue;
    }
    history.splice(index, 1);
    stripped += 1;
  }
  return stripped;
}

export async function runModelRound(
  args: RunModelRoundArgs,
): Promise<RunModelRoundResult> {
  const {
    history,
    systemPrompt,
    toolDefs,
    providerDeferredToolDefs,
    threadId,
    providerWebSocketSessions,
    providerAuthRuntime,
    providerRequestOptions,
    providerReplayScopeId,
    signal,
    interruptSignal,
    emit,
    callModelImpl,
    retrySleep = sleepForModelRoundRetry,
    onProviderRequestPrepared,
    onContextPreparationRequired,
    onContextOverflow,
    now = Date.now,
  } = args;
  let attemptIndex = 0;
  let providerAttemptCount = 0;
  let contextPreparationAttempted = false;
  let contextOverflowRecoveryAttempted = false;
  let encryptedReplayRecoveryAttempted = false;
  const requestStartedAtMs = now();
  const requestStartedAt = new Date(requestStartedAtMs).toISOString();
  let currentProviderPhase: ProviderRuntimePhase = 'provider_waiting';
  let lastProviderEventAtMs: number | undefined;
  let retryDiagnostics: ProviderRetryDiagnostics | undefined;

  const buildProviderRequestDiagnostics = (
    observedAtMs: number,
    ended: boolean,
  ): ProviderRequestDiagnostics => ({
    startedAt: requestStartedAt,
    ...(lastProviderEventAtMs === undefined
      ? {}
      : { lastEventAt: new Date(lastProviderEventAtMs).toISOString() }),
    ...(ended
      ? {
          endedAt: new Date(observedAtMs).toISOString(),
          durationMs: Math.max(0, observedAtMs - requestStartedAtMs),
        }
      : {}),
    attemptCount: providerAttemptCount,
    ...(retryDiagnostics === undefined ? {} : { retry: retryDiagnostics }),
  });

  const emitProviderRuntimeStatus = (
    phase: ProviderRuntimePhase,
    observedAtMs: number,
    ended = false,
  ): void => {
    currentProviderPhase = phase;
    emit('provider_status', {
      phase,
      observedAt: new Date(observedAtMs).toISOString(),
      request: buildProviderRequestDiagnostics(observedAtMs, ended),
    });
  };

  modelRoundAttempts: for (;;) {
    providerAttemptCount += 1;
    emitProviderRuntimeStatus('provider_waiting', now());
    let observedProviderEventForAttempt = false;
    const input: CallModelInput = {
      history,
      systemPrompt,
      tools: toolDefs,
      ...(providerDeferredToolDefs === undefined
        ? {}
        : { deferredTools: providerDeferredToolDefs }),
      providerSessionId: threadId,
      providerWebSocketSessions,
      providerAuthRuntime,
      providerRequestOptions,
      ...(providerReplayScopeId === undefined ? {} : { providerReplayScopeId }),
      ...(onProviderRequestPrepared === undefined
        ? {}
        : { onProviderRequestPrepared }),
      onProviderRuntimeState(observation) {
        emitProviderRuntimeStatus(observation.state, now());
      },
    };
    // 소비만 멈추면 provider 요청은 계속 흐른다. 요청 자체를 끊어야 토큰도
    // 시간도 더 쓰지 않는다. 캐시된 세션은 요청 단위 abort로 죽지 않는다.
    const requestSignal =
      interruptSignal === undefined
        ? signal
        : signal === undefined
          ? interruptSignal
          : AbortSignal.any([signal, interruptSignal]);
    if (requestSignal !== undefined) {
      input.signal = requestSignal;
    }
    const chunks = (callModelImpl ?? callModel)(input);

    const chunkResult = await consumeModelRoundChunks({
      chunks,
      signal,
      ...(interruptSignal === undefined ? {} : { interruptSignal }),
      emit,
      attemptIndex,
      now,
      onProviderEventObserved(observedAtMs) {
        lastProviderEventAtMs = observedAtMs;
        if (!observedProviderEventForAttempt) {
          observedProviderEventForAttempt = true;
          emitProviderRuntimeStatus('provider_streaming', observedAtMs);
        }
      },
      round: args.round,
      ...(args.streamArgsToolNames !== undefined
        ? { streamArgsToolNames: args.streamArgsToolNames }
        : {}),
    });

    switch (chunkResult.kind) {
      case 'success': {
        if (attemptIndex > 0) {
          retryDiagnostics = {
            available: false,
            performed: true,
            outcome: 'recovered',
          };
        }
        emitProviderRuntimeStatus(currentProviderPhase, now(), true);
        // 도구 호출·구조화 출력·아티팩트·가시 prose 중 하나도 없으면 이 round는
        // 답이 아니다. thinking-only / 완전 빈 응답을 ok:true 빈 final로 승격하면
        // transcript에 빈 assistant가 남고 다음 턴이 그걸 진짜 답처럼 재생한다.
        // Qwen SSE finish_reason=tool_calls + 빈 tool_calls 도 같다 — 내레이션을
        // 최종 답으로 승격하지 않는다. 자동 nudge/재시도는 정책 owner 없이 안 한다.
        if (!modelRoundSuccessHasUsableContent(chunkResult)) {
          const message = describeUnusableModelRoundContent(chunkResult);
          logger.warn('model round returned no usable content', {
            attemptIndex,
            message,
            stopReason: chunkResult.stopReason,
            functionCallCount: chunkResult.functionCalls.length,
            structuredOutputCount: chunkResult.structuredOutputs.length,
            hasArtifactCandidate: chunkResult.artifactCandidate !== undefined,
            assistantTextLength: chunkResult.assistantText.length,
            finalTextLength: chunkResult.finalText.length,
          });
          return {
            ok: false,
            result: emitTerminalFailure(emit, 'execution_failed', message),
          };
        }
        const terminalResult =
          chunkResult.artifactCandidate !== undefined
            ? composeAgentResult({
                ok: true,
                artifactCandidate: chunkResult.artifactCandidate,
              })
            : composeAgentResult({
                ok: true,
                finalProse: chunkResult.finalText || chunkResult.assistantText,
              });
        const structuredOutputs =
          chunkResult.structuredOutputs.length > 0
            ? chunkResult.structuredOutputs
            : undefined;
        return {
          ok: true,
          value: {
            assistantText: chunkResult.assistantText,
            terminalResult,
            functionCalls: chunkResult.functionCalls,
            ...(chunkResult.itemsToAppend !== undefined
              ? { itemsToAppend: chunkResult.itemsToAppend }
              : {}),
            ...(structuredOutputs !== undefined ? { structuredOutputs } : {}),
            ...(chunkResult.providerUsageTelemetry !== undefined
              ? { providerUsageTelemetry: chunkResult.providerUsageTelemetry }
              : {}),
          },
        };
      }
      case 'interrupted': {
        emitProviderRuntimeStatus(currentProviderPhase, now(), true);
        logger.info('model round interrupted to apply a pending user message', {
          attemptIndex,
          assistantTextLength: chunkResult.assistantText.length,
          finalTextLength: chunkResult.finalText.length,
        });
        const structuredOutputs =
          chunkResult.structuredOutputs.length > 0
            ? chunkResult.structuredOutputs
            : undefined;
        return {
          ok: true,
          value: {
            assistantText: chunkResult.assistantText,
            // 끊긴 답은 최종 답이 아니다. 빈 prose로 두어 이 라운드가
            // 자연 종료 후보로 승격되지 않게 한다 — 사용자의 말이 다음
            // 라운드에서 대화를 이어간다.
            terminalResult: composeAgentResult({ ok: true, finalProse: '' }),
            functionCalls: [],
            ...(chunkResult.itemsToAppend !== undefined
              ? { itemsToAppend: chunkResult.itemsToAppend }
              : {}),
            ...(structuredOutputs !== undefined ? { structuredOutputs } : {}),
            ...(chunkResult.providerUsageTelemetry !== undefined
              ? { providerUsageTelemetry: chunkResult.providerUsageTelemetry }
              : {}),
          },
        };
      }
      case 'aborted':
        emitProviderRuntimeStatus(currentProviderPhase, now(), true);
        return {
          ok: false,
          result: emitTerminalFailure(emit, 'aborted', 'run cancelled'),
        };
      case 'stream_error':
      case 'thrown_error': {
        if (
          chunkResult.category === 'llm_context_preparation_required' &&
          !chunkResult.sawSemanticChunk &&
          !contextPreparationAttempted &&
          onContextPreparationRequired !== undefined
        ) {
          contextPreparationAttempted = true;
          const preparation = await onContextPreparationRequired();
          if (preparation.kind === 'prepared') {
            continue modelRoundAttempts;
          }
          return {
            ok: false,
            result: emitTerminalFailure(
              emit,
              'llm_context_length_exceeded',
              preparation.message,
            ),
          };
        }
        if (
          (chunkResult.category === 'llm_context_overflow' ||
            chunkResult.category === 'llm_provider_transition_required') &&
          !chunkResult.sawSemanticChunk &&
          !contextOverflowRecoveryAttempted &&
          onContextOverflow !== undefined
        ) {
          contextOverflowRecoveryAttempted = true;
          if (await onContextOverflow()) {
            continue modelRoundAttempts;
          }
        }
        // Codex/Grok Responses WS: encrypted reasoning blob 검증 실패.
        // history에서 해당 item을 벗기고 1회만 재시도한다 (Hermes one-shot).
        // strip할 item이 없으면 즉시 terminal.
        if (
          chunkResult.category === 'llm_replay_state_rejected' &&
          !chunkResult.sawSemanticChunk &&
          !encryptedReplayRecoveryAttempted
        ) {
          encryptedReplayRecoveryAttempted = true;
          const stripped = stripEncryptedReasoningReplayItems(history);
          if (stripped > 0) {
            logger.warn(
              'stripped rejected encrypted reasoning replay items; retrying once',
              { strippedItemCount: stripped, attemptIndex },
            );
            continue modelRoundAttempts;
          }
        }
        const failure = resolveModelRoundFailure({
          emit,
          category: chunkResult.category,
          error: chunkResult.error,
          attemptIndex,
          sawSemanticChunk: chunkResult.sawSemanticChunk,
          retryPolicy: providerRequestOptions.modelRoundRetry,
          ...(chunkResult.message !== undefined
            ? { message: chunkResult.message }
            : {}),
          logTerminalFailure: true,
          onRetryDecision(diagnostics, terminal) {
            retryDiagnostics = diagnostics;
            emitProviderRuntimeStatus(currentProviderPhase, now(), terminal);
          },
        });
        if (failure.kind === 'retry') {
          await retrySleep(failure.delayMs);
          attemptIndex += 1;
          continue modelRoundAttempts;
        }

        return {
          ok: false,
          result: failure.result,
        };
      }
    }
  }
}

function resolveModelRoundFailure(args: {
  emit: AgentEventEmitter;
  category: StreamErrorCategory;
  error: unknown;
  attemptIndex: number;
  sawSemanticChunk: boolean;
  retryPolicy: CallModelInput['providerRequestOptions']['modelRoundRetry'];
  message?: string;
  logTerminalFailure?: boolean;
  onRetryDecision: (
    diagnostics: ProviderRetryDiagnostics,
    terminal: boolean,
  ) => void;
}): ModelRoundFailureResolution {
  const retryDecision = decideModelRoundRetry({
    category: args.category,
    attemptIndex: args.attemptIndex,
    sawSemanticChunk: args.sawSemanticChunk,
    policy: args.retryPolicy,
  });
  if (retryDecision.kind === 'retry') {
    args.onRetryDecision(
      {
        available: true,
        performed: true,
        outcome: 'scheduled',
      },
      false,
    );
    return { kind: 'retry', delayMs: retryDecision.delayMs };
  }

  args.onRetryDecision(
    {
      available: false,
      performed: args.attemptIndex > 0,
      outcome: retryDecision.reason,
    },
    true,
  );
  if (args.logTerminalFailure) {
    logger.error('model round failed:', buildModelRoundFailureLogFields(args));
  }

  return {
    kind: 'terminal',
    result: emitClassifiedStreamError(args.emit, {
      category: args.category,
      error: args.error,
      ...(args.message !== undefined ? { message: args.message } : {}),
    }),
  };
}

function buildModelRoundFailureLogFields(args: {
  category: StreamErrorCategory;
  error: unknown;
}): {
  category: StreamErrorCategory;
  code?: string;
  providerErrorCode?: string;
  cause: string;
} {
  const code = getErrorCode(args.error);
  // provider가 준 코드는 아직 실패 클래스에 매핑되지 않는다. `unknown`으로
  // 떨어진 실패를 진단할 때 이 값이 유일한 단서다.
  const providerErrorCode = getErrorStringProperty(
    args.error,
    'providerErrorCode',
  );
  return {
    category: args.category,
    ...(code !== undefined ? { code } : {}),
    ...(providerErrorCode !== undefined ? { providerErrorCode } : {}),
    cause:
      getErrorStringProperty(args.error, 'message') ??
      getErrorMessage(args.error),
  };
}
