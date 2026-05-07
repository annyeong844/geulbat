import type { RunSessionStateAction } from './run-session-state-types.js';
import type { RunSessionMessageEffect } from './run-session-message-effects.js';

export const RUN_SESSION_STREAM_BATCH_WINDOW_MS = 16;

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
  if (typeof requestAnimationFrame === 'function') {
    const frameId = requestAnimationFrame(flush);
    return () => {
      cancelAnimationFrame(frameId);
    };
  }

  const timeoutId = setTimeout(flush, RUN_SESSION_STREAM_BATCH_WINDOW_MS);
  return () => {
    clearTimeout(timeoutId);
  };
}
