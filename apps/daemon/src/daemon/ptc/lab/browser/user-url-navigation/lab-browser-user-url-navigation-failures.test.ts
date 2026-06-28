import assert from 'node:assert/strict';
import test from 'node:test';
import { runPtcLabBrowserUserUrlNavigation } from './lab-browser-user-url-navigation.js';
import type { PtcLabBrowserUserUrlNavigationChecks } from './lab-browser-user-url-navigation-contract.js';
import {
  browserUserUrlNavigationRequest,
  browserUserUrlNavigationStdout,
  createBrowserUserUrlNavigationLab,
  PTC_BROWSER_USER_URL_NAVIGATION_TEST_IDENTITY,
  PTC_BROWSER_USER_URL_NAVIGATION_TEST_PRIVATE_PATH,
  PTC_BROWSER_USER_URL_NAVIGATION_TEST_SUCCESS_CHECKS,
  withBrowserUserUrlNavigationSessionManager,
} from '../../../../../test-support/ptc-browser-user-url-navigation.js';

type AdapterChecks = Omit<
  PtcLabBrowserUserUrlNavigationChecks,
  'targetVerified'
>;

void test('runPtcLabBrowserUserUrlNavigation classifies runtime and browser policy failures without raw leaks', async () => {
  const { admission, dockerPolicy } = createBrowserUserUrlNavigationLab();
  const cases: Array<{
    errorCode:
      | 'browser_runtime_unavailable'
      | 'redirect_disallowed'
      | 'download_disallowed'
      | 'popup_disallowed';
    reasonCode: string;
    phase: string;
    checks: AdapterChecks;
  }> = [
    {
      errorCode: 'browser_runtime_unavailable',
      reasonCode: 'ptc_lab_browser_runtime_unavailable',
      phase: 'runtime_start',
      checks: {
        engineAvailable: false,
        contextCreated: false,
        navigationStarted: false,
        navigationSettled: false,
        redirectPolicyEnforced: false,
        downloadPolicyEnforced: false,
        cleanupCompleted: true,
      },
    },
    {
      errorCode: 'redirect_disallowed',
      reasonCode: 'ptc_lab_browser_redirect_disallowed',
      phase: 'redirect_revalidation',
      checks: {
        ...PTC_BROWSER_USER_URL_NAVIGATION_TEST_SUCCESS_CHECKS,
        redirectPolicyEnforced: false,
      },
    },
    {
      errorCode: 'download_disallowed',
      reasonCode: 'ptc_lab_browser_download_disallowed',
      phase: 'download_policy',
      checks: {
        ...PTC_BROWSER_USER_URL_NAVIGATION_TEST_SUCCESS_CHECKS,
        downloadPolicyEnforced: false,
      },
    },
    {
      errorCode: 'popup_disallowed',
      reasonCode: 'ptc_lab_browser_popup_disallowed',
      phase: 'popup_policy',
      checks: PTC_BROWSER_USER_URL_NAVIGATION_TEST_SUCCESS_CHECKS,
    },
  ];

  for (const item of cases) {
    await withBrowserUserUrlNavigationSessionManager(
      {
        policy: dockerPolicy,
        navigationResult: {
          kind: 'exit',
          exitCode: item.errorCode === 'browser_runtime_unavailable' ? 3 : 2,
          stdout: browserUserUrlNavigationStdout({
            ok: false,
            errorCode: item.errorCode,
            checks: item.checks,
          }),
          stderr: `${PTC_BROWSER_USER_URL_NAVIGATION_TEST_PRIVATE_PATH} https://example.com/private?access_token=secret#id_token=secret`,
        },
      },
      async ({ manager, runner, invocations }) => {
        const result = await runPtcLabBrowserUserUrlNavigation({
          admission,
          identity: PTC_BROWSER_USER_URL_NAVIGATION_TEST_IDENTITY,
          sessionManager: manager,
          request: browserUserUrlNavigationRequest(),
          commandRunner: runner,
        });

        assert.equal(result.ok, false);
        assert.equal(result.ok ? '' : result.reasonCode, item.reasonCode);
        assert.equal(result.ok ? '' : result.phase, item.phase);
        assert.equal(
          invocations.some((invocation) => invocation.args[0] === 'rm'),
          false,
        );
        assert.doesNotMatch(
          JSON.stringify(result),
          /https?:\/\/|example\.com|access_token|id_token|secret|geulbat-private|\.geulbat/u,
        );
      },
    );
  }
});

