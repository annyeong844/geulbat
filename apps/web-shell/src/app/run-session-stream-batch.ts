import type { RunSessionStateAction } from './run-session-state-types.js';
import type { RunSessionMessageEffect } from './run-session-message-effects.js';

// Shared display window for streamed assistant deltas and short bursts of
// tool/subagent activity. The first effect remains immediate; later effects keep
// arrival order inside the window, while adjacent deltas for one target coalesce.
// This limits transcript render/reflow churn without delaying initial feedback.
export const RUN_SESSION_STREAM_BATCH_WINDOW_MS = 48;

type StreamedTextEffect = Extract<
  RunSessionMessageEffect,
  { kind: 'assistant_text_streamed' }
>;

type StreamedToolArgsEffect = Extract<
  RunSessionMessageEffect,
  { kind: 'tool_call_args_streamed' }
>;

type StreamedToolOutputEffect = Extract<
  RunSessionMessageEffect,
  { kind: 'tool_output_streamed' }
>;

type DisplayEffect = Extract<
  RunSessionMessageEffect,
  { kind: 'transcript_activity_added' | 'subagent_activity_added' }
>;

type BatchedRunSessionEffect =
  | StreamedTextEffect
  | StreamedToolArgsEffect
  | StreamedToolOutputEffect
  | DisplayEffect;

function dispatchBatchedEffect(
  dispatch: (action: RunSessionStateAction) => void,
  effect: BatchedRunSessionEffect,
): void {
  switch (effect.kind) {
    case 'tool_call_args_streamed':
      dispatch({
        type: 'tool_call_args_streamed',
        threadId: effect.threadId,
        callId: effect.callId,
        tool: effect.tool,
        argsDelta: effect.argsDelta,
      });
      return;
    case 'tool_output_streamed':
      dispatch({
        type: 'tool_output_streamed',
        threadId: effect.threadId,
        callId: effect.callId,
        tool: effect.tool,
        stream: effect.stream,
        text: effect.text,
      });
      return;
    case 'assistant_text_streamed':
      dispatch({
        type: 'assistant_text_streamed',
        threadId: effect.threadId,
        target: effect.target,
        text: effect.text,
      });
      return;
    case 'transcript_activity_added':
      dispatch({
        type: 'transcript_activity_added',
        threadId: effect.threadId,
        entry: effect.entry,
        ...(effect.streamedToolCallId === undefined
          ? {}
          : { streamedToolCallId: effect.streamedToolCallId }),
      });
      return;
    case 'subagent_activity_added':
      dispatch({
        type: 'subagent_activity_added',
        threadId: effect.threadId,
        entry: effect.entry,
      });
  }
}

// 같은 대상의 연속 델타는 한 디스패치로 합친다
function mergeStreamedEffect(
  last: BatchedRunSessionEffect | undefined,
  effect: BatchedRunSessionEffect,
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
  if (
    last.kind === 'tool_output_streamed' &&
    effect.kind === 'tool_output_streamed'
  ) {
    if (
      last.threadId !== effect.threadId ||
      last.callId !== effect.callId ||
      last.stream !== effect.stream
    ) {
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
  queueStreamedToolOutputEffect(effect: StreamedToolOutputEffect): void;
  queueDisplayEffect(effect: DisplayEffect): void;
  flushPendingStreamEffects(): void;
  clearPendingStreamEffects(): void;
} {
  let effects: BatchedRunSessionEffect[] = [];
  let cancelScheduledFlush: (() => void) | null = null;

  const flushPendingStreamEffects = () => {
    const pendingEffects = effects;
    effects = [];
    cancelScheduledFlush?.();
    cancelScheduledFlush = null;

    for (const effect of pendingEffects) {
      dispatchBatchedEffect(options.readDispatch(), effect);
    }
  };

  const clearPendingStreamEffects = () => {
    cancelScheduledFlush?.();
    cancelScheduledFlush = null;
    effects = [];
  };

  const queueBatchedStreamEffect = (effect: BatchedRunSessionEffect) => {
    if (cancelScheduledFlush === null && effects.length === 0) {
      dispatchBatchedEffect(options.readDispatch(), effect);
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
    queueStreamedToolOutputEffect: queueBatchedStreamEffect,
    queueDisplayEffect: queueBatchedStreamEffect,
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
