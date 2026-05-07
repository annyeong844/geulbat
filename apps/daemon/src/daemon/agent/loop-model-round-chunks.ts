import { ARTIFACT_START_PREFIX } from '@geulbat/protocol/artifacts';
import { createLogger } from '@geulbat/shared-utils/logger';

import type { FunctionCall, LLMChunk } from '../llm/index.js';
import {
  classifyStreamError,
  type StreamErrorCategory,
} from '../llm/provider/transport/stream-error.js';
import type { AgentArtifactCandidate } from './agent-result.js';
import type { AgentEventEmitter } from './events.js';

const logger = createLogger('agent/model-round');
const MODEL_ROUND_STALL_WARNING_MS = 10_000;

interface ModelRoundChunkSuccess {
  kind: 'success';
  assistantText: string;
  finalText: string;
  artifactCandidate: AgentArtifactCandidate | undefined;
  functionCalls: FunctionCall[];
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

type ModelRoundChunkResult =
  | ModelRoundChunkSuccess
  | ModelRoundChunkStreamError
  | ModelRoundChunkThrownError
  | ModelRoundChunkAborted;

export async function consumeModelRoundChunks(args: {
  chunks: AsyncIterable<LLMChunk>;
  signal: AbortSignal | undefined;
  emit: AgentEventEmitter;
  attemptIndex: number;
  now: () => number;
}): Promise<ModelRoundChunkResult> {
  const { chunks, signal, emit, attemptIndex, now } = args;
  const functionCalls: FunctionCall[] = [];
  let assistantText = '';
  let finalText = '';
  let artifactCandidate: AgentArtifactCandidate | undefined;
  let sawSemanticChunk = false;
  let lastChunkAtMs = now();
  const finalAnswerDeltaEmitter = createFinalAnswerDeltaEmitter(emit);

  try {
    for await (const chunk of chunks) {
      if (signal?.aborted) break;

      const chunkReceivedAtMs = now();
      warnIfModelRoundStalled({
        attemptIndex,
        elapsedMs: chunkReceivedAtMs - lastChunkAtMs,
      });
      lastChunkAtMs = chunkReceivedAtMs;

      switch (chunk.type) {
        case 'text_delta': {
          sawSemanticChunk = true;
          if (chunk.phase === 'final_answer') {
            finalText += chunk.text;
            finalAnswerDeltaEmitter.push(chunk.text);
          } else {
            emit('commentary_delta', { text: chunk.text });
          }
          assistantText += chunk.text;
          break;
        }
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
          break;
        case 'error':
          return {
            kind: 'stream_error',
            category: classifyStreamError(chunk),
            error: chunk,
            ...(chunk.message !== undefined ? { message: chunk.message } : {}),
            sawSemanticChunk,
          };
      }
    }
  } catch (error: unknown) {
    if (signal?.aborted) {
      return { kind: 'aborted' };
    }
    return {
      kind: 'thrown_error',
      category: classifyStreamError(error),
      error,
      sawSemanticChunk,
    };
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

  return {
    kind: 'success',
    assistantText,
    finalText,
    artifactCandidate,
    functionCalls,
  };
}

export function createFinalAnswerDeltaEmitter(emit: AgentEventEmitter): {
  push(text: string): void;
  flushOrEmitFallback(fallbackText: string): void;
  clear(): void;
} {
  let bufferedPrefix = '';
  let streaming = false;
  let emitted = false;

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
        return;
      }

      streaming = true;
      emitDelta(bufferedPrefix);
      bufferedPrefix = '';
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

function warnIfModelRoundStalled(args: {
  attemptIndex: number;
  elapsedMs: number;
}): void {
  if (args.elapsedMs <= MODEL_ROUND_STALL_WARNING_MS) {
    return;
  }
  logger.warn('model stream stalled between chunks', {
    attemptIndex: args.attemptIndex,
    elapsedMs: args.elapsedMs,
  });
}
