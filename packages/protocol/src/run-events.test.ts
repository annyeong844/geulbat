import assert from 'node:assert/strict';
import test from 'node:test';

import type {
  AgentWaitBlockedReason,
  ArtifactCommittedEventPayload,
  InterjectAppliedEventPayload,
  KnownToolResultRaw,
  KnownToolResultRawTool,
  KnownToolResultSuccessEventPayload,
  RunEventPayloadMap,
  SharedRunEventPayloadMap,
  ToolResultRawMap,
  ToolResultSuccessEventPayload,
  UnknownToolResultRaw,
  UnknownToolResultSuccessEventPayload,
} from './run-events.js';
import type { ProjectId, RunId, ThreadId } from './ids.js';
import {
  AGENT_WAIT_APPROVAL_BLOCKED_REASON,
  AGENT_WAIT_BLOCKED_REASONS,
  isAgentChildTerminalState,
  isAgentLaunchToolRaw,
  isAgentStopToolRaw,
  isAgentWaitBlockedReason,
  isAgentWaitToolRaw,
  isArtifactCommittedEventPayload,
  isDoneEventPayload,
  isErrorEventPayload,
  isInterjectAppliedEventPayload,
  isRunAckEventPayload,
  isRunEvent,
  isSubagentApprovalRequiredEventPayload,
  isSubagentSpawnedEventPayload,
  isSubagentTerminalEventPayload,
  isTextDeltaEventPayload,
  isThreadStatePersistFailedEventPayload,
  isThreadStatePersistedEventPayload,
  isToolCallSourcePayload,
  isToolCallEventPayload,
  isToolResultEventPayload,
  isToolResultRaw,
} from './run-events.js';
import { isProjectId, isRunId, isThreadId } from './ids.js';

function assertFixtureRunId(value: string): RunId {
  assert.equal(isRunId(value), true);
  return value as RunId;
}

function assertFixtureProjectId(value: string): ProjectId {
  assert.equal(isProjectId(value), true);
  return value as ProjectId;
}

function assertFixtureThreadId(value: string): ThreadId {
  assert.equal(isThreadId(value), true);
  return value as ThreadId;
}

const PROJECT_ID = assertFixtureProjectId('workspace');
const THREAD_ID = assertFixtureThreadId('11111111-1111-4111-8111-111111111111');
const RUN_ID = assertFixtureRunId('run-event-1');

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? true
    : false;
type Expect<T extends true> = T;

type _KnownToolResultRawToolMatchesRawMap = Expect<
  Equal<KnownToolResultRawTool, keyof ToolResultRawMap>
>;
type _KnownToolResultRawKeepsAgentSpawnShape = Expect<
  Equal<KnownToolResultRaw<'agent_spawn'>, ToolResultRawMap['agent_spawn']>
>;
type _KnownToolResultSuccessKeepsAgentSpawnRaw = Expect<
  Equal<
    KnownToolResultSuccessEventPayload<'agent_spawn'>['raw'],
    ToolResultRawMap['agent_spawn']
  >
>;
type _UnknownToolResultSuccessKeepsOpaqueRaw = Expect<
  Equal<UnknownToolResultSuccessEventPayload<'read_file'>['raw'], unknown>
>;
type _GenericToolResultSuccessIsExplicitKnownOrUnknown = Expect<
  Equal<
    ToolResultSuccessEventPayload,
    KnownToolResultSuccessEventPayload | UnknownToolResultSuccessEventPayload
  >
>;
type _ToolResultSuccessForUnownedToolUsesUnknownRaw = Expect<
  Equal<ToolResultSuccessEventPayload<'read_file'>['raw'], UnknownToolResultRaw>
>;
type _AgentWaitBlockedReasonKeepsApprovalPendingVocabulary = Expect<
  Equal<AgentWaitBlockedReason, 'approval_pending'>
>;
type _InterjectAppliedReceivedSeqsStayNumeric = Expect<
  Equal<InterjectAppliedEventPayload['receivedSeqs'], number[]>
>;

