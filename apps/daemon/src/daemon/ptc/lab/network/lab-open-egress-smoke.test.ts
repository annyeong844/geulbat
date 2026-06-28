import assert from 'node:assert/strict';
import test from 'node:test';
import {
  PTC_TEST_SESSION_DOCKER_CONTAINER_ID,
  withRealPtcSessionDockerManager,
  type PtcSessionDockerManagerFixture,
} from '../../../../test-support/ptc-session-docker.js';
import {
  admitPtcExecutionProfile,
  createPtcLabLocalDockerPolicyProjection,
  type PtcLabAdmittedProfile,
  type PtcLabPolicyProjection,
} from '../profile/lab-profile.js';
import {
  createPtcLabOpenEgressLocalPolicy,
  PTC_LAB_DOCKER_BRIDGE_OPEN_NETWORK_NAME,
  PTC_LAB_OPEN_EGRESS_BOUNDARY_CLAIM,
  PTC_LAB_OPEN_EGRESS_LOCAL_POLICY_ID,
  PTC_LAB_NETWORK_TELEMETRY_OPEN_POLICY_ID,
} from './lab-network-policy.js';
import {
  PTC_LAB_OPEN_EGRESS_SMOKE_SCRIPT,
  runPtcLabOpenEgressSmoke,
} from './lab-open-egress-smoke.js';
import { PTC_SESSION_DOCKER_DEFAULT_POLICY } from '../session/session-docker-contract.js';
import type {
  PtcSessionDockerCommandInvocation,
  PtcSessionDockerCommandResult,
  PtcSessionDockerIdentity,
  PtcSessionDockerPolicy,
} from '../session/session-docker-contract.js';

const PRIVATE_PATH = ['', 'home', 'geulbat-private', '.geulbat', 'secret'].join(
  '/',
);

const IDENTITY: PtcSessionDockerIdentity = Object.freeze({
  threadId: 'thread-open-egress-smoke',
  workspaceRoot: '/workspace/project-a',
  trustContextId: 'trust-local-v1',
});

type PtcLabOpenEgressSmokeRequest = Parameters<
  typeof runPtcLabOpenEgressSmoke
>[0]['request'];

function openEgressLab(
  args: {
    metricsCoverage?: 'policy_only' | 'owner_outcome_only' | 'runtime_observed';
  } = {},
): {
  admission: PtcLabAdmittedProfile;
  labPolicy: PtcLabPolicyProjection;
  dockerPolicy: PtcSessionDockerPolicy;
} {
  const labPolicy: PtcLabPolicyProjection = {
    ...createPtcLabLocalDockerPolicyProjection(),
    policyId: 'ptc_lab_open_egress_smoke_test_policy_v1',
    network: createPtcLabOpenEgressLocalPolicy({
      metricsCoverage: args.metricsCoverage ?? 'owner_outcome_only',
    }),
  };
  const admission = admitPtcExecutionProfile({
    requestedProfile: 'lab',
    labEnabled: true,
    reason: 'explicit_user_request',
    labPolicy,
  });
  if (!admission.ok) {
    throw new Error('expected open egress lab admission');
  }

  return {
    admission: admission.value,
    labPolicy,
    dockerPolicy: {
      ...PTC_SESSION_DOCKER_DEFAULT_POLICY,
      labPolicyId: labPolicy.policyId,
      network: labPolicy.network,
    },
  };
}

function disabledLab(): PtcLabAdmittedProfile {
  const admission = admitPtcExecutionProfile({
    requestedProfile: 'lab',
    labEnabled: true,
    reason: 'explicit_user_request',
  });
  if (!admission.ok) {
    throw new Error('expected disabled lab admission');
  }
  return admission.value;
}

