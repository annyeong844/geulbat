import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createPtcLabBrowserDisabledPolicy,
  createPtcLabBrowserFixedPreflightPolicy,
  createPtcLabBrowserFixedRuntimeProbePolicy,
} from './lab-browser-policy.js';
import { runPtcLabBrowserFixedNavigationProbe } from './lab-browser-navigation.js';
import {
  PTC_LAB_BROWSER_FIXED_NAVIGATION_PROBE_CAPABILITY,
  PTC_LAB_BROWSER_FIXED_NAVIGATION_TARGET,
} from './lab-browser-navigation-contract.js';
import { PTC_LAB_OPEN_EGRESS_LOCAL_POLICY_ID } from './lab-network-policy.js';
import type { PtcSessionDockerPolicy } from './session-docker-contract.js';
import {
  browserNavigationRequest,
  browserNavigationStdout,
  createBrowserNavigationLab,
  PTC_BROWSER_NAVIGATION_TEST_IDENTITY,
  PTC_BROWSER_NAVIGATION_TEST_PRIVATE_PATH,
  PTC_BROWSER_NAVIGATION_TEST_SUCCESS_CHECKS,
  withBrowserNavigationSessionManager,
} from '../../test-support/ptc-browser-navigation.js';

void test('runPtcLabBrowserFixedNavigationProbe rejects preflight, runtime, and package-only sessions before browser exec', async () => {
  const { admission, dockerPolicy } = createBrowserNavigationLab();
  const policies: PtcSessionDockerPolicy[] = [
    {
      ...dockerPolicy,
      browser: createPtcLabBrowserFixedPreflightPolicy({ maxActionMs: 5000 }),
    },
    {
      ...dockerPolicy,
      browser: createPtcLabBrowserFixedRuntimeProbePolicy({
        maxActionMs: 5000,
      }),
    },
    {
      ...dockerPolicy,
      packageManagerFamilies: ['npm'],
      networkInstallPolicyId: PTC_LAB_OPEN_EGRESS_LOCAL_POLICY_ID,
      browser: createPtcLabBrowserDisabledPolicy(),
    },
  ];

  for (const policy of policies) {
    await withBrowserNavigationSessionManager(
      { policy },
      async ({ manager, runner, invocations }) => {
        const result = await runPtcLabBrowserFixedNavigationProbe({
          admission,
          identity: PTC_BROWSER_NAVIGATION_TEST_IDENTITY,
          sessionManager: manager,
          request: browserNavigationRequest(),
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
  }
});

void test('runPtcLabBrowserFixedNavigationProbe keeps runtime, target, and navigation failures distinct without URL leaks', async () => {
  const { admission, dockerPolicy } = createBrowserNavigationLab();
  const cases = [
    {
      errorCode: 'browser_runtime_unavailable' as const,
      reasonCode: 'ptc_lab_browser_runtime_unavailable',
      checks: {
        engineAvailable: false,
        contextCreated: false,
        navigationCommitted: false,
        loadStateReached: false,
        cleanupCompleted: true,
      },
    },
    {
      errorCode: 'target_unavailable' as const,
      reasonCode: 'ptc_lab_browser_target_unavailable',
      checks: {
        engineAvailable: true,
        contextCreated: true,
        navigationCommitted: false,
        loadStateReached: false,
        cleanupCompleted: true,
      },
    },
    {
      errorCode: 'navigation_failed' as const,
      reasonCode: 'ptc_lab_browser_navigation_failed',
      checks: {
        engineAvailable: true,
        contextCreated: true,
        navigationCommitted: true,
        loadStateReached: true,
        cleanupCompleted: true,
      },
    },
  ];

  for (const item of cases) {
    await withBrowserNavigationSessionManager(
      {
        policy: dockerPolicy,
        navigationResult: {
          kind: 'exit',
          exitCode: item.errorCode === 'browser_runtime_unavailable' ? 3 : 2,
          stdout: browserNavigationStdout({
            ok: false,
            errorCode: item.errorCode,
            checks: item.checks,
          }),
          stderr: `${PTC_BROWSER_NAVIGATION_TEST_PRIVATE_PATH} ${PTC_LAB_BROWSER_FIXED_NAVIGATION_TARGET.url}`,
        },
      },
      async ({ manager, runner, invocations }) => {
        const result = await runPtcLabBrowserFixedNavigationProbe({
          admission,
          identity: PTC_BROWSER_NAVIGATION_TEST_IDENTITY,
          sessionManager: manager,
          request: browserNavigationRequest(),
          commandRunner: runner,
        });

        assert.equal(result.ok, false);
        assert.equal(result.ok ? '' : result.reasonCode, item.reasonCode);
        assert.equal(
          invocations.some((invocation) => invocation.args[0] === 'rm'),
          false,
        );
        assert.doesNotMatch(
          JSON.stringify(result),
          /https?:\/\/|example\.com|geulbat-private|\.geulbat|secret/u,
        );
      },
    );
  }
});

void test('runPtcLabBrowserFixedNavigationProbe taints timeout and cancellation through session close', async () => {
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
    const { admission, dockerPolicy } = createBrowserNavigationLab();
    await withBrowserNavigationSessionManager(
      {
        policy: dockerPolicy,
        navigationResult: {
          kind: item.kind,
          stdout: '',
          stderr: `${PTC_BROWSER_NAVIGATION_TEST_PRIVATE_PATH} ${PTC_LAB_BROWSER_FIXED_NAVIGATION_TARGET.url}`,
        },
      },
      async ({ manager, runner, invocations }) => {
        const result = await runPtcLabBrowserFixedNavigationProbe({
          admission,
          identity: PTC_BROWSER_NAVIGATION_TEST_IDENTITY,
          sessionManager: manager,
          request: browserNavigationRequest(),
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
          /https?:\/\/|example\.com|geulbat-private|\.geulbat|secret/u,
        );
      },
    );
  }
});

void test('runPtcLabBrowserFixedNavigationProbe rejects raw URL, redirect, status, and browser output leaks', async () => {
  const { admission, dockerPolicy } = createBrowserNavigationLab();

  await withBrowserNavigationSessionManager(
    {
      policy: dockerPolicy,
      navigationResult: {
        kind: 'exit',
        exitCode: 0,
        stdout: `${JSON.stringify({
          ok: true,
          capability: PTC_LAB_BROWSER_FIXED_NAVIGATION_PROBE_CAPABILITY,
          checks: PTC_BROWSER_NAVIGATION_TEST_SUCCESS_CHECKS,
          targetUrl: PTC_LAB_BROWSER_FIXED_NAVIGATION_TARGET.url,
          finalUrl: 'https://example.com/redirect',
          redirectUrl: 'https://example.com/redirect',
          statusCode: 302,
          responseHeaders: { location: 'https://example.com/redirect' },
          browserConsole: `console ${PTC_BROWSER_NAVIGATION_TEST_PRIVATE_PATH}`,
          userDataDir: '/tmp/geulbat-private/.geulbat/browser-profile',
        })}\n`,
        stderr: `${PTC_BROWSER_NAVIGATION_TEST_PRIVATE_PATH} ${PTC_LAB_BROWSER_FIXED_NAVIGATION_TARGET.url}`,
      },
    },
    async ({ manager, runner }) => {
      const result = await runPtcLabBrowserFixedNavigationProbe({
        admission,
        identity: PTC_BROWSER_NAVIGATION_TEST_IDENTITY,
        sessionManager: manager,
        request: browserNavigationRequest(),
        commandRunner: runner,
      });

      assert.equal(result.ok, false);
      assert.equal(
        result.ok ? '' : result.reasonCode,
        'ptc_lab_browser_output_invalid',
      );
      assert.doesNotMatch(
        JSON.stringify(result),
        /https?:\/\/|example\.com|redirect|status|headers|console|userDataDir|geulbat-private|\.geulbat|secret/u,
      );
    },
  );
});

void test('runPtcLabBrowserFixedNavigationProbe rejects success when cleanup is not proven', async () => {
  const { admission, dockerPolicy } = createBrowserNavigationLab();

  await withBrowserNavigationSessionManager(
    {
      policy: dockerPolicy,
      navigationResult: {
        kind: 'exit',
        exitCode: 2,
        stdout: browserNavigationStdout({
          ok: false,
          errorCode: 'cleanup_failed',
          checks: {
            engineAvailable: true,
            contextCreated: true,
            navigationCommitted: true,
            loadStateReached: true,
            cleanupCompleted: false,
          },
        }),
        stderr: PTC_BROWSER_NAVIGATION_TEST_PRIVATE_PATH,
      },
    },
    async ({ manager, runner, invocations }) => {
      const result = await runPtcLabBrowserFixedNavigationProbe({
        admission,
        identity: PTC_BROWSER_NAVIGATION_TEST_IDENTITY,
        sessionManager: manager,
        request: browserNavigationRequest(),
        commandRunner: runner,
      });

      assert.equal(result.ok, false);
      assert.equal(
        result.ok ? '' : result.reasonCode,
        'ptc_lab_browser_cleanup_failed',
      );
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
});
