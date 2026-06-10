import type { ThreadStatePersistenceFailureDiagnostic } from '@geulbat/protocol/run-events';
import type { ThreadSummary } from '@geulbat/protocol/threads';

import { loadThreadDetailSnapshot } from '../sessions/thread-detail.js';
import { getErrorMessage } from '../utils/error.js';
import type { AgentResult } from './agent-result.js';
import type { AgentInput } from './loop-types.js';
import { createAgentEvent } from './events.js';
import type { ResolvedExecuteForegroundRunDeps } from './execute-foreground-run-contracts.js';
import { persistForegroundAssistantAnswer } from './foreground-assistant-persistence.js';

const THREAD_STATE_PERSIST_FAILURE_MESSAGE =
  'Run finished, but refreshing the saved thread state failed. The streamed result is still shown.';

export async function persistSuccessfulForegroundOutput(args: {
  agentInput: AgentInput;
  transcriptPrompt: string;
  result: AgentResult;
  deps: ResolvedExecuteForegroundRunDeps;
  persistenceDiagnostics: readonly ThreadStatePersistenceFailureDiagnostic[];
}): Promise<void> {
  const { agentInput, transcriptPrompt, result, deps, persistenceDiagnostics } =
    args;
  const { runContext } = agentInput;
  const assistantPersisted = await persistForegroundAssistantAnswer({
    agentInput,
    result,
    deps,
  });

  await runBestEffortForegroundPersistence(
    'update thread summary',
    () =>
      upsertCurrentThreadSummary({
        workspaceRoot: runContext.workspaceRoot,
        threadId: runContext.threadId,
        projectId: runContext.projectId,
        transcriptPrompt,
        deps,
      }),
    deps,
  );

  await publishForegroundThreadStateSnapshot({
    agentInput,
    shouldLoadSnapshot: assistantPersisted,
    deps,
    persistenceDiagnostics,
  });
}

export async function upsertCurrentThreadSummary(args: {
  workspaceRoot: string;
  threadId: AgentInput['runContext']['threadId'];
  projectId: AgentInput['runContext']['projectId'];
  transcriptPrompt: string;
  deps: ResolvedExecuteForegroundRunDeps;
}): Promise<void> {
  const { deps } = args;
  const messages = await deps.readTranscriptEntries(
    args.workspaceRoot,
    args.threadId,
  );
  const existingIndex = await deps.loadThreadIndex(args.workspaceRoot);
  const existing = existingIndex.find(
    (entry) => entry.threadId === args.threadId,
  );
  const title = existing?.title ?? sanitizeTitle(args.transcriptPrompt);
  const summary: ThreadSummary = {
    threadId: args.threadId,
    projectId: args.projectId,
    lastUpdated: deps.now(),
    messageCount: messages.length,
  };

  if (title !== undefined) {
    summary.title = title;
  }

  await deps.upsertThreadSummary(args.workspaceRoot, summary);
}

export function buildThreadStatePersistenceFailureDiagnostic(
  phase: string,
  error: unknown,
): ThreadStatePersistenceFailureDiagnostic {
  return {
    phase,
    message: getErrorMessage(error),
  };
}

function sanitizeTitle(prompt: string): string {
  const cleaned = prompt.replace(/[\r\n]+/g, ' ').trim();
  if (!cleaned) {
    return 'New Thread';
  }
  const chars = Array.from(cleaned);
  return chars.length > 40 ? chars.slice(0, 40).join('') : cleaned;
}

async function runBestEffortForegroundPersistence(
  phase: string,
  work: () => Promise<void>,
  deps: ResolvedExecuteForegroundRunDeps,
): Promise<boolean> {
  try {
    await work();
    return true;
  } catch (error: unknown) {
    deps.onPostRunPersistenceError(phase, error);
    return false;
  }
}

async function publishForegroundThreadStateSnapshot(args: {
  agentInput: AgentInput;
  shouldLoadSnapshot: boolean;
  deps: ResolvedExecuteForegroundRunDeps;
  persistenceDiagnostics: readonly ThreadStatePersistenceFailureDiagnostic[];
}): Promise<void> {
  const { agentInput, shouldLoadSnapshot, deps, persistenceDiagnostics } = args;
  const { runContext } = agentInput;

  if (!shouldLoadSnapshot) {
    emitThreadStatePersistFailed(agentInput, persistenceDiagnostics);
    return;
  }

  const threadSnapshotLoaded = await runBestEffortForegroundPersistence(
    'load persisted thread snapshot',
    async () => {
      agentInput.onEvent(
        createAgentEvent(
          'thread_state_persisted',
          await loadThreadDetailSnapshot({
            workspaceRoot: runContext.workspaceRoot,
            projectId: runContext.projectId,
            threadId: runContext.threadId,
          }),
        ),
      );
    },
    deps,
  );

  if (!threadSnapshotLoaded) {
    emitThreadStatePersistFailed(agentInput, persistenceDiagnostics);
  }
}

function emitThreadStatePersistFailed(
  agentInput: AgentInput,
  persistenceDiagnostics: readonly ThreadStatePersistenceFailureDiagnostic[],
): void {
  if (persistenceDiagnostics.length === 0) {
    agentInput.onEvent(
      createAgentEvent('thread_state_persist_failed', {
        message: THREAD_STATE_PERSIST_FAILURE_MESSAGE,
      }),
    );
    return;
  }

  agentInput.onEvent(
    createAgentEvent('thread_state_persist_failed', {
      message: THREAD_STATE_PERSIST_FAILURE_MESSAGE,
      diagnostics: persistenceDiagnostics.map((diagnostic) => ({
        ...diagnostic,
      })),
    }),
  );
}