async function withRealSessionManager<T>(
  args: {
    policy?: PtcSessionDockerPolicy;
    createResult?: PtcSessionDockerCommandResult;
    smokeResult?: PtcSessionDockerCommandResult;
    onExec?: (
      invocation: PtcSessionDockerCommandInvocation,
    ) => void | Promise<void>;
  },
  fn: (fixture: PtcSessionDockerManagerFixture) => Promise<T>,
): Promise<T> {
  return await withRealPtcSessionDockerManager(
    {
      identity: IDENTITY,
      ...(args.policy === undefined ? {} : { policy: args.policy }),
      ...(args.createResult === undefined
        ? {}
        : { createResult: args.createResult }),
      commandResult: async (invocation) => {
        if (invocation.args[0] !== 'exec') {
          return undefined;
        }
        assert.deepEqual(invocation.args, [
          'exec',
          PTC_TEST_SESSION_DOCKER_CONTAINER_ID,
          'node',
          '-e',
          PTC_LAB_OPEN_EGRESS_SMOKE_SCRIPT,
        ]);
        await args.onExec?.(invocation);
        return (
          args.smokeResult ?? {
            kind: 'exit',
            exitCode: 0,
            stdout: '{"ok":true,"statusClass":2}\n',
            stderr: '',
          }
        );
      },
    },
    fn,
  );
}

function request(
  overrides: Partial<PtcLabOpenEgressSmokeRequest> = {},
): PtcLabOpenEgressSmokeRequest {
  return { smokeId: 'smoke-1', ...overrides };
}

void test('runPtcLabOpenEgressSmoke rejects disabled policy before session acquisition', async () => {
  await withRealSessionManager({}, async ({ manager, runner, invocations }) => {
    const result = await runPtcLabOpenEgressSmoke({
      admission: disabledLab(),
      identity: IDENTITY,
      sessionManager: manager,
      request: request(),
      commandRunner: runner,
    });

    assert.equal(result.ok, false);
    assert.equal(
      result.ok ? '' : result.reasonCode,
      'ptc_lab_open_egress_policy_disabled',
    );
    assert.deepEqual(invocations, []);
  });
});

