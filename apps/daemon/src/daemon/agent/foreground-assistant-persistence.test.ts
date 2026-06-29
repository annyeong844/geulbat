import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { AgentEvent } from './events.js';
import { createDaemonContext } from '../context.js';
import type { ResolvedExecuteForegroundRunDeps } from './execute-foreground-run-contracts.js';
import { persistForegroundAssistantAnswer } from './foreground-assistant-persistence.js';
import type { AgentInput } from './loop-types.js';
import {
  commitThreadArtifactVersion,
  deleteThreadArtifact,
  loadAllThreadArtifactVersions,
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
    projectId: testProjectId('foreground-assistant'),
  });
  return {
    runId: 'run-foreground-assistant',
    runContext,
    prompt: 'prompt',
    currentFile: 'episodes/ch01.md',
    runtimeServices: createDaemonContext(),
    approvalContext: makeApprovalContext(),
    onEvent: (event) => {
      args.events.push(event);
    },
  };
}

void test('persistForegroundAssistantAnswer rolls back a just-committed artifact when transcript persistence cannot recover', async () => {
  const threadId = testThreadId(1201);
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'geulbat-fg-assistant-'));
  const events: AgentEvent[] = [];
  const diagnostics: string[] = [];

  const persisted = await persistForegroundAssistantAnswer({
    agentInput: makeAgentInput({ workspaceRoot, threadId, events }),
    result: {
      ok: true,
      finalProse: '',
      artifactCandidate: {
        renderer: 'markdown',
        payload: '\n# Title\n',
        digest: 'sha256:artifact',
      },
    },
    deps: makeDeps({
      appendTranscriptEntry: async () => {
        throw new Error('append failed');
      },
      readTranscriptEntries: async () => {
        throw new Error('recovery read failed');
      },
      onPostRunPersistenceError: (phase) => {
        diagnostics.push(phase);
      },
    }),
  });

  assert.equal(persisted, false);
  assert.deepEqual(events, []);
  assert.deepEqual(diagnostics, [
    'recover assistant transcript',
    'persist assistant transcript',
  ]);
  assert.deepEqual(
    await loadAllThreadArtifactVersions(workspaceRoot, threadId),
    [],
  );
});