void test('runPtcLabBrowserUserUrlNavigation taints command and cleanup failures', async () => {
  const cleanupFailureStdout = browserUserUrlNavigationStdout({
    ok: false,
    errorCode: 'cleanup_failed',
    checks: {
      ...PTC_BROWSER_USER_URL_NAVIGATION_TEST_SUCCESS_CHECKS,
      cleanupCompleted: false,
    },
  });
  const cases = [
    {
      navigationResult: {
        kind: 'timeout' as const,
        stdout: '',
        stderr: PTC_BROWSER_USER_URL_NAVIGATION_TEST_PRIVATE_PATH,
      },
      reasonCode: 'ptc_lab_browser_timeout',
      phase: 'navigation',
    },
    {
      navigationResult: {
        kind: 'cancelled' as const,
        stdout: '',
        stderr: PTC_BROWSER_USER_URL_NAVIGATION_TEST_PRIVATE_PATH,
      },
      reasonCode: 'ptc_lab_browser_cancelled',
      phase: 'navigation',
    },
    {
      navigationResult: {
        kind: 'crash' as const,
        stdout: '',
        stderr: PTC_BROWSER_USER_URL_NAVIGATION_TEST_PRIVATE_PATH,
      },
      reasonCode: 'ptc_lab_browser_navigation_failed',
      phase: 'navigation',
    },
    {
      navigationResult: {
        kind: 'exit' as const,
        exitCode: 2,
        stdout: cleanupFailureStdout,
        stderr: PTC_BROWSER_USER_URL_NAVIGATION_TEST_PRIVATE_PATH,
      },
      reasonCode: 'ptc_lab_browser_cleanup_failed',
      phase: 'cleanup',
    },
  ];

  for (const item of cases) {
    const { admission, dockerPolicy } = createBrowserUserUrlNavigationLab();
    await withBrowserUserUrlNavigationSessionManager(
      {
        policy: dockerPolicy,
        navigationResult: item.navigationResult,
      },
      async ({ manager, runner, invocations }) => {
        const result = await runPtcLabBrowserUserUrlNavigation({
          admission,
          identity: PTC_BROWSER_USER_URL_NAVIGATION_TEST_IDENTITY,
          sessionManager: manager,
          request: browserUserUrlNavigationRequest(),
          commandRunner: runner,
        });

        assert.equal(result.ok, false);
        assert.equal(result.ok ? '' : result.reasonCode, item.reasonCode);
        assert.equal(result.ok ? '' : result.phase, item.phase);
        assert.equal(
          result.ok ? false : result.sessionLifecycle?.taintedAfterExecution,
          true,
        );
        assert.equal(
          invocations.some((invocation) => invocation.args[0] === 'rm'),
          true,
        );
        assert.doesNotMatch(
          JSON.stringify(result),
          /https?:\/\/|example\.com|access_token|id_token|secret|geulbat-private|\.geulbat/u,
        );
      },
    );
  }
});

void test('runPtcLabBrowserUserUrlNavigation rejects adapter output leaks before returning summary', async () => {
  const { admission, dockerPolicy } = createBrowserUserUrlNavigationLab();

  await withBrowserUserUrlNavigationSessionManager(
    {
      policy: dockerPolicy,
      navigationResult: {
        kind: 'exit',
        exitCode: 0,
        stdout: `${JSON.stringify({
          ok: true,
          capability: 'ptc_lab_browser_user_url_navigation',
          checks: PTC_BROWSER_USER_URL_NAVIGATION_TEST_SUCCESS_CHECKS,
          requestedUrl:
            'https://example.com/private?access_token=secret#id_token=secret',
          finalUrl: 'https://example.com/final',
          statusCode: 200,
          responseHeaders: { location: 'https://example.com/final' },
          browserConsole: `console ${PTC_BROWSER_USER_URL_NAVIGATION_TEST_PRIVATE_PATH}`,
          userDataDir: '/tmp/geulbat-private/.geulbat/browser-profile',
        })}\n`,
        stderr: `${PTC_BROWSER_USER_URL_NAVIGATION_TEST_PRIVATE_PATH} https://example.com/private?access_token=secret#id_token=secret`,
      },
    },
    async ({ manager, runner }) => {
      const result = await runPtcLabBrowserUserUrlNavigation({
        admission,
        identity: PTC_BROWSER_USER_URL_NAVIGATION_TEST_IDENTITY,
        sessionManager: manager,
        request: browserUserUrlNavigationRequest(),
        commandRunner: runner,
      });

      assert.equal(result.ok, false);
      assert.equal(
        result.ok ? '' : result.reasonCode,
        'ptc_lab_browser_output_invalid',
      );
      assert.doesNotMatch(
        JSON.stringify(result),
        /https?:\/\/|example\.com|access_token|id_token|secret|final|status|headers|console|userDataDir|geulbat-private|\.geulbat/u,
      );
    },
  );
});
