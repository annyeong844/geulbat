import {
  callModel,
  type CallModelInput,
  type HistoryItem,
  type FunctionCall,
} from '../llm/index.js';
import { createLogger } from '@geulbat/shared-utils/logger';
import type { ToolDefinition } from '../tools/types.js';
import type { AgentEventEmitter } from './events.js';
import { getErrorMessage } from '../utils/error.js';
import type { CallModelFn } from './loop-types.js';
import type { AgentResult } from './agent-result.js';
import type { StreamErrorCategory } from '../llm/provider/transport/stream-error.js';
import { composeAgentResult } from './agent-result.js';
import {
  emitInternalError,
  emitTerminalFailure,
  type StepResult,
} from './loop-shared.js';
import {
  consumeFinalizationChunks,
  consumeModelRoundChunks,
  createFinalAnswerDeltaEmitter,
} from './loop-model-round-chunks.js';
import {
  decideModelRoundRetry,
  emitClassifiedStreamError,
  sleepForModelRoundRetry,
} from './loop-model-round-retry.js';

interface ModelRoundData {
  assistantText: string;
  terminalResult: AgentResult;
  functionCalls: FunctionCall[];
}

type ModelRoundFailureResolution =
  | { kind: 'retry'; delayMs: number }
  | { kind: 'terminal'; result: AgentResult };

const FINALIZE_SUFFIX = `\n\n[Tool limit reached]\nNo more tool calls allowed. Summarize findings and provide a final answer.`;
const logger = createLogger('agent/model-round');

export async function runModelRound(args: {
  history: HistoryItem[];
  systemPrompt: string;
  promptContext: string;
  pendingBackgroundSystemNote: string;
  round: number;
  toolDefs: ToolDefinition[];
  threadId: string;
  providerWebSocketSessions: CallModelInput['providerWebSocketSessions'];
  providerAuthRuntime: CallModelInput['providerAuthRuntime'];
  signal?: AbortSignal;
  emit: AgentEventEmitter;
  callModelImpl?: CallModelFn;
  retrySleep?: (delayMs: number) => Promise<void>;
  now?: () => number;
}): Promise<StepResult<ModelRoundData>> {
  const {
    history,
    systemPrompt,
    promptContext,
    pendingBackgroundSystemNote,
    round,
    toolDefs,
    threadId,
    providerWebSocketSessions,
    providerAuthRuntime,
    signal,
    emit,
    callModelImpl,
    retrySleep = sleepForModelRoundRetry,
    now = Date.now,
  } = args;
  let attemptIndex = 0;

  modelRoundAttempts: for (;;) {
    const roundPrompt = [
      systemPrompt,
      promptContext,
      round === 0 ? pendingBackgroundSystemNote : '',
    ]
      .filter(Boolean)
      .join('\n\n');

    const input: CallModelInput = {
      history,
      systemPrompt: roundPrompt,
      tools: toolDefs,
      providerSessionId: threadId,
      providerWebSocketSessions,
      providerAuthRuntime,
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
        return {
          ok: true,
          value: {
            assistantText: chunkResult.assistantText,
            terminalResult,
            functionCalls: chunkResult.functionCalls,
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
          ...(chunkResult.message !== undefined
            ? { message: chunkResult.message }
            : {}),
          ...(chunkResult.kind === 'thrown_error'
            ? { logTerminalFailure: true }
            : {}),
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
  message?: string;
  logTerminalFailure?: boolean;
}): ModelRoundFailureResolution {
  const retry = decideModelRoundRetry({
    category: args.category,
    attemptIndex: args.attemptIndex,
    sawSemanticChunk: args.sawSemanticChunk,
  });
  if (retry) {
    return { kind: 'retry', delayMs: retry.delayMs };
  }

  if (args.logTerminalFailure) {
    logger.error('model round failed:', {
      category: args.category,
      cause: getErrorMessage(args.error),
    });
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

export async function finalizeAfterToolLimit(args: {
  history: HistoryItem[];
  systemPrompt: string;
  threadId: string;
  providerWebSocketSessions: CallModelInput['providerWebSocketSessions'];
  providerAuthRuntime: CallModelInput['providerAuthRuntime'];
  signal?: AbortSignal;
  emit: AgentEventEmitter;
  callModelImpl?: CallModelFn;
}): Promise<AgentResult> {
  const {
    history,
    systemPrompt,
    threadId,
    providerWebSocketSessions,
    providerAuthRuntime,
    signal,
    emit,
    callModelImpl,
  } = args;
  try {
    const input: CallModelInput = {
      history,
      systemPrompt: systemPrompt + FINALIZE_SUFFIX,
      tools: [],
      providerSessionId: threadId,
      providerWebSocketSessions,
      providerAuthRuntime,
    };
    if (signal !== undefined) {
      input.signal = signal;
    }
    const finalChunks = (callModelImpl ?? callModel)(input);

    const finalAnswerDeltaEmitter = createFinalAnswerDeltaEmitter(emit);
    const chunkResult = await consumeFinalizationChunks({
      chunks: finalChunks,
      finalAnswerDeltaEmitter,
    });
    if (chunkResult.kind === 'failure') {
      throw chunkResult.error;
    }

    const { answer, finalText, artifactCandidate } = chunkResult;
    const hasModelOutput = finalText.trim() !== '' || answer.trim() !== '';
    const finalAnswer = finalText || answer || 'max tool rounds reached';
    const result =
      artifactCandidate !== undefined
        ? composeAgentResult({
            ok: false,
            artifactCandidate,
          })
        : composeAgentResult({
            ok: false,
            finalProse: finalAnswer,
          });
    if (result.artifactCandidate !== undefined) {
      finalAnswerDeltaEmitter.clear();
    } else if (result.finalProse && hasModelOutput) {
      finalAnswerDeltaEmitter.flushOrEmitFallback(result.finalProse);
    } else {
      finalAnswerDeltaEmitter.clear();
    }
    return result;
  } catch (error: unknown) {
    logger.error('finalize after tool limit failed:', getErrorMessage(error));
    emitInternalError(emit);
    return { ok: false, finalProse: '' };
  }
}
