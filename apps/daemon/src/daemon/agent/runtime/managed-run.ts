import { randomUUID } from 'node:crypto';
import {
  assertAgentRunId as assertValidRunId,
  assertAgentThreadId as assertValidThreadId,
  type RunId,
  type ThreadId,
} from '../contract.js';

import type { ActiveRun, ActiveRunStore } from '../../sessions/active-runs.js';
import { createRunState, type RunState } from './run-state.js';
import { createRunContext, type RunContext } from '../../run-context.js';

interface StartManagedRunParams {
  runContext: Omit<RunContext, 'threadId'> & {
    threadId?: string | ThreadId;
  };
  runId?: string;
  ownerThreadId?: string | ThreadId;
  parentRunId?: string | RunId;
  abortController?: AbortController;
}

interface StartedManagedRun {
  ok: true;
  runId: RunId;
  threadId: ThreadId;
  runState: RunState;
  activeRun: ActiveRun;
  finish: () => void;
}

interface RejectedManagedRun {
  ok: false;
  runId: RunId;
  threadId: ThreadId;
  activeRunId: RunId;
}

export function startManagedRun(
  params: StartManagedRunParams,
  args: {
    activeRuns: Pick<ActiveRunStore, 'tryStartRun' | 'finishRun'>;
  },
): StartedManagedRun | RejectedManagedRun {
  return startManagedRunInternal(params, args.activeRuns);
}

function startManagedRunInternal(
  params: StartManagedRunParams,
  activeRuns: Pick<ActiveRunStore, 'tryStartRun' | 'finishRun'>,
): StartedManagedRun | RejectedManagedRun {
  const runId = assertValidRunId(params.runId ?? randomUUID());
  const parentRunId =
    params.parentRunId !== undefined
      ? assertValidRunId(params.parentRunId)
      : undefined;
  const runContext = createRunContext({
    threadId: params.runContext.threadId ?? assertValidThreadId(randomUUID()),
    stateRoot: params.runContext.stateRoot,
    workingDirectory: params.runContext.workingDirectory,
  });
  const threadId = runContext.threadId;
  const ownerThreadId = assertValidThreadId(params.ownerThreadId ?? threadId);
  const runState = createRunState({
    runId,
    runContext,
    ...(parentRunId !== undefined ? { parentRunId } : {}),
  });

  if (params.abortController) {
    runState.abortController = params.abortController;
  }

  const activeRun: ActiveRun = {
    runId,
    ...runContext,
    ownerThreadId,
    abortController: runState.abortController,
    interject: runState.interject,
    startedAt: runState.createdAt,
    ...(parentRunId !== undefined ? { parentRunId } : {}),
  };

  const startResult = activeRuns.tryStartRun(threadId, activeRun);
  if (!startResult.ok) {
    return {
      ok: false,
      runId,
      threadId,
      activeRunId: startResult.activeRunId,
    };
  }

  return {
    ok: true,
    runId,
    threadId,
    runState,
    activeRun,
    finish: () => activeRuns.finishRun(threadId, runId),
  };
}
