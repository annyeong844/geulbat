import test from 'node:test';
import assert from 'node:assert/strict';
import { createDaemonContext } from '../../context.js';
import {
  PTC_BROWSER_NAVIGATE_TOOL_NAME,
  type PtcBrowserNavigateRuntime,
} from '../../ptc/runtime/browser/browser-navigate-runtime-contract.js';
import {
  PTC_LAB_BROWSER_ARTIFACT_EXPORT_DISABLED_POLICY_ID,
  PTC_LAB_BROWSER_COOKIE_STORE_NONE_POLICY_ID,
  PTC_LAB_BROWSER_DOWNLOADS_DISABLED_POLICY_ID,
  PTC_LAB_BROWSER_NAVIGATION_SUMMARY_ONLY_POLICY_ID,
  PTC_LAB_BROWSER_PERMISSIONS_DENIED_POLICY_ID,
  PTC_LAB_BROWSER_POPUPS_DISABLED_POLICY_ID,
  PTC_LAB_BROWSER_PROFILE_FRESH_PER_ATTEMPT_POLICY_ID,
  PTC_LAB_BROWSER_REDIRECT_REVALIDATED_POLICY_ID,
  PTC_LAB_BROWSER_RUNTIME_ENGINE_CHROMIUM_POLICY_ID,
  PTC_LAB_BROWSER_URL_ECHO_DIGEST_ONLY_POLICY_ID,
  PTC_LAB_BROWSER_USER_URL_NAVIGATION_POLICY_ID,
} from '../../ptc/lab/browser/core/lab-browser-policy-ids.js';
import { PTC_LAB_OPEN_EGRESS_LOCAL_POLICY_ID } from '../../ptc/lab/network/lab-network-policy.js';
import type {
  PtcLabBrowserUserUrlNavigationAttemptDigest,
  PtcLabBrowserUserUrlNavigationSummary,
} from '../../ptc/lab/browser/user-url-navigation/lab-browser-user-url-navigation-contract.js';
import {
  PTC_LAB_BROWSER_USER_URL_NAVIGATION_CAPABILITY,
  type PtcLabBrowserUserUrlTargetDigest,
} from '../../ptc/lab/browser/core/lab-browser-url-navigation.js';
import { testThreadId } from '../../../test-support/thread-id.js';
import { isToolObjectParameters } from '../types.js';
import { browserNavigateTool } from './browser-navigate.js';

void test('browser_navigate exposes scalar URL schema and approval-gated metadata', () => {
  assert.equal(browserNavigateTool.name, PTC_BROWSER_NAVIGATE_TOOL_NAME);
  assert.equal(browserNavigateTool.sideEffectLevel, 'write');
  assert.equal(browserNavigateTool.requiresApproval, true);
  assert.equal(browserNavigateTool.mayMutateComputerFiles, false);
  const parameters = browserNavigateTool.parameters;
  assert.ok(isToolObjectParameters(parameters));
  assert.deepEqual(parameters.required, ['url']);
  assert.ok('url' in parameters.properties);
  assert.ok('timeoutMs' in parameters.properties);
  assert.ok(!('screenshot' in parameters.properties));
  assert.ok(!('dom' in parameters.properties));
  assert.ok(!('artifactExport' in parameters.properties));
});

void test('browser_navigate requires an agent runtime service before navigation', async () => {
  const result = await browserNavigateTool.execute(
    { url: 'https://example.com/' },
    {
      callId: 'call-browser-navigate-no-runtime',
      stateRoot: '/workspace/home-state',

      workingDirectory: 'project',
      threadId: testThreadId(930),
    },
  );

  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'execution_failed');
  assert.match(result.error ?? '', /runtime is required/u);
});

void test('browser_navigate returns digest-only runtime output without raw URL leaks', async () => {
  const daemonContext = createDaemonContext();
  let observedUrl = '';
  let observedTimeoutMs: number | undefined;
  const ptcBrowserNavigate: PtcBrowserNavigateRuntime = {
    async navigate(args) {
      observedUrl = args.request.url;
      observedTimeoutMs = args.request.timeoutMs;
      return {
        ok: true,
        value: browserNavigateSummary(),
      };
    },
    async closeAll() {
      return { ok: true };
    },
  };

  const result = await browserNavigateTool.execute(
    {
      url: 'https://example.com/private?access_token=secret#id_token=secret',
      timeoutMs: 1000,
    },
    {
      callId: 'call-browser-navigate-success',
      stateRoot: '/workspace/home-state',

      workingDirectory: 'project',
      threadId: testThreadId(931),
      agentSpawnRuntime: { ...daemonContext, ptcBrowserNavigate },
      approvalGranted: true,
    },
  );

  assert.equal(result.ok, true);
  assert.equal(
    observedUrl,
    'https://example.com/private?access_token=secret#id_token=secret',
  );
  assert.equal(observedTimeoutMs, 1000);
  assert.doesNotMatch(result.output, /example\.com|access_token|id_token/u);
  const output = JSON.parse(result.output) as Record<string, unknown>;
  assert.equal(output.kind, 'ptc_lab_browser_user_url_navigation_result');
  assert.equal(
    output.capability,
    PTC_LAB_BROWSER_USER_URL_NAVIGATION_CAPABILITY,
  );
  assert.equal(
    output.browserPolicyId,
    PTC_LAB_BROWSER_USER_URL_NAVIGATION_POLICY_ID,
  );
  assert.equal(output.requestedUrlRedacted, true);
  assert.equal(output.finalUrlRedacted, true);
  assert.equal(output.artifactExported, false);
  assert.equal(Object.hasOwn(output, 'url'), false);
  assert.equal(Object.hasOwn(output, 'finalUrl'), false);
});