void test('shared payload guards accept canonical shapes and reject malformed ones', () => {
  assert.equal(isAgentChildTerminalState('completed'), true);
  assert.equal(isAgentChildTerminalState('failed'), true);
  assert.equal(isAgentChildTerminalState('cancelled'), true);
  assert.equal(isAgentChildTerminalState('blocked'), false);
  assert.deepEqual(AGENT_WAIT_BLOCKED_REASONS, ['approval_pending']);
  assert.equal(AGENT_WAIT_APPROVAL_BLOCKED_REASON, 'approval_pending');
  assert.equal(isAgentWaitBlockedReason('approval_pending'), true);
  assert.equal(isAgentWaitBlockedReason('awaiting_approval'), false);

  assert.equal(isTextDeltaEventPayload({ text: 'hello' }), true);
  assert.equal(isTextDeltaEventPayload({ text: 1 }), false);

  assert.equal(
    isRunAckEventPayload({ runId: RUN_ID, threadId: THREAD_ID }),
    true,
  );
  assert.equal(
    isRunAckEventPayload({ runId: 'bad id', threadId: THREAD_ID }),
    false,
  );

  assert.equal(
    isToolCallEventPayload({
      callId: 'call-1',
      step: 1,
      tool: 'read_file',
      args: { path: 'docs/a.md' },
    }),
    true,
  );
  assert.equal(
    isToolCallEventPayload({
      callId: 'call-1',
      step: 1,
      tool: 'read_file',
      args: [],
    }),
    false,
  );
  assert.equal(isToolCallSourcePayload({ kind: 'agent_loop' }), true);
  assert.equal(
    isToolCallSourcePayload({
      kind: 'ptc_callback',
      parentCallId: 'call-parent',
      runtimeToolCallId: 'runtime-call-1',
      cellId: 'ptc_cell_runtime_1',
    }),
    true,
  );
  assert.equal(
    isToolCallSourcePayload({
      kind: 'ptc_callback',
      parentCallId: 'call-parent',
      runtimeToolCallId: 'runtime-call-1',
      cellId: 123,
    }),
    false,
  );
  assert.equal(
    isToolCallSourcePayload({
      kind: 'ptc_callback',
      parentCallId: 'call-parent',
    }),
    false,
  );
  assert.equal(
    isToolCallEventPayload({
      callId: 'call-parent::nested-1',
      step: 1,
      tool: 'read_file',
      args: { path: 'docs/a.md' },
      source: {
        kind: 'ptc_callback',
        parentCallId: 'call-parent',
        runtimeToolCallId: 'runtime-call-1',
        cellId: 'ptc_cell_runtime_1',
      },
    }),
    true,
  );
  assert.equal(
    isToolCallEventPayload({
      callId: 'call-parent::nested-1',
      step: 1,
      tool: 'read_file',
      args: { path: 'docs/a.md' },
      source: { kind: 'ptc_callback', parentCallId: 'call-parent' },
    }),
    false,
  );

  assert.equal(
    isToolResultEventPayload({
      callId: 'call-1',
      step: 1,
      tool: 'read_file',
      ok: true,
      workspaceFilesMayHaveChanged: false,
      displayText: 'ok',
      raw: { path: 'docs/a.md' },
    }),
    true,
  );
  assert.equal(
    isToolResultEventPayload({
      callId: 'call-parent::nested-1',
      step: 1,
      tool: 'read_file',
      ok: true,
      workspaceFilesMayHaveChanged: false,
      displayText: 'ok',
      raw: { path: 'docs/a.md' },
      source: {
        kind: 'ptc_callback',
        parentCallId: 'call-parent',
        runtimeToolCallId: 'runtime-call-1',
        cellId: 'ptc_cell_runtime_1',
      },
    }),
    true,
  );
  assert.equal(
    isToolResultEventPayload({
      callId: 'call-parent::nested-1',
      step: 1,
      tool: 'read_file',
      ok: true,
      workspaceFilesMayHaveChanged: false,
      displayText: 'ok',
      raw: { path: 'docs/a.md' },
      source: { kind: 'ptc_callback', parentCallId: 'call-parent' },
    }),
    false,
  );
  assert.equal(
    isSubagentSpawnedEventPayload({
      parentRunId: RUN_ID,
      childRunId: RUN_ID,
      childThreadId: THREAD_ID,
      subagentType: 'explorer',
    }),
    true,
  );
  assert.equal(
    isSubagentTerminalEventPayload({
      deliveryId: 'delivery-timeout',
      parentRunId: RUN_ID,
      childRunId: RUN_ID,
      subagentType: 'worker',
      terminalState: 'cancelled',
      ok: false,
      reason: 'timeout',
      result: 'cancelled',
    }),
    true,
  );
  assert.equal(
    isSubagentApprovalRequiredEventPayload({
      parentRunId: RUN_ID,
      childRunId: RUN_ID,
      subagentType: 'worker',
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
    }),
    true,
  );
  assert.equal(
    isInterjectAppliedEventPayload({
      runId: RUN_ID,
      count: 2,
      receivedSeqs: [1, 2],
    }),
    true,
  );
  assert.equal(
    isInterjectAppliedEventPayload({
      runId: RUN_ID,
      count: 2,
      receivedSeqs: [1],
    }),
    false,
  );
  assert.equal(
    isToolResultEventPayload({
      callId: 'call-1',
      step: 1,
      tool: 'read_file',
      ok: false,
      workspaceFilesMayHaveChanged: false,
      displayText: 'failed',
      raw: null,
      errorCode: 'totally_new_error',
    }),
    false,
  );
  assert.equal(
    isToolResultEventPayload({
      callId: 'call-1',
      step: 1,
      tool: 'read_file',
      ok: true,
      workspaceFilesMayHaveChanged: false,
      displayText: 'ok',
    }),
    false,
  );
  assert.equal(
    isToolResultEventPayload({
      callId: 'call-1',
      step: 1,
      tool: 'read_file',
      ok: false,
      workspaceFilesMayHaveChanged: false,
      displayText: 'failed',
      raw: null,
      errorCode: 'invalid_args',
    }),
    false,
  );
  assert.equal(
    isToolResultEventPayload({
      callId: 'call-1',
      step: 1,
      tool: 'agent_spawn',
      ok: true,
      workspaceFilesMayHaveChanged: false,
      displayText: 'child started',
      raw: {
        ok: true,
        childRunId: 'child-1',
        childThreadId: THREAD_ID,
        subagentType: 'explorer',
        launchState: 'started',
      },
      error: 'should not be present',
    }),
    false,
  );
  assert.equal(
    isToolResultEventPayload({
      callId: 'call-2',
      step: 1,
      tool: 'agent_wait',
      ok: true,
      workspaceFilesMayHaveChanged: false,
      displayText: 'child wait complete',
      raw: {
        ok: true,
        completed: [
          {
            childRunId: 'child-1',
            terminalState: 'completed',
            ok: true,
            result: 'done',
          },
        ],
        pending: [],
        blocked: [],
      },
    }),
    true,
  );
  const rejectedSpawnRaw = {
    ok: false,
    launchState: 'rejected',
    subagentType: 'worker',
    errorCode: 'invalid_args',
    error: 'invalid child launch request',
  } satisfies ToolResultRawMap['agent_spawn'];
  assert.equal(
    isToolResultEventPayload({
      callId: 'call-3',
      step: 1,
      tool: 'agent_spawn',
      ok: true,
      workspaceFilesMayHaveChanged: false,
      displayText: 'child launch rejected',
      raw: rejectedSpawnRaw,
    }),
    true,
  );
  const cappedSendInputRaw = {
    ok: false,
    launchState: 'rejected',
    subagentType: 'explorer',
    errorCode: 'too_many_child_runs',
    error: 'maximum 8 concurrent child agents allowed',
    effectiveMax: 8,
  } satisfies ToolResultRawMap['agent_send_input'];
  assert.equal(
    isToolResultEventPayload({
      callId: 'call-4',
      step: 1,
      tool: 'agent_send_input',
      ok: true,
      workspaceFilesMayHaveChanged: false,
      displayText: 'child continuation rejected',
      raw: cappedSendInputRaw,
    }),
    true,
  );
  const stopRaw = {
    ok: true,
    childRunId: 'child-1',
    stopState: 'already_terminal',
  } satisfies ToolResultRawMap['agent_stop'];
  assert.equal(
    isToolResultEventPayload({
      callId: 'call-5',
      step: 1,
      tool: 'agent_stop',
      ok: true,
      workspaceFilesMayHaveChanged: false,
      displayText: 'child already terminal',
      raw: stopRaw,
    }),
    true,
  );
  assert.equal(
    isToolResultEventPayload({
      callId: 'call-6',
      step: 1,
      tool: 'agent_spawn',
      ok: true,
      workspaceFilesMayHaveChanged: false,
      displayText: 'malformed child launch',
      raw: {
        ok: false,
        launchState: 'rejected',
        subagentType: 'worker',
        errorCode: 'unsupported_mode',
        error: 'legacy mode is not a launch rejection code',
      },
    }),
    false,
  );
  assert.equal(
    isToolResultEventPayload({
      callId: 'call-7',
      step: 1,
      tool: 'agent_wait',
      ok: true,
      workspaceFilesMayHaveChanged: false,
      displayText: 'malformed child wait',
      raw: {
        ok: true,
        completed: [
          {
            childRunId: 'child-1',
            terminalState: 'blocked',
            ok: false,
            result: 'not terminal',
          },
        ],
        pending: [],
        blocked: [],
      },
    }),
    false,
  );
  assert.equal(
    isToolResultEventPayload({
      callId: 'call-8',
      step: 1,
      tool: 'agent_stop',
      ok: true,
      workspaceFilesMayHaveChanged: false,
      displayText: 'malformed child stop',
      raw: {
        ok: true,
        childRunId: 'child-1',
        stopState: 'stopped',
      },
    }),
    false,
  );
  assert.equal(
    isToolResultEventPayload({
      callId: 'call-9',
      step: 1,
      tool: 'custom_tool',
      ok: true,
      workspaceFilesMayHaveChanged: false,
      displayText: 'unknown raw stays opaque',
      raw: {
        any: 'shape',
      },
    }),
    true,
  );

  assert.equal(isDoneEventPayload({ answer: 'done', ok: true }), true);
  assert.equal(isDoneEventPayload({ answer: 'done', ok: 'yes' }), false);

  assert.equal(
    isThreadStatePersistedEventPayload({
      threadId: THREAD_ID,
      projectId: PROJECT_ID,
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
        projectId: PROJECT_ID,
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
    commentary_delta: { text: 'commentary' },
    tool_call: {
      callId: 'call-1',
      step: 1,
      tool: 'read_file',
      args: { path: 'docs/a.md' },
    },
    tool_result: {
      callId: 'call-1',
      step: 1,
      tool: 'read_file',
      ok: true,
      workspaceFilesMayHaveChanged: false,
      displayText: 'ok',
      raw: { path: 'docs/a.md' },
    },
    subagent_spawned: {
      parentRunId: RUN_ID,
      childRunId: RUN_ID,
      childThreadId: THREAD_ID,
      subagentType: 'explorer',
    },
    subagent_terminal: {
      deliveryId: 'delivery-terminal',
      parentRunId: RUN_ID,
      childRunId: RUN_ID,
      subagentType: 'worker',
      terminalState: 'failed',
      ok: false,
      reason: 'child_error',
      result: 'failed',
    },
    subagent_approval_required: {
      parentRunId: RUN_ID,
      childRunId: RUN_ID,
      subagentType: 'worker',
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
    final_answer_delta: { text: 'final' },
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
        projectId: PROJECT_ID,
        threadId: THREAD_ID,
        runId: RUN_ID,
        filePath: 'episodes/ch01.md',
        messageTimestamp: '2026-04-10T00:00:00.000Z',
      },
    },
    thread_state_persisted: {
      threadId: THREAD_ID,
      projectId: PROJECT_ID,
      snapshotVersion: '2026-04-10T00:00:00.000Z',
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
      type: 'thread_state_persist_failed',
      ts: new Date().toISOString(),
      payload: payloads.thread_state_persist_failed,
    }),
    true,
  );
});

