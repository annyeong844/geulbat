import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isPtcRecord } from '../../shared/record-shape.js';
import { makeRunContext } from '../../../../test-support/run-context.js';
import {
  createPtcSessionDockerCommandFixture,
  readPtcSessionDockerBindMountHostPath,
} from '../../../../test-support/ptc-session-docker.js';
import {
  collectPtcStaticImportGraph,
  ptcSourceUrl,
  readPtcStaticImportEdges,
  readPtcStaticImportSpecifiers,
} from '../../../../test-support/ptc-static-import-graph.js';
import { testThreadId } from '../../../../test-support/thread-id.js';
import { PTC_SESSION_DOCKER_CALLBACK_CONTAINER_ROOT } from '../../lab/session/session-docker-contract.js';
import type {
  PtcSessionDockerCommandInvocation,
  PtcSessionDockerCommandResult,
  PtcSessionDockerManager,
} from '../../lab/session/session-docker-contract.js';
import { createPtcFixedEpochProbeRuntime } from './fixed-probe-runtime.js';
import {
  PTC_FIXED_EPOCH_EXECUTION_PROBE_CAPABILITY_ID,
  PTC_FIXED_EPOCH_EXECUTION_PROBE_POLICY_ID,
  type PtcFixedEpochExecutionProbeSummary,
} from './fixed-probe-runtime-contract.js';

const TEST_CALLBACK_TRANSPORT_POLICY = Object.freeze({
  maxFrameBytes: 8192,
  maxOpenConnections: 4,
  maxCallbacks: 20,
  callbackTimeoutMs: 30_000,
  maxResponseBytes: 8192,
});

void test('fixed probe runtime contract owns fixed probe shapes without implementation imports', async () => {
  const sourceUrl = ptcSourceUrl(
    'runtime/probes/fixed-probe-runtime-contract.ts',
  );
  const graph = await collectPtcStaticImportGraph(sourceUrl);

  assert.deepEqual(readPtcStaticImportSpecifiers(graph, sourceUrl), []);
});

void test('daemon runtime contract references the fixed probe contract type-only', async () => {
  const sourceUrl = new URL(
    '../../../../../src/daemon/daemon-runtime-contract.ts',
    import.meta.url,
  );
  const edges = await readPtcStaticImportEdges(sourceUrl);
  assert.equal(
    edges.some(
      (edge) =>
        edge.typeOnly &&
        edge.specifier ===
          './ptc/runtime/probes/fixed-probe-runtime-contract.js',
    ),
    true,
  );
});

void test('createPtcFixedEpochProbeRuntime runs fixed probe through a PTC session and cleans up', async () => {
  const stateRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-ptc-fixed-probe-workspace-'),
  );
  const runtimeRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-ptc-fixed-probe-runtime-'),
  );
  let callbackRootHostPath: string | undefined;
  const fixture = createPtcSessionDockerCommandFixture({
    containerId: 'container-agent-ptc-fixed-probe-runtime',
    commandResult: async (invocation) => {
      if (invocation.args[0] === 'create') {
        callbackRootHostPath = readPtcSessionDockerBindMountHostPath(
          invocation,
          PTC_SESSION_DOCKER_CALLBACK_CONTAINER_ROOT,
        );
        return undefined;
      }
      if (invocation.args[0] === 'exec') {
        return await executeFixedProbe(invocation, callbackRootHostPath);
      }
      return undefined;
    },
  });
  const runtime = createPtcFixedEpochProbeRuntime({
    callbackTransportPolicy: TEST_CALLBACK_TRANSPORT_POLICY,
    commandRunner: fixture.runner,
    runtimeRootForState: () => runtimeRoot,
  });

  try {
    const result = await runtime.runFixedEpochProbe({
      runContext: makeRunContext({
        threadId: testThreadId(801),
        stateRoot,
      }),
    });

    assert.equal(result.ok, true);
    if (!result.ok) {
      return;
    }
    assert.equal(
      result.value.containerId,
      'container-agent-ptc-fixed-probe-runtime',
    );
    assert.equal(result.value.callbackRoundTrip, 'observed');
    assert.deepEqual(
      fixture.invocations
        .filter((invocation) => invocation.args[0] === 'rm')
        .map((invocation) => invocation.args),
      [['rm', '-f', 'container-agent-ptc-fixed-probe-runtime']],
    );
  } finally {
    await rm(stateRoot, { recursive: true, force: true });
    await rm(runtimeRoot, { recursive: true, force: true });
  }
});

