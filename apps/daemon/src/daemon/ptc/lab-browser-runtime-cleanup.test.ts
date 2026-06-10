import assert from 'node:assert/strict';
import test from 'node:test';

import {
  classifyPtcLabBrowserRuntimeCommandOutcome,
  toPtcLabBrowserRuntimeInputCleanupFailureEnvelope,
} from './lab-browser-runtime-cleanup.js';

const RUNTIME_FAILURE_MESSAGES = {
  cancelled: 'cancelled',
  cleanupUncertain: 'cleanup uncertain',
  executionFailed: 'execution failed',
  inputPrepareFailed: 'input prepare failed',
  runnerThrew: 'runner threw',
  timedOut: 'timed out',
} as const;

void test('browser runtime cleanup envelope is absent when cleanup is not needed or succeeds', () => {
  assert.equal(
    toPtcLabBrowserRuntimeInputCleanupFailureEnvelope({
      attempted: false,
      status: 'not_needed',
    }),
    undefined,
  );
  assert.equal(
    toPtcLabBrowserRuntimeInputCleanupFailureEnvelope({
      attempted: true,
      status: 'removed',
    }),
    undefined,
  );
});

void test('browser runtime cleanup envelope preserves failed close reason without raw session facts', () => {
  assert.deepEqual(
    toPtcLabBrowserRuntimeInputCleanupFailureEnvelope({
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
    }),
    {
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
  );
});

void test('browser runtime cleanup envelope omits close failure flags when taint close is proven', () => {
  assert.deepEqual(
    toPtcLabBrowserRuntimeInputCleanupFailureEnvelope({
      attempted: true,
      closeOutcome: {
        closeAttempted: true,
        closeProven: true,
        closeStatus: 'succeeded',
        reuseAllowed: false,
        sessionTainted: true,
      },
      status: 'failed',
    }),
    {
      sessionLifecycle: {
        mode: 'runtime_owned',
        retainedAfterExecution: false,
        taintedAfterExecution: true,
      },
      diagnostics: {
        inputCleanupFailed: true,
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
