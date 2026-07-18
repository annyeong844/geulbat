import test from 'node:test';
import assert from 'node:assert/strict';
import type { FunctionCall, ProviderStructuredOutput } from '../llm/index.js';
import type { PtcFixedEpochProbeRuntime } from '../daemon-runtime-contract.js';
import {
  PTC_FIXED_EPOCH_EXECUTION_PROBE_CAPABILITY_ID,
  PTC_FIXED_EPOCH_EXECUTION_PROBE_POLICY_ID,
  type PtcFixedEpochProbeRuntimeSummary,
} from '../ptc/runtime/probes/fixed-probe-runtime-contract.js';
import { makeRunContext } from '../../test-support/run-context.js';
import { testThreadId } from '../../test-support/thread-id.js';
import {
  PTC_FIXED_PROBE_STRUCTURED_OUTPUT_KIND,
  PTC_FIXED_PROBE_STRUCTURED_OUTPUT_PROBE_ID,
  runPtcFixedProbeStructuredOutputCaller,
} from './ptc-fixed-probe-structured-output-caller.js';

const SUCCESS_SUMMARY: PtcFixedEpochProbeRuntimeSummary = {
  ok: true,
  capabilityId: PTC_FIXED_EPOCH_EXECUTION_PROBE_CAPABILITY_ID,
  policyId: PTC_FIXED_EPOCH_EXECUTION_PROBE_POLICY_ID,
  executionClass: 'fixed_docker_exec_probe',
  executionSurface: 'baked_image_node_eval',
  containerId: 'container-ptc-fixed-agent',
  epochId: 'ptc-epoch-agent',
  callbackRoundTrip: 'observed',
  callbackResultKind: 'inline',
  exitCode: 0,
};

function structuredPtcFixedProbeOutput(
  payload: unknown = {
    probeId: PTC_FIXED_PROBE_STRUCTURED_OUTPUT_PROBE_ID,
  },
): ProviderStructuredOutput {
  return {
    schemaVersion: 1,
    kind: PTC_FIXED_PROBE_STRUCTURED_OUTPUT_KIND,
    payload,
  };
}

const TEST_TOOL_CALL: FunctionCall = {
  id: 'fc-test',
  callId: 'call-test',
  name: 'test_tool',
  arguments: '{}',
};

function createRunContext() {
  return makeRunContext({
    threadId: testThreadId(701),
    stateRoot: '/tmp/geulbat-ptc-fixed-probe-agent-test',
    workingDirectory: '',
  });
}

void test('runPtcFixedProbeStructuredOutputCaller returns summary-only agent prose', async () => {
  const runContext = createRunContext();
  let observedRunContext: typeof runContext | undefined;
  const runtime: PtcFixedEpochProbeRuntime = {
    async runFixedEpochProbe(args) {
      observedRunContext = args.runContext;
      return { ok: true, value: SUCCESS_SUMMARY };
    },
  };

  const result = await runPtcFixedProbeStructuredOutputCaller({
    runContext,
    runtime,
    structuredOutputs: [structuredPtcFixedProbeOutput()],
    functionCalls: [],
  });

  assert.equal(result.ok, true);
  assert.equal(observedRunContext, runContext);
  if (!result.ok) {
    return;
  }
  assert.match(result.result.finalProse, /callbackRoundTrip: observed/u);
  assert.match(
    result.result.finalProse,
    /capabilityId: ptc_fixed_epoch_execution_probe/u,
  );
  assert.equal(result.result.artifactCandidate, undefined);
  assert.doesNotMatch(result.result.finalProse, /container-ptc-fixed-agent/u);
  assert.doesNotMatch(result.result.finalProse, /ptc-epoch-agent/u);
});

