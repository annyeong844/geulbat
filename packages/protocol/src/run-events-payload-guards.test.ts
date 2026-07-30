import assert from 'node:assert/strict';
import test from 'node:test';

import type {
  ArtifactCommittedEventPayload,
  RunEventPayloadMap,
  SharedRunEventPayloadMap,
} from './run-events.js';
import {
  isAgentRetryToolRaw,
  isAgentSetPriorityToolRaw,
  isAgentWaitToolRaw,
  isArtifactCommittedEventPayload,
  isDoneEventPayload,
  isErrorEventPayload,
  isInterjectAppliedEventPayload,
  isOffloadedToolResultRaw,
  isProviderRequestDiagnostics,
  isProviderRetryDiagnostics,
  isProviderRuntimeStatusEventPayload,
  isRunEvent,
  isRunUsageTotals,
  isSubagentRuntimeDiagnostics,
  isTextDeltaEventPayload,
  isThreadStatePersistedEventPayload,
  isThreadStatePersistFailedEventPayload,
  isToolCallDeltaEventPayload,
  isToolCallEventPayload,
  isToolOutputDeltaEventPayload,
} from './run-events.js';
import { assertEveryFieldIsValidated } from './test-support/field-coverage.js';
import {
  TEST_RUN_EVENT_RUN_ID as RUN_ID,
  TEST_RUN_EVENT_THREAD_ID as THREAD_ID,
} from './test-support/run-events.js';

void test('done and thread persistence payload guards reject malformed diagnostics', () => {
  assert.equal(isDoneEventPayload({ answer: 'done', ok: true }), true);
  assert.equal(isDoneEventPayload({ answer: 'done', ok: 'yes' }), false);

  assert.equal(
    isThreadStatePersistedEventPayload({
      threadId: THREAD_ID,
      snapshotVersion: '2026-04-10T00:00:00.000Z',
      messages: [],
      artifacts: [],
    }),
    true,
  );
  assert.equal(
    isThreadStatePersistFailedEventPayload({
      message: 'sync failed',
      diagnostics: [
        {
          phase: 'persist assistant transcript',
          message: 'disk full',
        },
      ],
    }),
    true,
  );
  assert.equal(
    isThreadStatePersistFailedEventPayload({
      message: 'sync failed',
      diagnostics: [
        {
          phase: 'persist assistant transcript',
          message: 1,
        },
      ],
    }),
    false,
  );
  assert.equal(
    isThreadStatePersistFailedEventPayload({
      message: 'sync failed',
      diagnostics: {},
    }),
    false,
  );
  assert.equal(
    isThreadStatePersistFailedEventPayload({
      message: 1,
    }),
    false,
  );
});

void test('error payload guards enforce error-code-specific fields', () => {
  assert.equal(
    isErrorEventPayload({ code: 'internal', message: 'boom' }),
    true,
  );
  assert.equal(
    isErrorEventPayload({ code: 'not_found', message: 'missing' }),
    true,
  );
  assert.equal(
    isErrorEventPayload({
      code: 'not_found',
      message: 'missing',
      path: 'draft/ch1.md',
    }),
    true,
  );
  assert.equal(
    isErrorEventPayload({
      code: 'not_found',
      message: 'missing',
      path: 123,
    }),
    false,
  );
  assert.equal(
    isErrorEventPayload({
      code: 'conflict_stale_write',
      message: 'stale write',
      path: 'draft/ch1.md',
      currentVersionToken: 'v2',
    }),
    true,
  );
  assert.equal(
    isErrorEventPayload({
      code: 'conflict_active_run',
      message: 'thread has an active run',
      threadId: THREAD_ID,
      activeRunId: RUN_ID,
    }),
    true,
  );
  assert.equal(
    isErrorEventPayload({
      code: 'conflict_stale_write',
      message: 'stale write',
    }),
    false,
  );
  assert.equal(
    isErrorEventPayload({
      code: 'conflict_active_run',
      message: 'thread has an active run',
    }),
    false,
  );
  assert.equal(
    isErrorEventPayload({ code: 'totally_new_error', message: 'boom' }),
    false,
  );
  assert.equal(isErrorEventPayload({ code: 500, message: 'boom' }), false);
});

