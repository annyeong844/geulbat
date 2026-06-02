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

function dispatchStreamedTextEffect(
  dispatch: (action: RunSessionStateAction) => void,
  effect: StreamedTextEffect,
): void {
  dispatch({
    type: 'assistant_text_streamed',
    threadId: effect.threadId,
    target: effect.target,
    text: effect.text,
  });
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
  flushPendingStreamEffects(): void;
  clearPendingStreamEffects(): void;
} {
  let effects: StreamedTextEffect[] = [];
  let cancelScheduledFlush: (() => void) | null = null;

  const flushPendingStreamEffects = () => {
    const pendingEffects = effects;
    effects = [];
    cancelScheduledFlush?.();
    cancelScheduledFlush = null;

    for (const effect of pendingEffects) {
      dispatchStreamedTextEffect(options.readDispatch(), effect);
    }
  };

  const clearPendingStreamEffects = () => {
    cancelScheduledFlush?.();
    cancelScheduledFlush = null;
    effects = [];
  };

  return {
    queueStreamedTextEffect(effect) {
      if (cancelScheduledFlush === null && effects.length === 0) {
        dispatchStreamedTextEffect(options.readDispatch(), effect);
        cancelScheduledFlush = scheduleRunSessionStreamFlush(() => {
          cancelScheduledFlush = null;
          flushPendingStreamEffects();
        });
        return;
      }

      const lastEffect = effects.at(-1);
      if (
        lastEffect &&
        lastEffect.threadId === effect.threadId &&
        lastEffect.target === effect.target
      ) {
        lastEffect.text += effect.text;
      } else {
        effects.push({ ...effect });
      }

      if (cancelScheduledFlush) {
        return;
      }

      cancelScheduledFlush = scheduleRunSessionStreamFlush(() => {
        cancelScheduledFlush = null;
        flushPendingStreamEffects();
      });
    },
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