void test('subagent tool raw guards accept owned shapes and reject malformed raw payloads', () => {
  assert.equal(
    isAgentLaunchToolRaw({
      ok: true,
      childRunId: 'child-1',
      childThreadId: THREAD_ID,
      subagentType: 'explorer',
      launchState: 'started',
    }),
    true,
  );
  assert.equal(
    isToolResultRaw('agent_spawn', {
      ok: false,
      launchState: 'rejected',
      subagentType: 'worker',
      errorCode: 'too_many_child_runs',
      error: 'maximum 8 concurrent child agents allowed',
      effectiveMax: 8,
    }),
    true,
  );
  assert.equal(
    isAgentLaunchToolRaw({
      ok: false,
      launchState: 'rejected',
      subagentType: 'worker',
      errorCode: 'too_many_child_runs',
      error: 'missing effective max',
    }),
    false,
  );
  assert.equal(
    isAgentLaunchToolRaw({
      ok: false,
      launchState: 'rejected',
      subagentType: 'writer',
      errorCode: 'invalid_args',
      error: 'bad role',
    }),
    false,
  );
  assert.equal(
    isAgentWaitToolRaw({
      ok: true,
      completed: [
        {
          childRunId: 'child-1',
          terminalState: 'cancelled',
          ok: false,
          reason: 'explicit_stop',
          result: 'stopped',
        },
      ],
      pending: ['child-2'],
      blocked: [
        {
          childRunId: 'child-3',
          blockedReason: 'approval_pending',
        },
      ],
    }),
    true,
  );
  assert.equal(
    isAgentWaitToolRaw({
      ok: true,
      completed: [],
      pending: [1],
      blocked: [],
    }),
    false,
  );
  assert.equal(
    isAgentWaitToolRaw({
      ok: true,
      completed: [],
      pending: [],
      blocked: [
        {
          childRunId: 'child-1',
          blockedReason: 'waiting',
        },
      ],
    }),
    false,
  );
  assert.equal(
    isAgentStopToolRaw({
      ok: true,
      childRunId: 'child-1',
      stopState: 'stopping',
    }),
    true,
  );
  assert.equal(
    isAgentStopToolRaw({
      ok: true,
      childRunId: 'child-1',
      stopState: 'cancelled',
    }),
    false,
  );
});
