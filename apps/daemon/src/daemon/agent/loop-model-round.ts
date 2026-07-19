import {
  callModel,
  type CallModelInput,
  type HistoryItem,
  type FunctionCall,
  type ProviderStructuredOutput,
  type ProviderUsageTelemetry,
} from '../llm/index.js';
import { createLogger } from '@geulbat/shared-utils/logger';
import type { ToolDefinition } from '../tools/types.js';
import type { AgentEventEmitter } from './events.js';
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
    now = Date.now,
  } = args;
  let attemptIndex = 0;

  modelRoundAttempts: for (;;) {
    const input: CallModelInput = {
      history,
      systemPrompt,
      tools: toolDefs,
      providerSessionId: threadId,
      providerWebSocketSessions,
      providerAuthRuntime,
      providerRequestOptions,
      ...(providerReplayScopeId === undefined ? {} : { providerReplayScopeId }),
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
      round: args.round,
      ...(args.streamArgsToolNames !== undefined
        ? { streamArgsToolNames: args.streamArgsToolNames }
        : {}),
    });

    switch (chunkResult.kind) {
      case 'success': {
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
        return {
          ok: false,
          result: emitTerminalFailure(emit, 'aborted', 'run cancelled'),
        };
      case 'stream_error':
      case 'thrown_error': {
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
}): ModelRoundFailureResolution {
  const retry = decideModelRoundRetry({
    category: args.category,
    attemptIndex: args.attemptIndex,
    sawSemanticChunk: args.sawSemanticChunk,
    policy: args.retryPolicy,
  });
  if (retry) {
    return { kind: 'retry', delayMs: retry.delayMs };
  }

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
