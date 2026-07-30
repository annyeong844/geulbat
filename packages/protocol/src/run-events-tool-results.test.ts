import assert from 'node:assert/strict';
import test from 'node:test';

import type { ToolResultRawMap } from './run-events.js';
import {
  isAgentLaunchToolRaw,
  isAgentSetPriorityToolRaw,
  isAgentStopToolRaw,
  isAgentWaitToolRaw,
  isInterjectAppliedEventPayload,
  isToolCallEventPayload,
  isToolCallSourcePayload,
  isToolResultEventPayload,
  isToolResultRaw,
} from './run-events.js';
import {
  TEST_RUN_EVENT_RUN_ID as RUN_ID,
  TEST_RUN_EVENT_THREAD_ID as THREAD_ID,
} from './test-support/run-events.js';

void test('tool call sources and basic tool result envelopes reject malformed shapes', () => {
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
      computerFilesMayHaveChanged: false,
      displayText: 'ok',
      raw: { path: 'docs/a.md' },
    }),
    true,
  );
  assert.equal(
    isToolResultEventPayload({
      callId: 'call-1',
      step: 1,
      tool: 'read_file',
      ok: true,
      computerFilesMayHaveChanged: false,
      workspaceFilesMayHaveChanged: false,
      displayText: 'legacy mutation signal must be rejected',
      raw: { path: 'docs/a.md' },
    }),
    false,
  );
  assert.equal(
    isToolResultEventPayload({
      callId: 'call-parent::nested-1',
      step: 1,
      tool: 'read_file',
      ok: true,
      computerFilesMayHaveChanged: false,
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
      computerFilesMayHaveChanged: false,
      displayText: 'ok',
      raw: { path: 'docs/a.md' },
      source: { kind: 'ptc_callback', parentCallId: 'call-parent' },
    }),
    false,
  );
});

void test('agent_wait tool result accepts offloaded slim raw the emit path produces', () => {
  // 오프로드된 agent_wait raw — 2026-07-21 저널 오염 사고의 실제 형태.
  // emit이 기록한 이벤트를 저널 재독이 거부하면 run.auth 복구가 영구히
  // 죽으므로, 읽기 계약은 쓰기 경로가 만드는 형태를 그대로 수용해야 한다.
  const offloadedRaw = {
    ok: true,
    offloaded: true,
    tool: 'agent_wait',
    callId: 'call-wait-1',
    outputRef: 'tool-output:thread-1/run-1/call-wait-1',
    summary: 'agent_wait returned 4 completed, 0 pending, and 0 blocked runs.',
    fullOutputBytes: 48067,
    fullOutputChars: 21556,
    recoveryTool: 'read_tool_output',
  };
  assert.equal(
    isToolResultEventPayload({
      callId: 'call-wait-1',
      step: 4,
      tool: 'agent_wait',
      ok: true,
      computerFilesMayHaveChanged: false,
      displayText: 'offloaded agent_wait result',
      raw: offloadedRaw,
    }),
    true,
  );
  // 다른 raw-owner 툴 이름이 박힌 슬림 참조는 여전히 거부한다
  assert.equal(
    isToolResultEventPayload({
      callId: 'call-wait-1',
      step: 4,
      tool: 'agent_wait',
      ok: true,
      computerFilesMayHaveChanged: false,
      displayText: 'mismatched offloaded tool',
      raw: { ...offloadedRaw, tool: 'exec' },
    }),
    false,
  );
  // 재진입 수단이 빠진 슬림 참조도 거부한다 — 복구 불가능한 참조는 계약 밖
  assert.equal(
    isToolResultEventPayload({
      callId: 'call-wait-1',
      step: 4,
      tool: 'agent_wait',
      ok: true,
      computerFilesMayHaveChanged: false,
      displayText: 'missing recovery tool',
      raw: { ...offloadedRaw, recoveryTool: undefined },
    }),
    false,
  );
});

