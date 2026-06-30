import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type {
  AgentLoopObserverDiagnostic,
  AgentLoopObserverEvent,
  AgentLoopObserverSnapshot,
} from './observer/agent-loop-observer.js';
import { runAgentLoop } from './run-agent-loop.js';
import { createDaemonContext } from '../context.js';
import { makeApprovalContext } from '../../test-support/approval-runtime.js';
import {
  createScriptedProviderCallModel,
  providerFinalAnswerRound,
} from '../../test-support/provider-response-fixtures.js';
import { testProjectId } from '../../test-support/project-id.js';
import { testRunId } from '../../test-support/run-id.js';
import { makeRunWorkspaceContext } from '../../test-support/run-workspace-context.js';
import { testThreadId } from '../../test-support/thread-id.js';

void test('runAgentLoop records a daemon-neutral observer snapshot and round trace', async () => {
  const workspaceRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-agent-loop-observer-'),
  );
  const runId = testRunId('agent-loop-observer');
  const threadId = testThreadId(1);
  const runContext = makeRunWorkspaceContext({
    projectId: testProjectId('project'),
    threadId,
    workspaceRoot,
  });
  const snapshots: AgentLoopObserverSnapshot[] = [];
  const observerEvents: AgentLoopObserverEvent[] = [];

  const result = await runAgentLoop({
    runId,
    runContext,
    prompt: 'do not expose this prompt body',
    allowedToolNames: [],
    runtimeServices: createDaemonContext(),
    approvalContext: makeApprovalContext({
      sessionId: 'agent-loop-observer-session',
    }),
    callModelImpl: createScriptedProviderCallModel([
      providerFinalAnswerRound('done'),
    ]),
    observer: {
      recordSnapshot(snapshot) {
        snapshots.push(snapshot);
      },
      recordEvent(event) {
        observerEvents.push(event);
      },
    },
    onEvent() {},
  });

  assert.equal(result.ok, true);
  assert.equal(snapshots.length, 1);
  assert.equal(snapshots[0]?.runId, runId);
  assert.equal(snapshots[0]?.threadId, threadId);
  assert.deepEqual(snapshots[0]?.toolSurface, {
    admission: { kind: 'allow_list', names: [] },
    definitions: { count: 0, names: [] },
  });
  assert.deepEqual(
    observerEvents.map((event) => event.kind),
    ['round_started', 'round_completed'],
  );
  assert.deepEqual(observerEvents[1], {
    schemaVersion: 1,
    kind: 'round_completed',
    runId,
    threadId,
    round: 0,
    outcome: 'terminal',
    terminalOk: true,
  });

  const serializedTrace = JSON.stringify({ snapshots, observerEvents });
  assert.equal(
    serializedTrace.includes('do not expose this prompt body'),
    false,
  );
  assert.equal(serializedTrace.includes(workspaceRoot), false);
});

void test('runAgentLoop isolates throwing observer callbacks from run behavior', async () => {
  const workspaceRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-agent-loop-observer-failure-'),
  );
  const runId = testRunId('agent-loop-observer-failure');
  const threadId = testThreadId(2);
  const runContext = makeRunWorkspaceContext({
    projectId: testProjectId('project'),
    threadId,
    workspaceRoot,
  });
  const diagnostics: AgentLoopObserverDiagnostic[] = [];

  const result = await runAgentLoop({
    runId,
    runContext,
    prompt: 'do not expose this prompt body',
    allowedToolNames: [],
    runtimeServices: createDaemonContext(),
    approvalContext: makeApprovalContext({
      sessionId: 'agent-loop-observer-failure-session',
    }),
    callModelImpl: createScriptedProviderCallModel([
      providerFinalAnswerRound('done'),
    ]),
    observer: {
      recordSnapshot() {
        throw new Error(`private observer failure: ${workspaceRoot}`);
      },
      recordEvent() {
        throw new Error('private observer event failure');
      },
      recordDiagnostic(diagnostic) {
        diagnostics.push(diagnostic);
      },
    },
    onEvent() {},
  });

  assert.equal(result.ok, true);
  assert.deepEqual(
    diagnostics.map((diagnostic) => diagnostic.operation),
    ['record_snapshot', 'record_event', 'record_event'],
  );
  assert.deepEqual(
    diagnostics.map((diagnostic) => diagnostic.eventKind),
    [undefined, 'round_started', 'round_completed'],
  );
  const serializedDiagnostics = JSON.stringify(diagnostics);
  assert.equal(serializedDiagnostics.includes(workspaceRoot), false);
  assert.equal(serializedDiagnostics.includes('private observer'), false);
});
