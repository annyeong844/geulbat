import type { RunSessionStateAction } from './run-session-state-types.js';
import type { RunSessionMessageEffect } from './run-session-message-effects.js';

// Coalescing window for streamed assistant deltas. Long answers arrive as many
// tiny deltas (~40/s); a one-frame (~16ms) window is shorter than the typical
// inter-delta gap, so deltas were each dispatched separately and re-rendered the
// transcript per delta. A wider window batches deltas in the same target into one
// dispatch, cutting render/reflow churn during streaming.
export const RUN_SESSION_STREAM_BATCH_WINDOW_MS = 48;

type StreamedTextEffect = Extract<
  RunSessionMessageEffect,
  { kind: 'assistant_text_streamed' }
>;

type StreamedToolArgsEffect = Extract<
  RunSessionMessageEffect,
  { kind: 'tool_call_args_streamed' }
>;

type BatchedStreamEffect = StreamedTextEffect | StreamedToolArgsEffect;

function dispatchStreamedEffect(
  dispatch: (action: RunSessionStateAction) => void,
  effect: BatchedStreamEffect,
): void {
  if (effect.kind === 'tool_call_args_streamed') {
    dispatch({
      type: 'tool_call_args_streamed',
      threadId: effect.threadId,
      callId: effect.callId,
      tool: effect.tool,
      argsDelta: effect.argsDelta,
    });
    return;
  }
  dispatch({
    type: 'assistant_text_streamed',
    threadId: effect.threadId,
    target: effect.target,
    text: effect.text,
  });
}

// 같은 대상의 연속 델타는 한 디스패치로 합친다
function mergeStreamedEffect(
  last: BatchedStreamEffect | undefined,
  effect: BatchedStreamEffect,
): boolean {
  if (last === undefined || last.kind !== effect.kind) {
    return false;
  }
  if (
    last.kind === 'tool_call_args_streamed' &&
    effect.kind === 'tool_call_args_streamed'
  ) {
    if (last.threadId !== effect.threadId || last.callId !== effect.callId) {
      return false;
    }
    last.argsDelta += effect.argsDelta;
    return true;
  }
  if (
    last.kind === 'assistant_text_streamed' &&
    effect.kind === 'assistant_text_streamed'
  ) {
    if (last.threadId !== effect.threadId || last.target !== effect.target) {
      return false;
    }
    last.text += effect.text;
    return true;
  }
  return false;
}

export function createRunSessionStreamBatchController(options: {
  readDispatch: () => (action: RunSessionStateAction) => void;
}): {
  queueStreamedTextEffect(
    effect: Extract<
      RunSessionMessageEffect,
      { kind: 'assistant_text_streamed' }
    >,
  ): void;
  queueStreamedToolArgsEffect(effect: StreamedToolArgsEffect): void;
  flushPendingStreamEffects(): void;
  clearPendingStreamEffects(): void;
} {
  let effects: BatchedStreamEffect[] = [];
  let cancelScheduledFlush: (() => void) | null = null;

  const flushPendingStreamEffects = () => {
    const pendingEffects = effects;
    effects = [];
    cancelScheduledFlush?.();
    cancelScheduledFlush = null;

    for (const effect of pendingEffects) {
      dispatchStreamedEffect(options.readDispatch(), effect);
    }
  };

  const clearPendingStreamEffects = () => {
    cancelScheduledFlush?.();
    cancelScheduledFlush = null;
    effects = [];
  };

  const queueBatchedStreamEffect = (effect: BatchedStreamEffect) => {
    if (cancelScheduledFlush === null && effects.length === 0) {
      dispatchStreamedEffect(options.readDispatch(), effect);
      cancelScheduledFlush = scheduleRunSessionStreamFlush(() => {
        cancelScheduledFlush = null;
        flushPendingStreamEffects();
      });
      return;
    }

    if (!mergeStreamedEffect(effects.at(-1), effect)) {
      effects.push({ ...effect });
    }

    if (cancelScheduledFlush) {
      return;
    }

    cancelScheduledFlush = scheduleRunSessionStreamFlush(() => {
      cancelScheduledFlush = null;
      flushPendingStreamEffects();
    });
  };

  return {
    queueStreamedTextEffect: queueBatchedStreamEffect,
    queueStreamedToolArgsEffect: queueBatchedStreamEffect,
    flushPendingStreamEffects,
    clearPendingStreamEffects,
  };
}

function scheduleRunSessionStreamFlush(flush: () => void): () => void {
  // Use a fixed time window rather than requestAnimationFrame: rAF fires at the
  // next frame (~16ms) regardless of RUN_SESSION_STREAM_BATCH_WINDOW_MS, which is
  // too short to coalesce deltas that arrive slower than one per frame.
  const timeoutId = setTimeout(flush, RUN_SESSION_STREAM_BATCH_WINDOW_MS);
  return () => {
    clearTimeout(timeoutId);
  };
}
