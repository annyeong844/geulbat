import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mapAgentEventToRunEvent,
  mapBackgroundSubagentTerminalToRunEvent,
} from './map-events.js';
import type { AgentEvent } from '../../../daemon/agent/events.js';
import type { RunEventPayloadMap } from '@geulbat/protocol/run-events';
import {
  assertRunId as assertValidRunId,
  assertThreadId as assertValidThreadId,
} from '@geulbat/protocol/ids';
import { testThreadId } from '../../../test-support/thread-id.js';

const RUN_ID = assertValidRunId('run-1');
const CHILD_RUN_ID = assertValidRunId('run-child-1');
const THREAD_ID = assertValidThreadId(testThreadId(1));

void test('mapAgentEventToRunEvent maps valid tool_result payloads', () => {
  const event = mapAgentEventToRunEvent(RUN_ID, THREAD_ID, 3, {
    type: 'tool_result',
    payload: {
      callId: 'call-1',
      step: 2,
      tool: 'read_file',
      ok: true,
      workspaceFilesMayHaveChanged: false,
      displayText: 'ok',
      raw: { path: 'docs/a.md' },
    },
  });

  assert.equal(event.type, 'tool_result');
  assert.equal(event.runId, 'run-1');
  assert.equal(event.threadId, THREAD_ID);
  assert.equal(event.seq, 3);
  assert.equal(event.payload.callId, 'call-1');
  assert.equal(event.payload.tool, 'read_file');
  assert.equal(event.payload.ok, true);
  assert.equal(event.payload.workspaceFilesMayHaveChanged, false);
});

void test('mapAgentEventToRunEvent throws on invalid internal payloads', () => {
  const invalidEvent = {
    type: 'run_ack',
    payload: { threadId: THREAD_ID },
  } as unknown as AgentEvent;

  assert.throws(
    () => mapAgentEventToRunEvent(RUN_ID, THREAD_ID, 0, invalidEvent),
    /invalid run_ack payload/,
  );
});

void test('mapBackgroundSubagentTerminalToRunEvent maps valid payloads', () => {
  const event = mapBackgroundSubagentTerminalToRunEvent(
    CHILD_RUN_ID,
    THREAD_ID,
    4,
    {
      deliveryId: 'delivery-1',
      parentRunId: RUN_ID,
      childRunId: CHILD_RUN_ID,
      subagentType: 'worker' as const,
      terminalState: 'failed' as const,
      ok: true,
      result: 'child done',
    },
  );

  assert.equal(event.type, 'subagent_terminal');
  assert.equal(event.runId, 'run-child-1');
  assert.equal(event.threadId, THREAD_ID);
  assert.equal(event.seq, 4);
  assert.equal(event.payload.parentRunId, RUN_ID);
  assert.equal(event.payload.deliveryId, 'delivery-1');
  assert.equal(event.payload.childRunId, 'run-child-1');
  assert.equal(event.payload.subagentType, 'worker');
  assert.equal(event.payload.ok, true);
  assert.equal(event.payload.terminalState, 'failed');
  assert.equal(event.payload.result, 'child done');
});

void test('mapBackgroundSubagentTerminalToRunEvent throws on invalid payloads', () => {
  assert.throws(
    () =>
      mapBackgroundSubagentTerminalToRunEvent(CHILD_RUN_ID, THREAD_ID, 4, {
        deliveryId: 'delivery-2',
        parentRunId: RUN_ID,
        childRunId: CHILD_RUN_ID,
        subagentType:
          1 as unknown as RunEventPayloadMap['subagent_terminal']['subagentType'],
        terminalState: 'completed',
        ok: true,
        result: 'done',
      }),
    /invalid subagent_terminal payload/,
  );
});

void test('mapAgentEventToRunEvent rejects array payloads that masquerade as records', () => {
  const invalidEvent = {
    type: 'tool_result',
    payload: [] as unknown as AgentEvent['payload'],
  } as AgentEvent;

  assert.throws(
    () => mapAgentEventToRunEvent(RUN_ID, THREAD_ID, 0, invalidEvent),
    /invalid tool_result payload/,
  );
});

void test('mapAgentEventToRunEvent rejects malformed approval_required enum payloads', () => {
  const invalidEvent = {
    type: 'approval_required',
    payload: {
      callId: 'call-1',
      runId: RUN_ID,
      threadId: THREAD_ID,
      toolName: 'write_file',
      approvalClass: 'write',
      permissionMode: 'god_mode',
      argumentsPreview: { path: 'docs/a.md' },
      sideEffectLevel: 'write',
    },
  } as unknown as AgentEvent;

  assert.throws(
    () => mapAgentEventToRunEvent(RUN_ID, THREAD_ID, 0, invalidEvent),
    /invalid approval_required payload/,
  );
});
