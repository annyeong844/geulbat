import assert from 'node:assert/strict';
import test from 'node:test';

import {
  classifyPtcLabBrowserRuntimeCommandOutcome,
  toPtcLabBrowserTaintedSessionEnvelope,
} from './lab-browser-runtime-cleanup.js';

const RUNTIME_FAILURE_MESSAGES = {
  cancelled: 'cancelled',
  cleanupUncertain: 'cleanup uncertain',
  executionFailed: 'execution failed',
  inputPrepareFailed: 'input prepare failed',
  runnerThrew: 'runner threw',
  timedOut: 'timed out',
} as const;

void test('browser runtime command classifier accepts cleanup that is absent or removed', () => {
  const exitResult = {
    exitCode: 0,
    kind: 'exit',
    stderr: '',
    stdout: 'ok',
  } as const;
  for (const inputCleanup of [
    { attempted: false, status: 'not_needed' },
    { attempted: true, status: 'removed' },
  ] as const) {
    assert.deepEqual(
      classifyPtcLabBrowserRuntimeCommandOutcome({
        messages: RUNTIME_FAILURE_MESSAGES,
        outcome: {
          inputCleanup,
          primary: {
            kind: 'command_result',
            result: exitResult,
          },
        },
      }),
      { execution: exitResult, ok: true },
    );
  }
});

void test('browser runtime command classifier reports cleanup uncertainty without close-failure flags when taint close is proven', () => {
  assert.deepEqual(
    classifyPtcLabBrowserRuntimeCommandOutcome({
      messages: RUNTIME_FAILURE_MESSAGES,
      outcome: {
        inputCleanup: {
          attempted: true,
          closeOutcome: {
            closeAttempted: true,
            closeProven: true,
            closeStatus: 'succeeded',
            reuseAllowed: false,
            sessionTainted: true,
          },
          status: 'failed',
        },
        primary: {
          kind: 'command_result',
          result: { exitCode: 0, kind: 'exit', stderr: '', stdout: '' },
        },
      },
    }),
    {
      failure: {
        details: {
          sessionLifecycle: {
            mode: 'runtime_owned',
            retainedAfterExecution: false,
            taintedAfterExecution: true,
          },
          diagnostics: {
            inputCleanupFailed: true,
          },
        },
        message: 'cleanup uncertain',
        phase: 'cleanup',
        reasonCode: 'ptc_lab_browser_cleanup_uncertain',
      },
      ok: false,
    },
  );
});

void test('browser tainted session envelope omits diagnostics for proven close', () => {
  assert.deepEqual(
    toPtcLabBrowserTaintedSessionEnvelope({
      closeAttempted: true,
      closeProven: true,
      closeStatus: 'succeeded',
      reuseAllowed: false,
      sessionTainted: true,
    }),
    {
      sessionLifecycle: {
        mode: 'runtime_owned',
        retainedAfterExecution: false,
        taintedAfterExecution: true,
      },
    },
  );
});

void test('browser tainted session envelope preserves failed close diagnostics', () => {
  assert.deepEqual(
    toPtcLabBrowserTaintedSessionEnvelope({
      closeAttempted: true,
      closeProven: false,
      closeStatus: 'failed_result',
      reuseAllowed: false,
      sessionReasonCode: 'container_remove_failed',
      sessionTainted: true,
    }),
    {
      sessionLifecycle: {
        mode: 'runtime_owned',
        retainedAfterExecution: false,
        taintedAfterExecution: true,
      },
      diagnostics: {
        sessionCloseFailed: true,
        sessionReasonCode: 'container_remove_failed',
        sessionTainted: true,
      },
    },
  );
});

void test('browser runtime command classifier preserves runner throw and cleanup diagnostics together', () => {
  assert.deepEqual(
    classifyPtcLabBrowserRuntimeCommandOutcome({
      messages: RUNTIME_FAILURE_MESSAGES,
      outcome: {
        inputCleanup: failedInputCleanup(),
        primary: { kind: 'runner_threw' },
      },
    }),
    {
      failure: {
        details: {
          sessionLifecycle: {
            mode: 'runtime_owned',
            retainedAfterExecution: false,
            taintedAfterExecution: true,
          },
          diagnostics: {
            commandResultKind: 'thrown',
            inputCleanupFailed: true,
            sessionCloseFailed: true,
            sessionReasonCode: 'container_remove_failed',
            sessionTainted: true,
          },
        },
        message: 'runner threw',
        phase: 'navigation',
        reasonCode: 'ptc_lab_browser_navigation_failed',
      },
      ok: false,
    },
  );
});

void test('browser runtime command classifier preserves timeout reason when cleanup also fails', () => {
  assert.deepEqual(
    classifyPtcLabBrowserRuntimeCommandOutcome({
      messages: RUNTIME_FAILURE_MESSAGES,
      outcome: {
        inputCleanup: failedInputCleanup(),
        primary: {
          kind: 'command_result',
          result: { kind: 'timeout', stderr: '', stdout: '' },
        },
      },
    }),
    {
      failure: {
        details: {
          sessionLifecycle: {
            mode: 'runtime_owned',
            retainedAfterExecution: false,
            taintedAfterExecution: true,
          },
          diagnostics: {
            inputCleanupFailed: true,
            sessionCloseFailed: true,
            sessionReasonCode: 'container_remove_failed',
            sessionTainted: true,
          },
        },
        message: 'timed out',
        phase: 'navigation',
        reasonCode: 'ptc_lab_browser_timeout',
      },
      ok: false,
    },
  );
});

void test('browser runtime command classifier reports cleanup uncertainty after apparent exit', () => {
  assert.deepEqual(
    classifyPtcLabBrowserRuntimeCommandOutcome({
      messages: RUNTIME_FAILURE_MESSAGES,
      outcome: {
        inputCleanup: failedInputCleanup(),
        primary: {
          kind: 'command_result',
          result: { exitCode: 0, kind: 'exit', stderr: '', stdout: '' },
        },
      },
    }),
    {
      failure: {
        details: {
          sessionLifecycle: {
            mode: 'runtime_owned',
            retainedAfterExecution: false,
            taintedAfterExecution: true,
          },
          diagnostics: {
            inputCleanupFailed: true,
            sessionCloseFailed: true,
            sessionReasonCode: 'container_remove_failed',
            sessionTainted: true,
          },
        },
        message: 'cleanup uncertain',
        phase: 'cleanup',
        reasonCode: 'ptc_lab_browser_cleanup_uncertain',
      },
      ok: false,
    },
  );
});

function failedInputCleanup() {
  return {
    attempted: true,
    closeOutcome: {
      closeAttempted: true,
      closeProven: false,
      closeStatus: 'failed_result',
      reuseAllowed: false,
      sessionReasonCode: 'container_remove_failed',
      sessionTainted: true,
    },
    status: 'failed',
  } as const;
}