void test('createPtcFixedEpochProbeRuntime returns cleanup failure as primary after a probe failure', async () => {
  const runtime = createPtcFixedEpochProbeRuntime({
    createSessionManager: createCleanupFailureSessionManager,
    runtimeRootForState: () => '/tmp/geulbat-ptc-fixed-probe-runtime',
    runProbe: async () => ({
      ok: false,
      reasonCode: 'probe_result_failed',
      message:
        'PTC fixed epoch execution probe reported a failed callback result',
      diagnostics: { probeErrorCode: 'callback_failed' },
    }),
  });

  const result = await runtime.runFixedEpochProbe({
    runContext: makeRunContext({
      threadId: testThreadId(802),
      stateRoot: '/tmp/geulbat-ptc-fixed-probe-workspace',
    }),
  });

  assert.equal(result.ok, false);
  if (result.ok) {
    return;
  }
  assert.equal(result.reasonCode, 'session_cleanup_failed');
  assert.deepEqual(result.diagnostics, {
    underlyingReasonCode: 'probe_result_failed',
    probeErrorCode: 'callback_failed',
    cleanupReasonCode: 'container_remove_failed',
  });
});

void test('createPtcFixedEpochProbeRuntime returns cleanup failure as primary after a successful probe', async () => {
  const runtime = createPtcFixedEpochProbeRuntime({
    createSessionManager: createCleanupFailureSessionManager,
    runtimeRootForState: () => '/tmp/geulbat-ptc-fixed-probe-runtime',
    runProbe: async () => ({
      ok: true,
      value: FIXED_PROBE_SUMMARY,
    }),
  });

  const result = await runtime.runFixedEpochProbe({
    runContext: makeRunContext({
      threadId: testThreadId(803),
      stateRoot: '/tmp/geulbat-ptc-fixed-probe-workspace',
    }),
  });

  assert.equal(result.ok, false);
  if (result.ok) {
    return;
  }
  assert.equal(result.reasonCode, 'session_cleanup_failed');
  assert.deepEqual(result.diagnostics, {
    cleanupReasonCode: 'container_remove_failed',
  });
});

async function executeFixedProbe(
  invocation: PtcSessionDockerCommandInvocation,
  callbackRootHostPath: string | undefined,
): Promise<PtcSessionDockerCommandResult> {
  assert.equal(invocation.args[1], 'container-agent-ptc-fixed-probe-runtime');
  assert.equal(invocation.args[2], 'node');
  assert.equal(invocation.args[3], '-e');
  if (callbackRootHostPath === undefined) {
    throw new Error('missing callback root host path');
  }
  const inputContainerPath = invocation.args[5];
  if (typeof inputContainerPath !== 'string') {
    throw new Error('missing fixed probe input container path');
  }
  assert.ok(inputContainerPath.endsWith('/fixed-probe-input.json'));
  assert.ok(
    inputContainerPath.startsWith(
      `${PTC_SESSION_DOCKER_CALLBACK_CONTAINER_ROOT}/`,
    ),
  );
  const hostInputPath = join(
    callbackRootHostPath,
    inputContainerPath.slice(
      PTC_SESSION_DOCKER_CALLBACK_CONTAINER_ROOT.length + 1,
    ),
  );
  const input = JSON.parse(await readFile(hostInputPath, 'utf8')) as unknown;
  assert.equal(isPtcRecord(input) && input.requestId, 'ptc-fixed-probe-1');
  assert.equal(isPtcRecord(input) && typeof input.socketPath, 'string');
  assert.equal(isPtcRecord(input) && typeof input.token, 'string');
  return {
    kind: 'exit',
    exitCode: 0,
    stdout: '{"ok":true,"callbackResultKind":"inline"}\n',
    stderr: '',
  };
}

const FIXED_PROBE_SUMMARY: PtcFixedEpochExecutionProbeSummary = Object.freeze({
  ok: true,
  capabilityId: PTC_FIXED_EPOCH_EXECUTION_PROBE_CAPABILITY_ID,
  policyId: PTC_FIXED_EPOCH_EXECUTION_PROBE_POLICY_ID,
  executionClass: 'fixed_docker_exec_probe',
  executionSurface: 'baked_image_node_eval',
  containerId: 'container-fixed-probe-cleanup-test',
  epochId: 'ptc-fixed-probe-cleanup-test-epoch',
  callbackRoundTrip: 'observed',
  callbackResultKind: 'inline',
  exitCode: 0,
});

function createCleanupFailureSessionManager(): PtcSessionDockerManager {
  return {
    async getOrCreate() {
      return {
        ok: false,
        reasonCode: 'container_create_failed',
        message: 'not used by injected fixed probe test',
      };
    },
    async close() {
      return { ok: true, value: undefined };
    },
    async closeAll() {
      return {
        ok: false,
        reasonCode: 'container_remove_failed',
        message: 'PTC fixed probe test cleanup failed',
      };
    },
  };
}