void test('interject and tool result envelope guards preserve correlation invariants', () => {
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
      tool: 'exec_command',
      ok: false,
      computerFilesMayHaveChanged: false,
      displayText: 'blocked by plan approval',
      raw: null,
      errorCode: 'approval_required',
      error: 'PLAN_APPROVAL_REQUIRED',
      diagnostics: {
        phase: 'admission',
        reasonCode: 'plan_approval_required',
        gate: {
          kind: 'plan_approval',
          effectivePermissionMode: 'full_access',
        },
      },
    }),
    true,
  );
  assert.equal(
    isToolResultEventPayload({
      callId: 'call-1',
      step: 1,
      tool: 'exec_command',
      ok: false,
      computerFilesMayHaveChanged: false,
      displayText: 'failed',
      raw: null,
      errorCode: 'execution_failed',
      error: 'failed',
      diagnostics: {
        phase: 'unknown_phase',
        reasonCode: 'opaque_failure',
      },
    }),
    false,
  );
  assert.equal(
    isToolResultEventPayload({
      callId: 'call-1',
      step: 1,
      tool: 'read_file',
      ok: false,
      computerFilesMayHaveChanged: false,
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
      computerFilesMayHaveChanged: false,
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
      computerFilesMayHaveChanged: false,
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
      computerFilesMayHaveChanged: false,
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
});

void test('subagent tool result guards accept owned success and rejection shapes', () => {
  const queuedSpawnRaw = {
    ok: true,
    childRunId: 'child-queued',
    childThreadId: THREAD_ID,
    subagentType: 'worker',
    launchState: 'queued',
    deferReason: 'configured_capacity',
  } satisfies ToolResultRawMap['agent_spawn'];
  assert.equal(isAgentLaunchToolRaw(queuedSpawnRaw), true);
  assert.equal(
    isToolResultEventPayload({
      callId: 'call-2',
      step: 1,
      tool: 'agent_wait',
      ok: true,
      computerFilesMayHaveChanged: false,
      displayText: 'child wait complete',
      raw: {
        ok: true,
        completed: [
          {
            childRunId: 'child-1',
            terminalState: 'completed',
            ok: true,
            result: 'done',
            resultRef: 'subagent-result:delivery-1',
            resultDigest:
              'sha256:0000000000000000000000000000000000000000000000000000000000000000',
            resultReport: {
              summary: 'compact handoff',
              sourceResultRef: 'subagent-result:delivery-1',
              sourceResultDigest:
                'sha256:0000000000000000000000000000000000000000000000000000000000000000',
            },
          },
        ],
        pending: [],
        blocked: [],
        launches: [
          {
            childRunId: 'child-1',
            childThreadId: THREAD_ID,
            launchState: 'started',
            priorityClass: 'high',
            enqueueOrder: 1,
            createdAt: '2026-07-23T00:00:00.000Z',
            updatedAt: '2026-07-23T00:00:01.000Z',
            deferReason: 'configured_capacity',
          },
        ],
      },
    }),
    true,
  );
  assert.equal(
    isAgentWaitToolRaw({
      ok: true,
      completed: [
        {
          childRunId: 'child-1',
          terminalState: 'completed',
          ok: true,
          result: 'done',
          resultReport: {
            summary: 'compact handoff',
            sourceResultRef: 'subagent-result:delivery-1',
            sourceResultDigest: 'not-a-digest',
          },
        },
      ],
      pending: [],
      blocked: [],
    }),
    false,
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
      computerFilesMayHaveChanged: false,
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
      computerFilesMayHaveChanged: false,
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
      computerFilesMayHaveChanged: false,
      displayText: 'child already terminal',
      raw: stopRaw,
    }),
    true,
  );
  const cancelledBeforeStartRaw = {
    ok: true,
    childRunId: 'child-2',
    stopState: 'cancelled_before_start',
  } satisfies ToolResultRawMap['agent_stop'];
  assert.equal(isAgentStopToolRaw(cancelledBeforeStartRaw), true);

  const priorityRaw = {
    ok: true,
    childRunId: 'child-2',
    launchState: 'queued',
    priorityClass: 'high',
    updateState: 'updated',
  } satisfies ToolResultRawMap['agent_set_priority'];
  assert.equal(isAgentSetPriorityToolRaw(priorityRaw), true);
  assert.equal(
    isToolResultEventPayload({
      callId: 'call-6',
      step: 1,
      tool: 'agent_set_priority',
      ok: true,
      computerFilesMayHaveChanged: false,
      displayText: 'queued child priority updated',
      raw: priorityRaw,
    }),
    true,
  );
});