void test('artifact committed payload guard accepts the canonical source shape', () => {
  assert.equal(
    isArtifactCommittedEventPayload({
      artifactId: 'art_1',
      version: 1,
      parentVersion: null,
      baseVersion: null,
      renderer: 'markdown',
      payload: '# title',
      digest: 'digest',
      contentHash: 'hash',
      createdAt: '2026-04-10T00:00:00.000Z',
      createdByRunId: RUN_ID,
      previewValidation: { ok: true },
      title: null,
      persistenceEpoch: 0,
      sourceRef: {
        kind: 'thread-file',
        workingDirectory: 'workspace',
        threadId: THREAD_ID,
        runId: RUN_ID,
        filePath: 'episodes/ch01.md',
        messageTimestamp: '2026-04-10T00:00:00.000Z',
      },
    }),
    true,
  );
});

void test('RunEventPayloadMap remains aligned with shared semantic payloads', () => {
  const shared: SharedRunEventPayloadMap = {
    run_ack: { runId: RUN_ID, threadId: THREAD_ID },
    provider_status: {
      phase: 'rate_limit_waiting',
      observedAt: '2026-07-23T11:00:00.000Z',
    },
    commentary_delta: { text: 'commentary' },
    tool_call: {
      callId: 'call-1',
      step: 1,
      tool: 'read_file',
      args: { path: 'docs/a.md' },
    },
    tool_call_delta: {
      callId: 'call-1',
      step: 1,
      tool: 'visualize',
      argsDelta: '{"code":"<div',
    },
    tool_result: {
      callId: 'call-1',
      step: 1,
      tool: 'read_file',
      ok: true,
      computerFilesMayHaveChanged: false,
      displayText: 'ok',
      raw: { path: 'docs/a.md' },
    },
    subagent_spawned: {
      parentRunId: RUN_ID,
      childRunId: RUN_ID,
      childThreadId: THREAD_ID,
      subagentType: 'explorer',
      capabilities: ['ptc'],
      toolSurface: 'explorer_ptc',
    },
    subagent_status: {
      parentRunId: RUN_ID,
      childRunId: RUN_ID,
      childThreadId: THREAD_ID,
      subagentType: 'explorer',
      capabilities: ['ptc'],
      toolSurface: 'explorer_ptc',
      runtime: {
        phase: 'provider_waiting',
        observedAt: '2026-07-23T09:50:00.000Z',
        partialOutputAvailable: false,
      },
    },
    subagent_terminal: {
      deliveryId: 'delivery-terminal',
      parentRunId: RUN_ID,
      childRunId: RUN_ID,
      subagentType: 'worker',
      capabilities: [],
      toolSurface: 'worker',
      terminalState: 'failed',
      ok: false,
      reason: 'child_error',
      result: 'failed',
    },
    subagent_approval_required: {
      parentRunId: RUN_ID,
      childRunId: RUN_ID,
      subagentType: 'worker',
      capabilities: [],
      toolSurface: 'worker',
      approval: {
        callId: 'call-1',
        runId: RUN_ID,
        threadId: THREAD_ID,
        toolName: 'write_file',
        approvalClass: 'write_file',
        permissionMode: 'basic',
        argumentsPreview: { path: 'docs/a.md' },
        sideEffectLevel: 'write',
      },
    },
    interject_applied: {
      runId: RUN_ID,
      count: 2,
      receivedSeqs: [1, 2],
    },
    approval_required: {
      callId: 'call-1',
      runId: RUN_ID,
      threadId: THREAD_ID,
      toolName: 'write_file',
      approvalClass: 'write_file',
      permissionMode: 'basic',
      argumentsPreview: { path: 'docs/a.md' },
      sideEffectLevel: 'write',
    },
    usage_updated: {
      inputTokens: 100,
      outputTokens: 25,
      cachedInputTokens: 40,
    },
    context_usage_updated: {
      state: 'measured',
      modelId: 'gpt-5.6-sol',
      inputTokens: 122_400,
      contextWindow: 272_000,
      thresholdTokens: 244_800,
    },
    planning_workflow_updated: {
      state: 'collecting',
      workflowId: 'workflow-event',
      threadId: THREAD_ID,
      intensity: 'visual',
      depth: 'standard',
      createdAt: '2026-07-26T00:00:00.000Z',
      updatedAt: '2026-07-26T00:00:00.000Z',
    },
    goal_updated: {
      goalId: 'goal-event',
      threadId: THREAD_ID,
      objective: 'Ship Goal mode',
      state: 'working',
      createdAt: '2026-07-26T00:00:00.000Z',
      updatedAt: '2026-07-26T00:00:00.000Z',
    },
    final_answer_delta: { text: 'final' },
    artifact_stream_delta: { text: 'artifact' },
    artifact_committed: {
      artifactId: 'art_1',
      version: 1,
      parentVersion: null,
      baseVersion: null,
      renderer: 'markdown',
      payload: '# title',
      digest: 'digest',
      contentHash: 'hash',
      createdAt: '2026-04-10T00:00:00.000Z',
      createdByRunId: RUN_ID,
      previewValidation: { ok: true },
      title: null,
      persistenceEpoch: 0,
      sourceRef: {
        kind: 'thread-file',
        workingDirectory: 'workspace',
        threadId: THREAD_ID,
        runId: RUN_ID,
        filePath: 'episodes/ch01.md',
        messageTimestamp: '2026-04-10T00:00:00.000Z',
      },
    },
    thread_state_persisted: {
      threadId: THREAD_ID,
      snapshotVersion: '2026-04-10T00:00:00.000Z',
      messages: [],
      artifacts: [],
    },
    thread_state_delta_persisted: {
      threadId: THREAD_ID,
      snapshotVersion: '2026-04-10T00:00:01.000Z',
      baseEntryId: 'entry-before-current-run',
      messages: [],
      artifacts: [],
    },
    thread_state_persist_failed: {
      message: 'sync failed',
    },
    done: { answer: 'done', ok: true },
    error: { code: 'internal', message: 'boom' },
  };
  const payloads: RunEventPayloadMap = shared;

  const artifactCommitted: ArtifactCommittedEventPayload =
    shared.artifact_committed;
  assert.equal(payloads.subagent_spawned.childThreadId, THREAD_ID);
  assert.deepEqual(payloads.subagent_spawned.capabilities, ['ptc']);
  assert.equal(payloads.subagent_spawned.toolSurface, 'explorer_ptc');
  assert.equal(payloads.subagent_terminal.terminalState, 'failed');
  assert.equal(payloads.interject_applied.count, 2);
  assert.equal(artifactCommitted.artifactId, 'art_1');
  assert.equal(
    isRunEvent({
      runId: RUN_ID,
      threadId: THREAD_ID,
      seq: 2,
      type: 'subagent_terminal',
      ts: new Date().toISOString(),
      payload: payloads.subagent_terminal,
    }),
    true,
  );
  assert.equal(
    isRunEvent({
      runId: RUN_ID,
      threadId: THREAD_ID,
      seq: 4,
      type: 'interject_applied',
      ts: new Date().toISOString(),
      payload: payloads.interject_applied,
    }),
    true,
  );
  assert.equal(
    isRunEvent({
      runId: RUN_ID,
      threadId: THREAD_ID,
      seq: 5,
      type: 'artifact_committed',
      ts: new Date().toISOString(),
      payload: artifactCommitted,
    }),
    true,
  );
  assert.equal(
    isRunEvent({
      runId: RUN_ID,
      threadId: THREAD_ID,
      seq: 6,
      type: 'thread_state_persisted',
      ts: new Date().toISOString(),
      payload: payloads.thread_state_persisted,
    }),
    true,
  );
  assert.equal(
    isRunEvent({
      runId: RUN_ID,
      threadId: THREAD_ID,
      seq: 7,
      type: 'thread_state_delta_persisted',
      ts: new Date().toISOString(),
      payload: payloads.thread_state_delta_persisted,
    }),
    true,
  );
  assert.equal(
    isRunEvent({
      runId: RUN_ID,
      threadId: THREAD_ID,
      seq: 8,
      type: 'thread_state_delta_persisted',
      ts: new Date().toISOString(),
      payload: {
        ...payloads.thread_state_delta_persisted,
        baseEntryId: 42,
      },
    }),
    false,
  );
  assert.equal(
    isRunEvent({
      runId: RUN_ID,
      threadId: THREAD_ID,
      seq: 9,
      type: 'thread_state_persist_failed',
      ts: new Date().toISOString(),
      payload: payloads.thread_state_persist_failed,
    }),
    true,
  );
});

