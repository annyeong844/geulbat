import test from 'node:test';
import assert from 'node:assert/strict';

import type { RunId } from '@geulbat/protocol/ids';
import type { ApprovalRequired } from '@geulbat/protocol/run-approval';

import { testRunId } from '../../test-support/run-id.js';
import { testThreadId } from '../../test-support/thread-id.js';
import type { AgentEvent } from '../runtime-contracts.js';
import { routeChildAgentEvent } from './subagent-event-routing.js';

function createChildRunsRecorder(): {
  pending: RunId[];
  running: RunId[];
  childRuns: {
    markChildApprovalPending: (childRunId: RunId) => void;
    markChildRunning: (childRunId: RunId) => void;
  };
} {
  const pending: RunId[] = [];
  const running: RunId[] = [];
  return {
    pending,
    running,
    childRuns: {
      markChildApprovalPending(childRunId) {
        pending.push(childRunId);
      },
      markChildRunning(childRunId) {
        running.push(childRunId);
      },
    },
  };
}

void test('routeChildAgentEvent publishes parent approval bridge before the original child approval event', () => {
  const parentRunId = testRunId('route-approval-parent');
  const childRunId = testRunId('route-approval-child');
  const approval: ApprovalRequired = {
    callId: 'call-approval-1',
    runId: childRunId,
    threadId: testThreadId(91),
    toolName: 'write_file',
    approvalClass: 'write_file',
    permissionMode: 'basic',
    argumentsPreview: { path: 'notes.md' },
    sideEffectLevel: 'write',
  };
  const approvalEvent: AgentEvent = {
    type: 'approval_required',
    payload: approval,
  };
  const emittedEvents: AgentEvent[] = [];
  const recorder = createChildRunsRecorder();

  const terminalMessage = routeChildAgentEvent({
    event: approvalEvent,
    parentRunId,
    childRunId,
    subagentType: 'worker',
    childRuns: recorder.childRuns,
    emitAgentEvent(event) {
      emittedEvents.push(event);
    },
  });

  assert.equal(terminalMessage, undefined);
  assert.deepEqual(recorder.pending, [childRunId]);
  assert.deepEqual(recorder.running, []);
  assert.deepEqual(emittedEvents, [
    {
      type: 'subagent_approval_required',
      payload: {
        parentRunId,
        childRunId,
        subagentType: 'worker',
        approval,
      },
    },
    approvalEvent,
  ]);
});

void test('routeChildAgentEvent returns child runs to running for non-approval events without forwarding them', () => {
  const childRunId = testRunId('route-running-child');
  const recorder = createChildRunsRecorder();
  const emittedEvents: AgentEvent[] = [];

  const terminalMessage = routeChildAgentEvent({
    event: {
      type: 'commentary_delta',
      payload: { text: 'working' },
    },
    parentRunId: testRunId('route-running-parent'),
    childRunId,
    subagentType: 'explorer',
    childRuns: recorder.childRuns,
    emitAgentEvent(event) {
      emittedEvents.push(event);
    },
  });

  assert.equal(terminalMessage, undefined);
  assert.deepEqual(recorder.pending, []);
  assert.deepEqual(recorder.running, [childRunId]);
  assert.deepEqual(emittedEvents, []);
});

void test('routeChildAgentEvent extracts terminal fallback text from child error events', () => {
  const childRunId = testRunId('route-error-child');
  const recorder = createChildRunsRecorder();

  const terminalMessage = routeChildAgentEvent({
    event: {
      type: 'error',
      payload: {
        code: 'execution_failed',
        message: 'child loop stopped after tool failure',
      },
    },
    parentRunId: testRunId('route-error-parent'),
    childRunId,
    subagentType: 'worker',
    childRuns: recorder.childRuns,
  });

  assert.equal(terminalMessage, 'child loop stopped after tool failure');
  assert.deepEqual(recorder.pending, []);
  assert.deepEqual(recorder.running, [childRunId]);
});
