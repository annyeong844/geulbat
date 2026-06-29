import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { AgentEvent } from './events.js';
import type { ThreadStatePersistenceFailureDiagnostic } from './contract.js';
import { createDaemonContext } from '../context.js';
import type { ResolvedExecuteForegroundRunDeps } from './execute-foreground-run-contracts.js';
import {
  buildThreadStatePersistenceFailureDiagnostic,
  persistSuccessfulForegroundOutput,
} from './foreground-thread-state-persistence.js';
import type { AgentInput } from './loop-types.js';
import {
  commitThreadArtifactVersion,
  deleteThreadArtifact,
} from '../sessions/artifact-store.js';
import {
  appendTranscriptEntry,
  readTranscriptEntries,
  replaceTranscriptEntries,
} from '../sessions/transcript-log.js';
import {
  loadThreadIndex,
  upsertThreadSummary,
} from '../sessions/threads-index.js';
import { makeApprovalContext } from '../../test-support/approval-runtime.js';
import { testProjectId } from '../../test-support/project-id.js';
import { makeRunWorkspaceContext } from '../../test-support/run-workspace-context.js';
import { testThreadId } from '../../test-support/thread-id.js';

const FIXED_NOW = '2026-04-02T00:00:00.000Z';
const THREAD_STATE_PERSIST_FAILURE_MESSAGE =
  'Run finished, but refreshing the saved thread state failed. The streamed result is still shown.';

function makeDeps(
  overrides: Partial<ResolvedExecuteForegroundRunDeps> = {},
): ResolvedExecuteForegroundRunDeps {
  return {
    appendTranscriptEntry,
    commitThreadArtifactVersion,
    deleteThreadArtifact,
    readTranscriptEntries,
    replaceTranscriptEntries,
    loadThreadIndex,
    upsertThreadSummary,
    now: () => FIXED_NOW,
    onPostRunPersistenceError: () => {},
    ...overrides,
  };
}

function makeAgentInput(args: {
  workspaceRoot: string;
  threadId: ReturnType<typeof testThreadId>;
  events: AgentEvent[];
}): AgentInput {
  const runContext = makeRunWorkspaceContext({
    workspaceRoot: args.workspaceRoot,
    threadId: args.threadId,
    projectId: testProjectId('foreground-thread-state'),
  });
  return {
    runId: 'run-foreground-thread-state',
    runContext,
    prompt: 'prompt',
    runtimeServices: createDaemonContext(),
    approvalContext: makeApprovalContext(),
    onEvent: (event) => {
      args.events.push(event);
    },
  };
}

void test('persistSuccessfulForegroundOutput emits thread-state failure diagnostics when assistant persistence cannot recover', async () => {
  const threadId = testThreadId(1301);
  const workspaceRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-fg-thread-state-'),
  );
  const events: AgentEvent[] = [];
  const diagnostics: ThreadStatePersistenceFailureDiagnostic[] = [];
  let transcriptReadCount = 0;

  await persistSuccessfulForegroundOutput({
    agentInput: makeAgentInput({ workspaceRoot, threadId, events }),
    transcriptPrompt: 'Visible title',
    result: {
      ok: true,
      finalProse: 'assistant answer',
    },
    deps: makeDeps({
      appendTranscriptEntry: async () => {
        throw new Error('append failed');
      },
      readTranscriptEntries: async (...args) => {
        transcriptReadCount += 1;
        if (transcriptReadCount === 1) {
          throw new Error('recovery read failed');
        }
        return readTranscriptEntries(...args);
      },
      onPostRunPersistenceError: (phase, error) => {
        diagnostics.push(
          buildThreadStatePersistenceFailureDiagnostic(phase, error),
        );
      },
    }),
    persistenceDiagnostics: diagnostics,
  });

  assert.equal(transcriptReadCount, 2);
  assert.deepEqual(events, [
    {
      type: 'thread_state_persist_failed',
      payload: {
        message: THREAD_STATE_PERSIST_FAILURE_MESSAGE,
        diagnostics: [
          {
            phase: 'recover assistant transcript',
            message: 'recovery read failed',
          },
          {
            phase: 'persist assistant transcript',
            message: 'append failed',
          },
        ],
      },
    },
  ]);
  const summaries = await loadThreadIndex(workspaceRoot);
  assert.equal(summaries[0]?.title, 'Visible title');
});
