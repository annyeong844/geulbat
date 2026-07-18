import assert from 'node:assert/strict';
import test from 'node:test';

import { makeRunContext } from '../../test-support/run-context.js';
import { createAgentEvent, type AgentEvent } from './events.js';
import { createAgentLoopLifecyclePort } from './loop-lifecycle-port.js';
import { createRunState } from './runtime/run-state.js';

void test('default lifecycle port preserves terminal event and run settlement semantics', () => {
  const port = createAgentLoopLifecyclePort();
  const completed = createRunState({
    runId: 'lifecycle-completed',
    runContext: makeRunContext(),
  });
  port.settleAfterResult({
    runState: completed,
    result: { ok: true, finalProse: 'done' },
  });
  assert.equal(completed.status, 'completed');

  const failed = createRunState({
    runId: 'lifecycle-failed',
    runContext: makeRunContext(),
  });
  const events: AgentEvent[] = [];
  const failure = port.createTerminalFailure({
    emit(type, payload) {
      events.push(createAgentEvent(type, payload));
    },
    code: 'execution_failed',
    message: 'host lifecycle failure',
  });
  port.settleAfterResult({ runState: failed, result: failure });

  assert.deepEqual(failure, { ok: false, finalProse: '' });
  assert.equal(failed.status, 'failed');
  assert.deepEqual(events, [
    createAgentEvent('error', {
      code: 'execution_failed',
      message: 'host lifecycle failure',
    }),
  ]);
});

void test('default lifecycle port preserves abort-driven cancellation', () => {
  const port = createAgentLoopLifecyclePort();
  const cancelled = createRunState({
    runId: 'lifecycle-cancelled',
    runContext: makeRunContext(),
  });
  cancelled.abortController.abort('cancelled by owner');

  const failure = port.createTerminalFailure({
    emit() {},
    code: 'aborted',
    message: 'run cancelled',
  });
  port.settleAfterResult({
    runState: cancelled,
    result: failure,
    signal: cancelled.abortController.signal,
  });

  assert.equal(cancelled.status, 'cancelled');
});