void test('subagent tool result guards reject malformed owned shapes and preserve unknown raw', () => {
  assert.equal(
    isToolResultEventPayload({
      callId: 'call-6',
      step: 1,
      tool: 'agent_spawn',
      ok: true,
      computerFilesMayHaveChanged: false,
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
    isAgentWaitToolRaw({
      ok: true,
      completed: [],
      pending: [],
      blocked: [],
      launches: [
        {
          childRunId: 'child-1',
          childThreadId: THREAD_ID,
          launchState: 'waiting',
          priorityClass: 'high',
          enqueueOrder: 0,
          createdAt: 'not-a-timestamp',
          updatedAt: '2026-07-23T00:00:00.000Z',
        },
      ],
    }),
    false,
  );
  assert.equal(
    isAgentSetPriorityToolRaw({
      ok: true,
      childRunId: 'child-1',
      launchState: 'queued',
      priorityClass: 'urgent',
      updateState: 'updated',
    }),
    false,
  );
  assert.equal(
    isToolResultEventPayload({
      callId: 'call-7',
      step: 1,
      tool: 'agent_wait',
      ok: true,
      computerFilesMayHaveChanged: false,
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
      computerFilesMayHaveChanged: false,
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
      computerFilesMayHaveChanged: false,
      displayText: 'unknown raw stays opaque',
      raw: {
        any: 'shape',
      },
    }),
    true,
  );
});

void test('subagent tool raw guards accept owned shapes and reject malformed raw payloads', () => {
  assert.equal(
    isAgentLaunchToolRaw({
      ok: true,
      childRunId: 'child-queued',
      childThreadId: THREAD_ID,
      subagentType: 'worker',
      launchState: 'queued',
      deferReason: 'batch_group_wait',
    }),
    true,
  );
  assert.equal(
    isAgentLaunchToolRaw({
      ok: true,
      childRunId: 'child-queued',
      childThreadId: THREAD_ID,
      subagentType: 'worker',
      launchState: 'queued',
      deferReason: 'busy_for_now',
    }),
    false,
  );
  assert.equal(
    isAgentLaunchToolRaw({
      ok: true,
      childRunId: 'child-1',
      childThreadId: THREAD_ID,
      subagentType: 'explorer',
      launchState: 'started',
      modelId: 'grok-4.5',
      reasoningEffort: 'high',
      selectionSource: 'model_selected',
    }),
    true,
  );
  assert.equal(
    isAgentLaunchToolRaw({
      ok: true,
      childRunId: 'child-1',
      childThreadId: THREAD_ID,
      subagentType: 'explorer',
      launchState: 'started',
      modelId: 'grok-4.5',
      reasoningEffort: 'xhigh',
      selectionSource: 'silent_fallback',
    }),
    false,
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
      completed: [
        {
          deliveryId: 'delivery-ref-only',
          childRunId: 'child-ref-only',
          terminalState: 'failed',
          ok: false,
          reason: 'provider_error',
          resultRef: 'subagent-result:delivery-ref-only',
          resultDigest: `sha256:${'a'.repeat(64)}`,
          parentRunId: RUN_ID,
          childThreadId: THREAD_ID,
          subagentType: 'worker',
          capabilities: [],
          toolSurface: 'worker',
          completedAt: '2026-07-26T11:00:00.000Z',
          elapsedMs: 1_250,
          usage: {
            inputTokens: 100,
            outputTokens: 25,
            cachedInputTokens: 10,
          },
          modelId: 'gpt-5.6-sol',
          reasoningEffort: 'high',
        },
      ],
      pending: [],
      blocked: [],
    }),
    true,
  );
  assert.equal(
    isAgentWaitToolRaw({
      ok: true,
      completed: [
        {
          deliveryId: ' ',
          childRunId: 'child-bad-delivery',
          terminalState: 'failed',
          ok: false,
          result: 'failed',
        },
      ],
      pending: [],
      blocked: [],
    }),
    false,
  );
  assert.equal(
    isAgentWaitToolRaw({
      ok: true,
      completed: [
        {
          childRunId: 'child-ref-bad-digest',
          terminalState: 'failed',
          ok: false,
          resultRef: 'subagent-result:delivery-bad-digest',
          resultDigest: 'sha256:not-a-digest',
        },
      ],
      pending: [],
      blocked: [],
    }),
    false,
  );
  assert.equal(
    isAgentWaitToolRaw({
      ok: true,
      completed: [
        {
          childRunId: 'child-without-result',
          terminalState: 'failed',
          ok: false,
        },
      ],
      pending: [],
      blocked: [],
    }),
    false,
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
