import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildChildErrorTerminalOutcome,
  buildChildResultTerminalOutcome,
} from './subagent-terminal-outcome.js';

const activeChildSignal = new AbortController().signal;

void test('buildChildResultTerminalOutcome completes successful child results', () => {
  assert.deepEqual(
    buildChildResultTerminalOutcome({
      abortSignal: activeChildSignal,
      isTimedOut: false,
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
      abortSignal: activeChildSignal,
      isTimedOut: false,
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
      abortSignal: activeChildSignal,
      isTimedOut: false,
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
      abortSignal: activeChildSignal,
      isTimedOut: false,
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

void test('buildChildResultTerminalOutcome preserves an explicit stop returned as a loop result', () => {
  const explicitStop = new AbortController();
  explicitStop.abort('explicit_stop');

  assert.deepEqual(
    buildChildResultTerminalOutcome({
      abortSignal: explicitStop.signal,
      isTimedOut: false,
      result: {
        ok: false,
        finalProse: 'run cancelled',
      },
      terminalMessage: '',
    }),
    {
      terminalState: 'cancelled',
      terminalReason: 'explicit_stop',
      terminalResult: 'run cancelled',
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

void test('terminal outcome builders preserve a classified infrastructure reason', () => {
  assert.deepEqual(
    buildChildResultTerminalOutcome({
      abortSignal: activeChildSignal,
      isTimedOut: false,
      result: {
        ok: false,
        finalProse: 'provider rejected the child request',
      },
      terminalMessage: '',
      terminalReason: 'provider_error',
    }),
    {
      terminalState: 'failed',
      terminalReason: 'provider_error',
      terminalResult: 'provider rejected the child request',
    },
  );

  assert.deepEqual(
    buildChildErrorTerminalOutcome({
      abortSignal: new AbortController().signal,
      isTimedOut: false,
      terminalMessage: 'runtime state store unavailable',
      terminalReason: 'persistence_error',
    }),
    {
      terminalState: 'failed',
      terminalReason: 'persistence_error',
      terminalResult: 'runtime state store unavailable',
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

void test('buildChildErrorTerminalOutcome preserves graceful daemon shutdown', () => {
  const shutdown = new AbortController();
  shutdown.abort('daemon_shutdown');

  assert.deepEqual(
    buildChildErrorTerminalOutcome({
      abortSignal: shutdown.signal,
      isTimedOut: false,
      terminalMessage: '',
    }),
    {
      terminalState: 'cancelled',
      terminalReason: 'daemon_shutdown',
      terminalResult: 'sub-agent cancelled',
    },
  );
});
