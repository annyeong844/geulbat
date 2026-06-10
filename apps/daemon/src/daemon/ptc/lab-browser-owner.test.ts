import assert from 'node:assert/strict';
import test from 'node:test';
import {
  PTC_TEST_SESSION_DOCKER_CONTAINER_ID,
  withRealPtcSessionDockerManager,
  type PtcSessionDockerManagerFixture,
} from '../../test-support/ptc-session-docker.js';
import {
  createPtcLabBrowserDisabledPolicy,
  createPtcLabBrowserFixedPreflightPolicy,
  PTC_LAB_BROWSER_FIXED_PREFLIGHT_POLICY_ID,
  PTC_LAB_BROWSER_TELEMETRY_OWNER_OUTCOME_POLICY_ID,
} from './lab-browser-policy.js';
import { runPtcLabBrowserOwnerPreflight } from './lab-browser-owner.js';
import {
  PTC_LAB_BROWSER_OWNER_PREFLIGHT_SCRIPT,
  type PtcLabBrowserOwnerPreflightRequest,
} from './lab-browser-owner-contract.js';
import {
  admitPtcExecutionProfile,
  createPtcLabLocalDockerPolicyProjection,
  type PtcLabAdmittedProfile,
  type PtcLabPolicyProjection,
} from './lab-profile.js';
import {
  createPtcLabOpenEgressLocalPolicy,
  PTC_LAB_NETWORK_TELEMETRY_OPEN_POLICY_ID,
  PTC_LAB_OPEN_EGRESS_BOUNDARY_CLAIM,
  PTC_LAB_OPEN_EGRESS_LOCAL_POLICY_ID,
} from './lab-network-policy.js';
import { PTC_SESSION_DOCKER_DEFAULT_POLICY } from './session-docker-contract.js';
import type {
  PtcSessionDockerCommandInvocation,
  PtcSessionDockerCommandResult,
  PtcSessionDockerIdentity,
  PtcSessionDockerPolicy,
} from './session-docker-contract.js';

const PRIVATE_PATH = ['', 'home', 'geulbat-private', '.geulbat', 'secret'].join(
  '/',
);

const IDENTITY: PtcSessionDockerIdentity = Object.freeze({
  threadId: 'thread-browser-owner',
  workspaceRoot: '/workspace/project-a',
  trustContextId: 'trust-local-v1',
});

function browserLab(
  args: {
    browserMaxActionMs?: number;
    networkMode?: 'open' | 'disabled';
  } = {},
): {
  admission: PtcLabAdmittedProfile;
  labPolicy: PtcLabPolicyProjection;
  dockerPolicy: PtcSessionDockerPolicy;
} {
  const labPolicy: PtcLabPolicyProjection = {
    ...createPtcLabLocalDockerPolicyProjection(),
    policyId: 'ptc_lab_browser_owner_test_policy_v1',
    network:
      args.networkMode === 'disabled'
        ? createPtcLabLocalDockerPolicyProjection().network
        : createPtcLabOpenEgressLocalPolicy({
            metricsCoverage: 'owner_outcome_only',
          }),
    browser: createPtcLabBrowserFixedPreflightPolicy({
      maxActionMs: args.browserMaxActionMs ?? 5_000,
    }),
  };
  const admission = admitPtcExecutionProfile({
    requestedProfile: 'lab',
    labEnabled: true,
    reason: 'explicit_user_request',
    labPolicy,
  });
  if (!admission.ok) {
    throw new Error('expected browser lab admission');
  }

  return {
    admission: admission.value,
    labPolicy,
    dockerPolicy: {
      ...PTC_SESSION_DOCKER_DEFAULT_POLICY,
      labPolicyId: labPolicy.policyId,
      network: labPolicy.network,
      browser: labPolicy.browser,
    },
  };
}

function disabledBrowserAdmission(): PtcLabAdmittedProfile {
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

async function withBrowserSessionManager<T>(
  args: {
    policy?: PtcSessionDockerPolicy;
    createResult?: PtcSessionDockerCommandResult;
    browserResult?: PtcSessionDockerCommandResult;
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
          PTC_LAB_BROWSER_OWNER_PREFLIGHT_SCRIPT,
        ]);
        await args.onExec?.(invocation);
        return (
          args.browserResult ?? {
            kind: 'exit',
            exitCode: 0,
            stdout:
              '{"ok":true,"capability":"ptc_lab_browser_owner_preflight"}\n',
            stderr: '',
          }
        );
      },
    },
    fn,
  );
}