void test('every declared run-event payload field is actually validated', () => {
  assertEveryFieldIsValidated(
    'TextDeltaEventPayload',
    isTextDeltaEventPayload,
    { text: 'delta' },
    { text: 42 },
  );

  assertEveryFieldIsValidated(
    'ToolCallEventPayload',
    isToolCallEventPayload,
    { callId: 'call-1', step: 1, tool: 'read_file', args: { path: 'a.md' } },
    { callId: 42, step: '1', tool: 42, args: 'not-a-record', source: 'x' },
  );

  assertEveryFieldIsValidated(
    'ToolCallDeltaEventPayload',
    isToolCallDeltaEventPayload,
    { callId: 'call-1', step: 1, tool: 'visualize', argsDelta: '{"code":"<' },
    { callId: 42, step: '1', tool: 42, argsDelta: 42 },
  );

  assertEveryFieldIsValidated(
    'ToolOutputDeltaEventPayload',
    isToolOutputDeltaEventPayload,
    { callId: 'call-1', tool: 'exec', stream: 'stdout', text: 'out' },
    { callId: 42, tool: 42, stream: 'stdin', text: 42 },
  );

  assertEveryFieldIsValidated(
    'ProviderRuntimeStatusEventPayload',
    isProviderRuntimeStatusEventPayload,
    { phase: 'rate_limit_waiting', observedAt: '2026-07-23T11:00:00.000Z' },
    { phase: 'invented_phase', observedAt: 'not-a-timestamp', request: 'x' },
  );

  assertEveryFieldIsValidated(
    'ProviderRetryDiagnostics',
    isProviderRetryDiagnostics,
    {
      available: true,
      performed: true,
      outcome: 'scheduled',
      retryAfterMs: 2_500,
    },
    {
      available: 'yes',
      performed: 'no',
      outcome: 'invented_outcome',
      retryAfterMs: 'soon',
    },
  );

  // endedAt과 durationMs는 "함께 있거나 함께 없다"는 교차 규칙이 있어, 필드
  // 단위 오염을 격리하려면 선택 필드까지 모두 채운 정상값에서 출발해야 한다.
  assertEveryFieldIsValidated(
    'ProviderRequestDiagnostics',
    isProviderRequestDiagnostics,
    {
      startedAt: '2026-07-23T11:00:00.000Z',
      lastEventAt: '2026-07-23T11:00:01.000Z',
      endedAt: '2026-07-23T11:00:02.000Z',
      durationMs: 2000,
      attemptCount: 2,
      retry: { available: true, performed: true, outcome: 'scheduled' },
    },
    {
      startedAt: 'not-a-timestamp',
      lastEventAt: 'not-a-timestamp',
      endedAt: 'not-a-timestamp',
      durationMs: 'x',
      attemptCount: 0,
      retry: 'x',
    },
  );

  assertEveryFieldIsValidated(
    'SubagentRuntimeDiagnostics',
    isSubagentRuntimeDiagnostics,
    {
      phase: 'provider_waiting',
      observedAt: '2026-07-23T09:50:00.000Z',
      partialOutputAvailable: false,
    },
    {
      phase: 'invented_phase',
      observedAt: 'not-a-timestamp',
      partialOutputAvailable: 'no',
      lastTool: 'x',
      previousChildRunId: 42,
      providerRequest: 'x',
    },
  );

  assertEveryFieldIsValidated(
    'RunUsageTotals',
    isRunUsageTotals,
    { inputTokens: 1, outputTokens: 2, cachedInputTokens: 3 },
    { inputTokens: 'x', outputTokens: 'x', cachedInputTokens: 'x' },
  );

  assertEveryFieldIsValidated(
    'InterjectAppliedEventPayload',
    isInterjectAppliedEventPayload,
    { runId: RUN_ID, count: 2, receivedSeqs: [1, 2] },
    { runId: 42, count: 'x', receivedSeqs: 'x' },
  );

  assertEveryFieldIsValidated(
    'DoneEventPayload',
    isDoneEventPayload,
    { answer: 'done', ok: true },
    { answer: 42, ok: 'yes' },
  );

  assertEveryFieldIsValidated(
    'ThreadStatePersistFailedEventPayload',
    isThreadStatePersistFailedEventPayload,
    { message: 'sync failed' },
    { message: 42, diagnostics: 'x' },
  );

  assertEveryFieldIsValidated(
    'OffloadedToolResultRaw',
    isOffloadedToolResultRaw,
    {
      ok: true,
      offloaded: true,
      tool: 'agent_wait',
      callId: 'call-wait-1',
      outputRef: 'tool-output:thread-1/run-1/call-wait-1',
      summary: 'agent_wait returned 4 completed runs.',
      fullOutputBytes: 48_067,
      fullOutputChars: 21_556,
      recoveryTool: 'read_tool_output',
    },
    {
      ok: false,
      offloaded: false,
      tool: 42,
      callId: 42,
      outputRef: 42,
      summary: 42,
      fullOutputBytes: 'x',
      fullOutputChars: 'x',
      recoveryTool: 'exec',
    },
  );

  assertEveryFieldIsValidated(
    'AgentWaitToolRaw',
    isAgentWaitToolRaw,
    { ok: true, completed: [], pending: [], blocked: [] },
    { ok: false, completed: 'x', pending: 'x', blocked: 'x', launches: 'x' },
  );

  assertEveryFieldIsValidated(
    'AgentSetPriorityToolRaw',
    isAgentSetPriorityToolRaw,
    {
      ok: true,
      childRunId: 'child-1',
      launchState: 'queued',
      priorityClass: 'normal',
      updateState: 'updated',
    },
    {
      ok: false,
      childRunId: 42,
      launchState: 'invented_state',
      priorityClass: 'urgent',
      updateState: 'invented_update',
    },
  );

  assertEveryFieldIsValidated(
    'AgentRetryToolRaw',
    isAgentRetryToolRaw,
    {
      ok: true,
      previousChildRunId: 'previous-child',
      childRunId: 'fresh-child',
      childThreadId: 'fresh-thread',
      retryDisposition: 'created',
      launchState: 'queued',
      deferReason: 'configured_capacity',
      failureReason: null,
      modelId: 'gpt-5.6',
      reasoningEffort: 'medium',
      selectionSource: 'inherited',
    },
    {
      ok: false,
      previousChildRunId: 42,
      childRunId: 42,
      childThreadId: 42,
      retryDisposition: 'invented_disposition',
      launchState: 'invented_state',
      deferReason: 'invented_reason',
      failureReason: 42,
      modelId: 42,
      reasoningEffort: 'invented_effort',
      selectionSource: 'invented_source',
    },
  );
});
