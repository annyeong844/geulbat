import type { HistoryItem } from '../llm/index.js';
import {
  clearInterjectFlushRequest,
  peekPendingInterject,
  removePendingInterjectBySeq,
} from '../sessions/active-run-interject-buffer.js';
import type { RunCheckpointStore } from '../sessions/run-checkpoint-store.js';
import type { AgentEventEmitter } from './events.js';
import {
  appendInterjectToHistory,
  persistSingleInterjectToTranscript,
} from './loop-history.js';
import type { RunState } from './runtime/run-state.js';

export async function applyNextPendingInterject(args: {
  history: HistoryItem[];
  workspaceRoot: string;
  runState: RunState;
  runCheckpoints: RunCheckpointStore;
  emit: AgentEventEmitter;
}): Promise<void> {
  const interject = peekPendingInterject(args.runState.interject);
  if (interject === undefined) {
    return;
  }

  const enqueued = await args.runCheckpoints.enqueueInterject({
    threadId: args.runState.threadId,
    runId: args.runState.runId,
    interject,
  });
  if (!enqueued.ok) {
    if (enqueued.code === 'not_pending') {
      removePendingInterjectBySeq(
        args.runState.interject,
        interject.receivedSeq,
      );
      return;
    }
    throw new Error(`interject checkpoint enqueue failed: ${enqueued.code}`);
  }
  const claimed = await args.runCheckpoints.claimInterject({
    threadId: args.runState.threadId,
    runId: args.runState.runId,
    receivedSeq: interject.receivedSeq,
  });
  if (!claimed.ok) {
    if (claimed.code === 'not_pending') {
      removePendingInterjectBySeq(
        args.runState.interject,
        interject.receivedSeq,
      );
      return;
    }
    throw new Error(`interject checkpoint claim failed: ${claimed.code}`);
  }
  const persisted = await persistSingleInterjectToTranscript(
    args.workspaceRoot,
    args.runState.threadId,
    args.runState.runId,
    interject,
  );
  const completed = await args.runCheckpoints.completeInterject({
    threadId: args.runState.threadId,
    runId: args.runState.runId,
    receivedSeq: interject.receivedSeq,
  });
  if (!completed.ok) {
    throw new Error(
      `interject checkpoint completion failed: ${completed.code}`,
    );
  }
  if (
    !removePendingInterjectBySeq(args.runState.interject, interject.receivedSeq)
  ) {
    throw new Error(
      `applied interject missing from live buffer: ${interject.receivedSeq}`,
    );
  }
  // 즉시 반영 요청은 소비 1회로 목적을 다한다 — 남은 큐는 평소 케이던스로
  clearInterjectFlushRequest(args.runState.interject);
  if (persisted.appended) {
    appendInterjectToHistory(args.history, interject);
  }
  args.emit('interject_applied', {
    runId: args.runState.runId,
    count: 1,
    receivedSeqs: [interject.receivedSeq],
  });
}
