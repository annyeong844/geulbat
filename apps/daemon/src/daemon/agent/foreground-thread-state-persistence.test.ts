import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
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
  commitThreadArtifactUpdateVersion,
  commitThreadArtifactVersion,
  deleteThreadArtifact,
  deleteThreadArtifactUpdateVersion,
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
import { appendProviderRound } from '../sessions/provider-round-journal.js';
import { createRunCheckpointStore } from '../sessions/run-checkpoint-store.js';
import { makeApprovalContext } from '../../test-support/approval-runtime.js';
import { makeRunContext } from '../../test-support/run-context.js';
import { testRunId } from '../../test-support/run-id.js';
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
    commitThreadArtifactUpdateVersion,
    deleteThreadArtifact,
    deleteThreadArtifactUpdateVersion,
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
  runId?: AgentInput['runId'];
  events: AgentEvent[];
}): AgentInput {
  const runContext = makeRunContext({
    stateRoot: args.workspaceRoot,
    threadId: args.threadId,
  });
  return {
    runId: args.runId ?? 'run-foreground-thread-state',
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

void test('persistSuccessfulForegroundOutput hands active commentary from live state to the settled snapshot', async (t) => {
  const threadId = testThreadId(1302);
  const runId = testRunId(1302);
  const workspaceRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-fg-thread-commentary-'),
  );
  t.after(async () => rm(workspaceRoot, { recursive: true, force: true }));
  const events: AgentEvent[] = [];
  const checkpointStore = createRunCheckpointStore({
    stateRoot: workspaceRoot,
  });
  await checkpointStore.startRun({
    threadId,
    runId,
    request: {
      workingDirectory: workspaceRoot,
      permissionMode: 'basic',
      providerModel: {
        providerId: 'qwen_token_plan',
        model: 'qwen3.8-max-preview',
      },
    },
  });
  const userMessage = await appendTranscriptEntry(workspaceRoot, threadId, {
    role: 'user',
    content: 'Please reason before answering.',
    timestamp: '2026-07-26T00:00:00.000Z',
  });
  await appendProviderRound({
    stateRoot: workspaceRoot,
    threadId,
    runId,
    round: 0,
    providerId: 'qwen_token_plan',
    model: 'qwen3.8-max-preview',
    replayScopeId: null,
    precedingTranscriptEntryId: userMessage.entryId,
    items: [
      {
        type: 'message',
        id: 'qwen-settle-commentary',
        role: 'assistant',
        status: 'completed',
        phase: 'commentary',
        content: [
          {
            type: 'output_text',
            text: 'Reasoning retained at the ownership handoff.',
            annotations: [],
          },
        ],
      },
    ],
    functionCalls: [],
    now: () => '2026-07-26T00:00:01.000Z',
  });

  await persistSuccessfulForegroundOutput({
    agentInput: makeAgentInput({
      workspaceRoot,
      threadId,
      runId,
      events,
    }),
    transcriptPrompt: 'Visible title',
    result: {
      ok: true,
      finalProse: 'Settled answer.',
    },
    deps: makeDeps(),
    persistenceDiagnostics: [],
  });

  const persisted = events.find(
    (event): event is Extract<AgentEvent, { type: 'thread_state_persisted' }> =>
      event.type === 'thread_state_persisted',
  );
  assert.ok(persisted);
  assert.deepEqual(
    persisted.payload.messages.map((message) => [
      message.role,
      message.content,
      message.metadata?.phase,
    ]),
    [
      ['user', 'Please reason before answering.', undefined],
      [
        'assistant',
        'Reasoning retained at the ownership handoff.',
        'commentary',
      ],
      ['assistant', 'Settled answer.', 'final_answer'],
    ],
  );
});
