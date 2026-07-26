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
  threadId: string;
  providerWebSocketSessions: CallModelInput['providerWebSocketSessions'];
  providerAuthRuntime: CallModelInput['providerAuthRuntime'];
  providerRequestOptions: CallModelInput['providerRequestOptions'];
  providerReplayScopeId?: CallModelInput['providerReplayScopeId'];
  signal?: AbortSignal;
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

export async function runModelRound(
  args: RunModelRoundArgs,
): Promise<RunModelRoundResult> {
  const {
    history,
    systemPrompt,
    toolDefs,
    threadId,
    providerWebSocketSessions,
    providerAuthRuntime,
    providerRequestOptions,
    providerReplayScopeId,
    signal,
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
    if (signal !== undefined) {
      input.signal = signal;
    }
    const chunks = (callModelImpl ?? callModel)(input);

    const chunkResult = await consumeModelRoundChunks({
      chunks,
      signal,
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
  cause: string;
} {
  const code = getErrorCode(args.error);
  return {
    category: args.category,
    ...(code !== undefined ? { code } : {}),
    cause:
      getErrorStringProperty(args.error, 'message') ??
      getErrorMessage(args.error),
  };
}