void test('runPtcFixedProbeStructuredOutputCaller rejects extra request fields before runtime', async () => {
  let calls = 0;
  const runtime: PtcFixedEpochProbeRuntime = {
    async runFixedEpochProbe() {
      calls += 1;
      return { ok: true, value: SUCCESS_SUMMARY };
    },
  };

  const result = await runPtcFixedProbeStructuredOutputCaller({
    runContext: createRunContext(),
    runtime,
    structuredOutputs: [
      structuredPtcFixedProbeOutput({
        probeId: PTC_FIXED_PROBE_STRUCTURED_OUTPUT_PROBE_ID,
        command: 'node -e process.exit(0)',
      }),
    ],
    functionCalls: [],
  });

  assert.equal(result.ok, false);
  assert.equal(calls, 0);
  if (result.ok) {
    return;
  }
  assert.equal(result.reasonCode, 'structured_output_invalid');
  assert.match(result.message, /only accepts probeId/u);
});

void test('runPtcFixedProbeStructuredOutputCaller rejects tool call mixes before runtime', async () => {
  let calls = 0;
  const runtime: PtcFixedEpochProbeRuntime = {
    async runFixedEpochProbe() {
      calls += 1;
      return { ok: true, value: SUCCESS_SUMMARY };
    },
  };

  const result = await runPtcFixedProbeStructuredOutputCaller({
    runContext: createRunContext(),
    runtime,
    structuredOutputs: [structuredPtcFixedProbeOutput()],
    functionCalls: [TEST_TOOL_CALL],
  });

  assert.equal(result.ok, false);
  assert.equal(calls, 0);
  if (result.ok) {
    return;
  }
  assert.equal(result.reasonCode, 'structured_output_with_tool_calls');
});

void test('runPtcFixedProbeStructuredOutputCaller sanitizes runtime failure diagnostics', async () => {
  const runtime: PtcFixedEpochProbeRuntime = {
    async runFixedEpochProbe() {
      return {
        ok: false,
        reasonCode: 'bridge_unavailable',
        message:
          'bridge failed at /tmp/project/.geulbat/ptc/fixed-probe-runtime/callback.sock',
        diagnostics: {
          bridgeReasonCode: 'session_unavailable',
          unsafePath:
            '/tmp/project/.geulbat/ptc/fixed-probe-runtime/callback.sock',
          exitCode: 125,
        },
      };
    },
  };

  const result = await runPtcFixedProbeStructuredOutputCaller({
    runContext: createRunContext(),
    runtime,
    structuredOutputs: [structuredPtcFixedProbeOutput()],
    functionCalls: [],
  });

  assert.equal(result.ok, false);
  if (result.ok) {
    return;
  }
  assert.equal(result.reasonCode, 'bridge_unavailable');
  assert.deepEqual(result.diagnostics, {
    underlyingReasonCode: 'bridge_unavailable',
    bridgeReasonCode: 'session_unavailable',
    exitCode: 125,
  });
  assert.doesNotMatch(JSON.stringify(result), /\.geulbat/u);
  assert.doesNotMatch(JSON.stringify(result), /callback\.sock/u);
});

void test('runPtcFixedProbeStructuredOutputCaller preserves cleanup-primary probe reason through sanitized diagnostics', async () => {
  const runtime: PtcFixedEpochProbeRuntime = {
    async runFixedEpochProbe() {
      return {
        ok: false,
        reasonCode: 'session_cleanup_failed',
        message:
          'cleanup failed at /tmp/project/.geulbat/ptc/fixed-probe-runtime',
        diagnostics: {
          underlyingReasonCode: 'probe_result_failed',
          cleanupReasonCode: 'container_remove_failed',
          probeErrorCode: 'callback_failed',
          unsafePath: '/tmp/project/.geulbat/ptc/fixed-probe-runtime',
        },
      };
    },
  };

  const result = await runPtcFixedProbeStructuredOutputCaller({
    runContext: createRunContext(),
    runtime,
    structuredOutputs: [structuredPtcFixedProbeOutput()],
    functionCalls: [],
  });

  assert.equal(result.ok, false);
  if (result.ok) {
    return;
  }
  assert.equal(result.reasonCode, 'session_cleanup_failed');
  assert.deepEqual(result.diagnostics, {
    underlyingReasonCode: 'session_cleanup_failed',
    probeUnderlyingReasonCode: 'probe_result_failed',
    cleanupReasonCode: 'container_remove_failed',
    probeErrorCode: 'callback_failed',
  });
  assert.doesNotMatch(JSON.stringify(result), /\.geulbat/u);
});