void test('browser_navigate strips unsafe failure diagnostics from tool output', async () => {
  const daemonContext = createDaemonContext();
  const ptcBrowserNavigate: PtcBrowserNavigateRuntime = {
    async navigate() {
      return {
        ok: false,
        kind: 'ptc_lab_browser_user_url_navigation_error',
        reasonCode: 'ptc_lab_browser_session_unavailable',
        message:
          'session failed for https://example.com/private?access_token=secret in /tmp/geulbat-private/.geulbat/ptc/private',
        phase: 'session_acquisition',
        diagnostics: {
          sessionReasonCode: 'container_create_failed',
          rawPath: '/tmp/geulbat-private/.geulbat/ptc/private',
        },
      };
    },
    async closeAll() {
      return { ok: true };
    },
  };

  const result = await browserNavigateTool.execute(
    { url: 'https://example.com/private?access_token=secret' },
    {
      callId: 'call-browser-navigate-failure',
      stateRoot: '/workspace/home-state',

      workingDirectory: 'project',
      threadId: testThreadId(932),
      agentSpawnRuntime: { ...daemonContext, ptcBrowserNavigate },
      approvalGranted: true,
    },
  );

  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'execution_failed');
  assert.equal(result.error, 'PTC browser navigation session is unavailable.');
  assert.doesNotMatch(
    `${result.output}\n${result.error ?? ''}`,
    /example\.com|access_token|geulbat-private|private/u,
  );
  assert.deepEqual(JSON.parse(result.output), {
    kind: 'ptc_lab_browser_user_url_navigation_error',
    ok: false,
    reasonCode: 'ptc_lab_browser_session_unavailable',
    message: 'PTC browser navigation session is unavailable.',
    phase: 'session_acquisition',
    diagnostics: {
      sessionReasonCode: 'container_create_failed',
    },
  });
});

void test('browser_navigate rejects later-owner browser action fields at the tool boundary', async () => {
  const result = await browserNavigateTool.execute(
    { url: 'https://example.com/', screenshot: true },
    {
      callId: 'call-browser-navigate-screenshot',
      stateRoot: '/workspace/home-state',

      workingDirectory: 'project',
      threadId: testThreadId(933),
    },
  );

  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'invalid_args');
  assert.match(result.error, /screenshot/u);
});

function browserNavigateSummary(): PtcLabBrowserUserUrlNavigationSummary {
  return {
    kind: 'ptc_lab_browser_user_url_navigation_result',
    ok: true,
    profile: 'lab',
    capability: PTC_LAB_BROWSER_USER_URL_NAVIGATION_CAPABILITY,
    targetDigest:
      `sha256:${'a'.repeat(64)}` as PtcLabBrowserUserUrlTargetDigest,
    navigationAttemptDigest:
      `sha256:${'b'.repeat(64)}` as PtcLabBrowserUserUrlNavigationAttemptDigest,
    sessionLifecycle: {
      mode: 'runtime_owned',
      retainedAfterExecution: true,
      taintedAfterExecution: false,
    },
    browserPolicyId: PTC_LAB_BROWSER_USER_URL_NAVIGATION_POLICY_ID,
    browserMode: 'user_url_navigation',
    browserEnginePolicyId: PTC_LAB_BROWSER_RUNTIME_ENGINE_CHROMIUM_POLICY_ID,
    browserNetworkPolicyId: PTC_LAB_OPEN_EGRESS_LOCAL_POLICY_ID,
    browserUrlGrammarPolicyId:
      'ptc_lab_browser_url_grammar_http_https_no_credentials_v1',
    browserRedirectPolicyId: PTC_LAB_BROWSER_REDIRECT_REVALIDATED_POLICY_ID,
    browserEvidencePolicyId: PTC_LAB_BROWSER_NAVIGATION_SUMMARY_ONLY_POLICY_ID,
    browserUrlEchoPolicyId: PTC_LAB_BROWSER_URL_ECHO_DIGEST_ONLY_POLICY_ID,
    browserPopupPolicyId: PTC_LAB_BROWSER_POPUPS_DISABLED_POLICY_ID,
    browserPermissionPolicyId: PTC_LAB_BROWSER_PERMISSIONS_DENIED_POLICY_ID,
    browserProfilePolicyId: PTC_LAB_BROWSER_PROFILE_FRESH_PER_ATTEMPT_POLICY_ID,
    browserCookieStorePolicyId: PTC_LAB_BROWSER_COOKIE_STORE_NONE_POLICY_ID,
    browserDownloadPolicyId: PTC_LAB_BROWSER_DOWNLOADS_DISABLED_POLICY_ID,
    browserArtifactExportPolicyId:
      PTC_LAB_BROWSER_ARTIFACT_EXPORT_DISABLED_POLICY_ID,
    artifactExported: false,
    requestedUrlRedacted: true,
    finalUrlRedacted: true,
    navigationOutcome: 'loaded',
    loadState: 'domcontentloaded',
    checks: {
      targetVerified: true,
      engineAvailable: true,
      contextCreated: true,
      navigationStarted: true,
      navigationSettled: true,
      redirectPolicyEnforced: true,
      downloadPolicyEnforced: true,
      cleanupCompleted: true,
    },
    durationMs: 12,
  };
}
