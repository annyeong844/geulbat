import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildChildErrorTerminalOutcome,
  buildChildResultTerminalOutcome,
} from './subagent-terminal-outcome.js';

void test('buildChildResultTerminalOutcome completes successful child results', () => {
  assert.deepEqual(
    buildChildResultTerminalOutcome({
      result: {
        ok: true,
        finalProse: 'child finished',
      },
      terminalMessage: 'ignored',
    }),
    {
      terminalState: 'completed',
      terminalReason: null,
      terminalResult: 'child finished',
    },
  );
});

void test('buildChildResultTerminalOutcome keeps visible failure output before fallback text', () => {
  assert.deepEqual(
    buildChildResultTerminalOutcome({
      result: {
        ok: false,
        finalProse: 'child explained failure',
      },
      terminalMessage: 'streamed error',
    }),
    {
      terminalState: 'failed',
      terminalReason: 'child_error',
      terminalResult: 'child explained failure',
    },
  );
});

void test('buildChildResultTerminalOutcome falls back for empty child failures', () => {
  assert.deepEqual(
    buildChildResultTerminalOutcome({
      result: {
        ok: false,
        finalProse: '',
      },
      terminalMessage: 'streamed error',
    }),
    {
      terminalState: 'failed',
      terminalReason: 'child_error',
      terminalResult: 'streamed error',
    },
  );

  assert.deepEqual(
    buildChildResultTerminalOutcome({
      result: {
        ok: false,
        finalProse: '',
      },
      terminalMessage: '',
    }),
    {
      terminalState: 'failed',
      terminalReason: 'child_error',
      terminalResult: 'sub-agent failed',
    },
  );
});

void test('buildChildErrorTerminalOutcome classifies non-abort throws as child errors', () => {
  assert.deepEqual(
    buildChildErrorTerminalOutcome({
      abortSignal: new AbortController().signal,
      isTimedOut: false,
      terminalMessage: '',
    }),
    {
      terminalState: 'failed',
      terminalReason: 'child_error',
      terminalResult: 'sub-agent failed',
    },
  );
});

void test('buildChildErrorTerminalOutcome preserves explicit stop and timeout reasons', () => {
  const explicitStop = new AbortController();
  explicitStop.abort('explicit_stop');
  assert.deepEqual(
    buildChildErrorTerminalOutcome({
      abortSignal: explicitStop.signal,
      isTimedOut: false,
      terminalMessage: 'stopped',
    }),
    {
      terminalState: 'cancelled',
      terminalReason: 'explicit_stop',
      terminalResult: 'stopped',
    },
  );

  const timedOut = new AbortController();
  timedOut.abort('child timeout');
  assert.deepEqual(
    buildChildErrorTerminalOutcome({
      abortSignal: timedOut.signal,
      isTimedOut: true,
      terminalMessage: '',
    }),
    {
      terminalState: 'cancelled',
      terminalReason: 'timeout',
      terminalResult: 'sub-agent cancelled',
    },
  );
});

void test('buildChildErrorTerminalOutcome treats other abort reasons as user interrupts', () => {
  const interrupted = new AbortController();
  interrupted.abort('client disconnected');

  assert.deepEqual(
    buildChildErrorTerminalOutcome({
      abortSignal: interrupted.signal,
      isTimedOut: false,
      terminalMessage: '',
    }),
    {
      terminalState: 'cancelled',
      terminalReason: 'user_interrupt',
      terminalResult: 'sub-agent cancelled',
    },
  );
});