void test('runPtcLabOpenEgressSmoke runs fixed smoke command through the real session manager', async () => {
  const { admission, dockerPolicy } = openEgressLab();

  await withRealSessionManager(
    { policy: dockerPolicy },
    async ({ manager, runner, invocations, runtimeRoot }) => {
      const result = await runPtcLabOpenEgressSmoke({
        admission,
        identity: IDENTITY,
        sessionManager: manager,
        request: request({ timeoutMs: 1200 }),
        now: (() => {
          let value = 100;
          return () => {
            value += 13;
            return value;
          };
        })(),
        commandRunner: runner,
      });

      assert.equal(result.ok, true);
      assert.equal(result.ok ? result.value.exitCode : -1, 0);
      assert.equal(result.ok ? result.value.durationMs : 0, 13);
      assert.equal(
        result.ok ? result.value.networkTelemetry.ownerKind : '',
        'network_smoke',
      );
      assert.deepEqual(result.ok ? result.value.networkTelemetry : undefined, {
        networkMode: 'open',
        networkPolicyId: PTC_LAB_OPEN_EGRESS_LOCAL_POLICY_ID,
        telemetryPolicyId: PTC_LAB_NETWORK_TELEMETRY_OPEN_POLICY_ID,
        boundaryClaim: PTC_LAB_OPEN_EGRESS_BOUNDARY_CLAIM,
        ownerKind: 'network_smoke',
        outcome: 'completed',
        networkOpened: true,
        durationMs: 13,
        metricsCoverage: 'owner_outcome_only',
      });
      assert.match(
        result.ok ? result.value.labSessionId : '',
        /^ptc-lab-[a-f0-9]{32}$/u,
      );

      assert.deepEqual(
        invocations.map((invocation) => invocation.args[0]),
        ['--version', 'image', 'create', 'start', 'inspect', 'exec'],
      );
      const createInvocation = invocations.find(
        (invocation) => invocation.args[0] === 'create',
      );
      assert.ok(createInvocation);
      assert.equal(
        createInvocation.args[createInvocation.args.indexOf('--network') + 1],
        PTC_LAB_DOCKER_BRIDGE_OPEN_NETWORK_NAME,
      );

      const execInvocation = invocations.find(
        (invocation) => invocation.args[0] === 'exec',
      );
      assert.ok(execInvocation);
      assert.equal(execInvocation.executable, 'docker');
      assert.equal(execInvocation.timeoutMs, 1200);
      assert.deepEqual(execInvocation.args, [
        'exec',
        PTC_TEST_SESSION_DOCKER_CONTAINER_ID,
        'node',
        '-e',
        PTC_LAB_OPEN_EGRESS_SMOKE_SCRIPT,
      ]);

      const serialized = JSON.stringify(result);
      assert.doesNotMatch(serialized, /https?:\/\//u);
      assert.doesNotMatch(
        serialized,
        /Bearer|oauth|cookie|refresh[_-]?token/iu,
      );
      assert.equal(serialized.includes(runtimeRoot), false);
    },
  );
});

void test('runPtcLabOpenEgressSmoke keeps non-zero probe exit as failed telemetry summary', async () => {
  const { admission, dockerPolicy } = openEgressLab();

  await withRealSessionManager(
    {
      policy: dockerPolicy,
      smokeResult: {
        kind: 'exit',
        exitCode: 2,
        stdout: '{"ok":false,"errorCode":"egress_request_failed"}\n',
        stderr: PRIVATE_PATH,
      },
    },
    async ({ manager, runner }) => {
      const result = await runPtcLabOpenEgressSmoke({
        admission,
        identity: IDENTITY,
        sessionManager: manager,
        request: request(),
        commandRunner: runner,
      });

      assert.equal(result.ok, true);
      assert.equal(result.ok ? result.value.exitCode : -1, 2);
      assert.equal(
        result.ok ? result.value.networkTelemetry.outcome : '',
        'failed',
      );
      assert.doesNotMatch(
        JSON.stringify(result),
        /geulbat-private|\.geulbat|secret/u,
      );
    },
  );
});

void test('runPtcLabOpenEgressSmoke maps session acquisition failure without leaking diagnostics', async () => {
  const { admission, dockerPolicy } = openEgressLab();

  await withRealSessionManager(
    {
      policy: dockerPolicy,
      createResult: {
        kind: 'exit',
        exitCode: 1,
        stdout: '',
        stderr: `Error response from daemon: network ${PTC_LAB_DOCKER_BRIDGE_OPEN_NETWORK_NAME} not found at ${PRIVATE_PATH}`,
      },
    },
    async ({ manager, runner, invocations }) => {
      const result = await runPtcLabOpenEgressSmoke({
        admission,
        identity: IDENTITY,
        sessionManager: manager,
        request: request(),
        commandRunner: runner,
      });

      assert.equal(result.ok, false);
      assert.equal(
        result.ok ? '' : result.reasonCode,
        'ptc_lab_open_egress_session_unavailable',
      );
      assert.deepEqual(result.ok ? undefined : result.diagnostics, {
        sessionReasonCode: 'network_backend_unavailable',
      });
      assert.equal(
        invocations.some((invocation) => invocation.args[0] === 'exec'),
        false,
      );
      assert.doesNotMatch(
        JSON.stringify(result),
        /geulbat-private|\.geulbat|secret/u,
      );
    },
  );
});

void test('runPtcLabOpenEgressSmoke rejects session reuse key that does not match open policy', async () => {
  const { admission } = openEgressLab();

  await withRealSessionManager(
    { policy: PTC_SESSION_DOCKER_DEFAULT_POLICY },
    async ({ manager, runner, invocations }) => {
      const result = await runPtcLabOpenEgressSmoke({
        admission,
        identity: IDENTITY,
        sessionManager: manager,
        request: request(),
        commandRunner: runner,
      });

      assert.equal(result.ok, false);
      assert.equal(
        result.ok ? '' : result.reasonCode,
        'ptc_lab_open_egress_policy_mismatch',
      );
      assert.deepEqual(
        invocations.map((invocation) => invocation.args[0]),
        ['--version', 'image', 'create', 'start', 'inspect'],
      );
    },
  );
});

void test('runPtcLabOpenEgressSmoke closes tainted session on timeout without caller aborted signal', async () => {
  const { admission, dockerPolicy } = openEgressLab();
  const controller = new AbortController();

  await withRealSessionManager(
    {
      policy: dockerPolicy,
      onExec: () => {
        controller.abort();
      },
      smokeResult: {
        kind: 'timeout',
        stdout: '',
        stderr: PRIVATE_PATH,
      },
    },
    async ({ manager, runner, invocations }) => {
      const result = await runPtcLabOpenEgressSmoke({
        admission,
        identity: IDENTITY,
        sessionManager: manager,
        request: request(),
        signal: controller.signal,
        commandRunner: runner,
      });

      assert.equal(result.ok, false);
      assert.equal(
        result.ok ? '' : result.reasonCode,
        'ptc_lab_open_egress_timeout',
      );
      const removeInvocation = invocations.find(
        (invocation) => invocation.args[0] === 'rm',
      );
      assert.ok(removeInvocation);
      assert.equal(removeInvocation.signal, undefined);
      assert.doesNotMatch(
        JSON.stringify(result),
        /geulbat-private|\.geulbat|secret/u,
      );
    },
  );
});

void test('runPtcLabOpenEgressSmoke skips taint close when timeout reports process termination', async () => {
  const { admission, dockerPolicy } = openEgressLab();

  await withRealSessionManager(
    {
      policy: dockerPolicy,
      smokeResult: {
        kind: 'timeout',
        stdout: '',
        stderr: PRIVATE_PATH,
        processTerminated: true,
      },
    },
    async ({ manager, runner, invocations }) => {
      const result = await runPtcLabOpenEgressSmoke({
        admission,
        identity: IDENTITY,
        sessionManager: manager,
        request: request(),
        commandRunner: runner,
      });

      assert.equal(result.ok, false);
      assert.equal(
        result.ok ? '' : result.reasonCode,
        'ptc_lab_open_egress_timeout',
      );
      assert.equal(
        invocations.some((invocation) => invocation.args[0] === 'rm'),
        false,
      );
    },
  );
});

void test('runPtcLabOpenEgressSmoke closes tainted session on command crash', async () => {
  const { admission, dockerPolicy } = openEgressLab();

  await withRealSessionManager(
    {
      policy: dockerPolicy,
      smokeResult: {
        kind: 'crash',
        stdout: '',
        stderr: PRIVATE_PATH,
      },
    },
    async ({ manager, runner, invocations }) => {
      const result = await runPtcLabOpenEgressSmoke({
        admission,
        identity: IDENTITY,
        sessionManager: manager,
        request: request(),
        commandRunner: runner,
      });

      assert.equal(result.ok, false);
      assert.equal(
        result.ok ? '' : result.reasonCode,
        'ptc_lab_open_egress_execution_failed',
      );
      assert.ok(invocations.some((invocation) => invocation.args[0] === 'rm'));
      assert.doesNotMatch(
        JSON.stringify(result),
        /geulbat-private|\.geulbat|secret/u,
      );
    },
  );
});

void test('runPtcLabOpenEgressSmoke rejects invalid request before session acquisition', async () => {
  await withRealSessionManager({}, async ({ manager, runner, invocations }) => {
    for (const badRequest of [
      request({ smokeId: '../escape' }),
      request({ smokeId: '' }),
      request({ timeoutMs: 0 }),
      request({ timeoutMs: 15_001 }),
    ]) {
      const result = await runPtcLabOpenEgressSmoke({
        admission: openEgressLab().admission,
        identity: IDENTITY,
        sessionManager: manager,
        request: badRequest,
        commandRunner: runner,
      });
      assert.equal(result.ok, false, JSON.stringify(badRequest));
      assert.equal(
        result.ok ? '' : result.reasonCode,
        'ptc_lab_open_egress_request_invalid',
      );
    }
    assert.deepEqual(invocations, []);
  });
});

void test('runPtcLabOpenEgressSmoke rejects malformed fixed output', async () => {
  const { admission, dockerPolicy } = openEgressLab();

  await withRealSessionManager(
    {
      policy: dockerPolicy,
      smokeResult: {
        kind: 'exit',
        exitCode: 0,
        stdout: '{"missingOk":true}\n',
        stderr: '',
      },
    },
    async ({ manager, runner }) => {
      const malformed = await runPtcLabOpenEgressSmoke({
        admission,
        identity: IDENTITY,
        sessionManager: manager,
        request: request(),
        commandRunner: runner,
      });
      assert.equal(malformed.ok, false);
      assert.equal(
        malformed.ok ? '' : malformed.reasonCode,
        'ptc_lab_open_egress_output_invalid',
      );
    },
  );
});
