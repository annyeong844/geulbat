import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createPtcLabBrowserDisabledPolicy,
  createPtcLabBrowserFixedPreflightPolicy,
} from './lab-browser-policy.js';
import { runPtcLabBrowserFixedRuntimeProbe } from './lab-browser-runtime.js';
import { PTC_LAB_BROWSER_FIXED_RUNTIME_PROBE_CAPABILITY } from './lab-browser-runtime-contract.js';
import { PTC_LAB_OPEN_EGRESS_LOCAL_POLICY_ID } from './lab-network-policy.js';
import type { PtcSessionDockerPolicy } from './session-docker-contract.js';
import {
  browserRuntimeRequest,
  browserRuntimeStdout,
  createBrowserRuntimeLab,
  PTC_BROWSER_RUNTIME_TEST_IDENTITY,
  PTC_BROWSER_RUNTIME_TEST_PRIVATE_PATH,
  PTC_BROWSER_RUNTIME_TEST_SUCCESS_CHECKS,
  withBrowserRuntimeSessionManager,
} from '../../test-support/ptc-browser-runtime.js';

void test('runPtcLabBrowserFixedRuntimeProbe rejects fixed-preflight-only sessions before browser exec', async () => {
  const { admission, dockerPolicy } = createBrowserRuntimeLab();
  const preflightOnlyPolicy: PtcSessionDockerPolicy = {
    ...dockerPolicy,
    browser: createPtcLabBrowserFixedPreflightPolicy({ maxActionMs: 5000 }),
  };

  await withBrowserRuntimeSessionManager(
    { policy: preflightOnlyPolicy },
    async ({ manager, runner, invocations }) => {
      const result = await runPtcLabBrowserFixedRuntimeProbe({
        admission,
        identity: PTC_BROWSER_RUNTIME_TEST_IDENTITY,
        sessionManager: manager,
        request: browserRuntimeRequest(),
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

void test('runPtcLabBrowserFixedRuntimeProbe keeps runtime unavailable distinct from execution failure', async () => {
  const { admission, dockerPolicy } = createBrowserRuntimeLab();

  await withBrowserRuntimeSessionManager(
    {
      policy: dockerPolicy,
      runtimeResult: {
        kind: 'exit',
        exitCode: 3,
        stdout: browserRuntimeStdout({
          ok: false,
          errorCode: 'browser_runtime_unavailable',
          checks: {
            engineAvailable: false,
            contextCreated: false,
            controlledDocumentReady: false,
            cleanupCompleted: true,
          },
        }),
        stderr: PTC_BROWSER_RUNTIME_TEST_PRIVATE_PATH,
      },
    },
    async ({ manager, runner, invocations }) => {
      const result = await runPtcLabBrowserFixedRuntimeProbe({
        admission,
        identity: PTC_BROWSER_RUNTIME_TEST_IDENTITY,
        sessionManager: manager,
        request: browserRuntimeRequest(),
        commandRunner: runner,
      });

      assert.equal(result.ok, false);
      assert.equal(
        result.ok ? '' : result.reasonCode,
        'ptc_lab_browser_runtime_unavailable',
      );
      assert.equal(
        invocations.some((invocation) => invocation.args[0] === 'rm'),
        false,
      );
      assert.doesNotMatch(
        JSON.stringify(result),
        /geulbat-private|\.geulbat|secret/u,
      );
    },
  );

  await withBrowserRuntimeSessionManager(
    {
      policy: dockerPolicy,
      runtimeResult: {
        kind: 'exit',
        exitCode: 2,
        stdout: browserRuntimeStdout({
          ok: false,
          errorCode: 'execution_failed',
          checks: {
            engineAvailable: true,
            contextCreated: true,
            controlledDocumentReady: false,
            cleanupCompleted: true,
          },
        }),
        stderr: PTC_BROWSER_RUNTIME_TEST_PRIVATE_PATH,
      },
    },
    async ({ manager, runner, invocations }) => {
      const result = await runPtcLabBrowserFixedRuntimeProbe({
        admission,
        identity: PTC_BROWSER_RUNTIME_TEST_IDENTITY,
        sessionManager: manager,
        request: browserRuntimeRequest(),
        commandRunner: runner,
      });

      assert.equal(result.ok, false);
      assert.equal(
        result.ok ? '' : result.reasonCode,
        'ptc_lab_browser_execution_failed',
      );
      assert.equal(
        invocations.some((invocation) => invocation.args[0] === 'rm'),
        false,
      );
      assert.doesNotMatch(
        JSON.stringify(result),
        /geulbat-private|\.geulbat|secret/u,
      );
    },
  );
});

void test('runPtcLabBrowserFixedRuntimeProbe taints timeout and cancellation through session close', async () => {
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
    const { admission, dockerPolicy } = createBrowserRuntimeLab();
    await withBrowserRuntimeSessionManager(
      {
        policy: dockerPolicy,
        runtimeResult: {
          kind: item.kind,
          stdout: '',
          stderr: PTC_BROWSER_RUNTIME_TEST_PRIVATE_PATH,
        },
      },
      async ({ manager, runner, invocations }) => {
        const result = await runPtcLabBrowserFixedRuntimeProbe({
          admission,
          identity: PTC_BROWSER_RUNTIME_TEST_IDENTITY,
          sessionManager: manager,
          request: browserRuntimeRequest(),
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

void test('runPtcLabBrowserFixedRuntimeProbe rejects raw browser output leaks', async () => {
  const { admission, dockerPolicy } = createBrowserRuntimeLab();

  await withBrowserRuntimeSessionManager(
    {
      policy: dockerPolicy,
      runtimeResult: {
        kind: 'exit',
        exitCode: 0,
        stdout: `${JSON.stringify({
          ok: true,
          capability: PTC_LAB_BROWSER_FIXED_RUNTIME_PROBE_CAPABILITY,
          checks: PTC_BROWSER_RUNTIME_TEST_SUCCESS_CHECKS,
          html: '<html><body>secret</body></html>',
          screenshot: 'capture.png',
          browserConsole: `console ${PTC_BROWSER_RUNTIME_TEST_PRIVATE_PATH}`,
          cookie: 'session=secret',
        })}\n`,
        stderr: PTC_BROWSER_RUNTIME_TEST_PRIVATE_PATH,
      },
    },
    async ({ manager, runner }) => {
      const result = await runPtcLabBrowserFixedRuntimeProbe({
        admission,
        identity: PTC_BROWSER_RUNTIME_TEST_IDENTITY,
        sessionManager: manager,
        request: browserRuntimeRequest(),
        commandRunner: runner,
      });

      assert.equal(result.ok, false);
      assert.equal(
        result.ok ? '' : result.reasonCode,
        'ptc_lab_browser_output_invalid',
      );
      assert.doesNotMatch(
        JSON.stringify(result),
        /<html|capture\.png|console|cookie|geulbat-private|\.geulbat|secret/u,
      );
    },
  );
});

void test('runPtcLabBrowserFixedRuntimeProbe rejects non-boolean adapter checks before returning summary', async () => {
  const { admission, dockerPolicy } = createBrowserRuntimeLab();

  await withBrowserRuntimeSessionManager(
    {
      policy: dockerPolicy,
      runtimeResult: {
        kind: 'exit',
        exitCode: 0,
        stdout: `${JSON.stringify({
          ok: true,
          capability: PTC_LAB_BROWSER_FIXED_RUNTIME_PROBE_CAPABILITY,
          checks: {
            engineAvailable: 1,
            contextCreated: 1,
            controlledDocumentReady: 1,
            cleanupCompleted: 1,
          },
        })}\n`,
        stderr: PTC_BROWSER_RUNTIME_TEST_PRIVATE_PATH,
      },
    },
    async ({ manager, runner }) => {
      const result = await runPtcLabBrowserFixedRuntimeProbe({
        admission,
        identity: PTC_BROWSER_RUNTIME_TEST_IDENTITY,
        sessionManager: manager,
        request: browserRuntimeRequest(),
        commandRunner: runner,
      });

      assert.equal(result.ok, false);
      assert.equal(
        result.ok ? '' : result.reasonCode,
        'ptc_lab_browser_output_invalid',
      );
      assert.doesNotMatch(
        JSON.stringify(result),
        /geulbat-private|\.geulbat|secret/u,
      );
    },
  );
});

void test('runPtcLabBrowserFixedRuntimeProbe rejects package-install-only sessions before execution', async () => {
  const { admission, dockerPolicy } = createBrowserRuntimeLab();
  const packageInstallOnlyPolicy: PtcSessionDockerPolicy = {
    ...dockerPolicy,
    packageManagerFamilies: ['npm'],
    networkInstallPolicyId: PTC_LAB_OPEN_EGRESS_LOCAL_POLICY_ID,
    browser: createPtcLabBrowserDisabledPolicy(),
  };

  await withBrowserRuntimeSessionManager(
    { policy: packageInstallOnlyPolicy },
    async ({ manager, runner, invocations }) => {
      const result = await runPtcLabBrowserFixedRuntimeProbe({
        admission,
        identity: PTC_BROWSER_RUNTIME_TEST_IDENTITY,
        sessionManager: manager,
        request: browserRuntimeRequest(),
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