function request(
  overrides: Partial<PtcLabBrowserOwnerPreflightRequest> = {},
): PtcLabBrowserOwnerPreflightRequest {
  return { probeId: 'browser-probe-1', ...overrides };
}

void test('runPtcLabBrowserOwnerPreflight rejects disabled browser or network policy before session acquisition', async () => {
  const disabledNetwork = browserLab({ networkMode: 'disabled' });
  const cases = [
    {
      name: 'disabled browser',
      admission: disabledBrowserAdmission(),
    },
    {
      name: 'disabled network',
      admission: disabledNetwork.admission,
    },
  ];

  for (const item of cases) {
    await withBrowserSessionManager(
      {},
      async ({ manager, runner, invocations }) => {
        const result = await runPtcLabBrowserOwnerPreflight({
          admission: item.admission,
          identity: IDENTITY,
          sessionManager: manager,
          request: request(),
          commandRunner: runner,
        });

        assert.equal(result.ok, false, item.name);
        assert.equal(
          result.ok ? '' : result.reasonCode,
          'ptc_lab_browser_policy_disabled',
        );
        assert.deepEqual(invocations, []);
      },
    );
  }
});

void test('runPtcLabBrowserOwnerPreflight rejects URL-shaped requests before session acquisition', async () => {
  const { admission } = browserLab();
  const urlRequest = {
    probeId: 'browser-probe-1',
    url: 'https://example.com/private',
  };

  await withBrowserSessionManager(
    {},
    async ({ manager, runner, invocations }) => {
      const result = await runPtcLabBrowserOwnerPreflight({
        admission,
        identity: IDENTITY,
        sessionManager: manager,
        request: urlRequest,
        commandRunner: runner,
      });

      assert.equal(result.ok, false);
      assert.equal(
        result.ok ? '' : result.reasonCode,
        'ptc_lab_browser_request_invalid',
      );
      assert.deepEqual(invocations, []);
    },
  );
});

void test('runPtcLabBrowserOwnerPreflight runs a bounded fixed preflight through the real session manager', async () => {
  const { admission, dockerPolicy } = browserLab({ browserMaxActionMs: 1200 });

  await withBrowserSessionManager(
    { policy: dockerPolicy },
    async ({ manager, runner, invocations, runtimeRoot }) => {
      const result = await runPtcLabBrowserOwnerPreflight({
        admission,
        identity: IDENTITY,
        sessionManager: manager,
        request: request({ timeoutMs: 1000 }),
        now: (() => {
          let value = 200;
          return () => {
            value += 17;
            return value;
          };
        })(),
        commandRunner: runner,
      });

      assert.equal(result.ok, true);
      assert.equal(result.ok ? result.value.exitCode : -1, 0);
      assert.equal(result.ok ? result.value.durationMs : 0, 17);
      assert.equal(
        result.ok ? result.value.browserPolicyId : '',
        PTC_LAB_BROWSER_FIXED_PREFLIGHT_POLICY_ID,
      );
      assert.equal(
        result.ok ? result.value.browserTelemetryPolicyId : '',
        PTC_LAB_BROWSER_TELEMETRY_OWNER_OUTCOME_POLICY_ID,
      );
      assert.equal(
        result.ok ? result.value.browserOutputPolicy : '',
        'summary_only',
      );
      assert.equal(result.ok ? result.value.browserProfile : '', 'none');
      assert.equal(result.ok ? result.value.browserCookies : '', 'none');
      assert.equal(result.ok ? result.value.artifactExported : true, false);
      assert.deepEqual(result.ok ? result.value.networkTelemetry : undefined, {
        networkMode: 'open',
        networkPolicyId: PTC_LAB_OPEN_EGRESS_LOCAL_POLICY_ID,
        telemetryPolicyId: PTC_LAB_NETWORK_TELEMETRY_OPEN_POLICY_ID,
        boundaryClaim: PTC_LAB_OPEN_EGRESS_BOUNDARY_CLAIM,
        ownerKind: 'browser',
        outcome: 'completed',
        networkOpened: true,
        durationMs: 17,
        metricsCoverage: 'owner_outcome_only',
      });

      const createInvocation = invocations.find(
        (invocation) => invocation.args[0] === 'create',
      );
      assert.ok(createInvocation);
      assert.equal(
        createInvocation.args.includes(
          `geulbat.browserPolicyId=${PTC_LAB_BROWSER_FIXED_PREFLIGHT_POLICY_ID}`,
        ),
        true,
      );
      assert.equal(
        createInvocation.args.includes(
          'geulbat.browserOutputPolicy=summary_only',
        ),
        true,
      );
      const execInvocation = invocations.find(
        (invocation) => invocation.args[0] === 'exec',
      );
      assert.ok(execInvocation);
      assert.equal(execInvocation.timeoutMs, 1000);

      const serialized = JSON.stringify(result);
      assert.doesNotMatch(serialized, /https?:\/\/|example\.com/u);
      assert.doesNotMatch(
        serialized,
        /Bearer|oauth|cookie=|refresh[_-]?token/iu,
      );
      assert.equal(serialized.includes(runtimeRoot), false);
      assert.equal(
        Object.hasOwn(result.ok ? result.value : {}, 'artifactCandidate'),
        false,
      );
    },
  );
});

void test('runPtcLabBrowserOwnerPreflight rejects package-install-only sessions before browser exec', async () => {
  const { admission, dockerPolicy } = browserLab();
  const packageInstallOnlyPolicy: PtcSessionDockerPolicy = {
    ...dockerPolicy,
    packageManagerFamilies: ['npm'],
    networkInstallPolicyId: PTC_LAB_OPEN_EGRESS_LOCAL_POLICY_ID,
    browser: createPtcLabBrowserDisabledPolicy(),
  };

  await withBrowserSessionManager(
    { policy: packageInstallOnlyPolicy },
    async ({ manager, runner, invocations }) => {
      const result = await runPtcLabBrowserOwnerPreflight({
        admission,
        identity: IDENTITY,
        sessionManager: manager,
        request: request(),
        commandRunner: runner,
      });

      assert.equal(result.ok, false);
      assert.equal(
        result.ok ? '' : result.reasonCode,
        'ptc_lab_browser_policy_mismatch',
      );
      assert.equal(
        invocations.some((invocation) => invocation.args[0] === 'exec'),
        false,
      );
    },
  );
});

void test('runPtcLabBrowserOwnerPreflight taints timeout and cancellation through session close', async () => {
  const cases = [
    {
      kind: 'timeout' as const,
      reasonCode: 'ptc_lab_browser_timeout',
    },
    {
      kind: 'cancelled' as const,
      reasonCode: 'ptc_lab_browser_cancelled',
    },
  ];

  for (const item of cases) {
    const { admission, dockerPolicy } = browserLab();
    await withBrowserSessionManager(
      {
        policy: dockerPolicy,
        browserResult: { kind: item.kind, stdout: '', stderr: PRIVATE_PATH },
      },
      async ({ manager, runner, invocations }) => {
        const result = await runPtcLabBrowserOwnerPreflight({
          admission,
          identity: IDENTITY,
          sessionManager: manager,
          request: request(),
          commandRunner: runner,
        });

        assert.equal(result.ok, false);
        assert.equal(result.ok ? '' : result.reasonCode, item.reasonCode);
        assert.equal(
          invocations.some((invocation) => invocation.args[0] === 'rm'),
          true,
        );
        assert.doesNotMatch(
          JSON.stringify(result),
          /geulbat-private|\.geulbat|secret/u,
        );
      },
    );
  }
});

void test('runPtcLabBrowserOwnerPreflight rejects invalid stdout without leaking browser output', async () => {
  const { admission, dockerPolicy } = browserLab();

  for (const stdout of [
    `{"ok":true,"capability":"other","url":"https://example.com/"}\n`,
    JSON.stringify({
      ok: true,
      capability: 'ptc_lab_browser_owner_preflight',
      stdout: `browser log ${PRIVATE_PATH}`,
      browserConsole: 'console secret',
      cookie: 'session=secret',
    }),
  ]) {
    await withBrowserSessionManager(
      {
        policy: dockerPolicy,
        browserResult: {
          kind: 'exit',
          exitCode: 0,
          stdout,
          stderr: PRIVATE_PATH,
        },
      },
      async ({ manager, runner }) => {
        const result = await runPtcLabBrowserOwnerPreflight({
          admission,
          identity: IDENTITY,
          sessionManager: manager,
          request: request(),
          commandRunner: runner,
        });

        assert.equal(result.ok, false);
        assert.equal(
          result.ok ? '' : result.reasonCode,
          'ptc_lab_browser_output_invalid',
        );
        assert.doesNotMatch(
          JSON.stringify(result),
          /https?:\/\/|example\.com|browser log|console|cookie|geulbat-private|\.geulbat|secret/u,
        );
      },
    );
  }
});
