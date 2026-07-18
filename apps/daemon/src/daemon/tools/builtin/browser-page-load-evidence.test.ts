import test from 'node:test';
import assert from 'node:assert/strict';
import { createDaemonContext } from '../../context.js';
import {
  PTC_BROWSER_PAGE_LOAD_EVIDENCE_TOOL_NAME,
  type PtcBrowserPageLoadEvidenceRuntime,
  type PtcBrowserPageLoadEvidenceRuntimeSummary,
} from '../../ptc/runtime/browser/browser-page-load-evidence-runtime-contract.js';
import { PTC_LAB_BROWSER_PAGE_LOAD_EVIDENCE_CAPABILITY } from '../../ptc/lab/browser/page-load-evidence/lab-browser-page-load-evidence-contract.js';
import {
  PTC_LAB_BROWSER_FINAL_URL_DIGEST_PUBLIC_SHA256_POLICY_ID,
  PTC_LAB_BROWSER_FINAL_URL_ECHO_DIGEST_ONLY_POLICY_ID,
  PTC_LAB_BROWSER_PAGE_LOAD_EVIDENCE_DIGEST_RESULT_WITH_TIMING_POLICY_ID,
  PTC_LAB_BROWSER_PAGE_LOAD_EVIDENCE_POLICY_ID,
  PTC_LAB_BROWSER_PAGE_LOAD_EVIDENCE_SUMMARY_POLICY_ID,
  PTC_LAB_BROWSER_REDIRECT_COUNT_ONLY_POLICY_ID,
  PTC_LAB_BROWSER_REDIRECT_REVALIDATED_POLICY_ID,
  PTC_LAB_BROWSER_RESPONSE_STATUS_CODE_OPTIONAL_POLICY_ID,
  PTC_LAB_BROWSER_RUNTIME_ENGINE_CHROMIUM_POLICY_ID,
  PTC_LAB_BROWSER_TIMING_OWNER_AND_NAVIGATION_BOUNDED_POLICY_ID,
  PTC_LAB_BROWSER_URL_ECHO_DIGEST_ONLY_POLICY_ID,
  PTC_LAB_BROWSER_URL_GRAMMAR_HTTP_HTTPS_NO_CREDENTIALS_POLICY_ID,
} from '../../ptc/lab/browser/core/lab-browser-policy-ids.js';
import { PTC_LAB_OPEN_EGRESS_LOCAL_POLICY_ID } from '../../ptc/lab/network/lab-network-policy.js';
import { testThreadId } from '../../../test-support/thread-id.js';
import { isToolObjectParameters } from '../types.js';
import { browserPageLoadEvidenceTool } from './browser-page-load-evidence.js';

void test('browser_page_load_evidence exposes scalar URL schema and approval-gated metadata', () => {
  assert.equal(
    browserPageLoadEvidenceTool.name,
    PTC_BROWSER_PAGE_LOAD_EVIDENCE_TOOL_NAME,
  );
  assert.equal(browserPageLoadEvidenceTool.sideEffectLevel, 'write');
  assert.equal(browserPageLoadEvidenceTool.requiresApproval, true);
  assert.equal(browserPageLoadEvidenceTool.mayMutateComputerFiles, false);
  const parameters = browserPageLoadEvidenceTool.parameters;
  assert.ok(isToolObjectParameters(parameters));
  assert.deepEqual(parameters.required, ['url']);
  assert.ok('url' in parameters.properties);
  assert.ok('timeoutMs' in parameters.properties);
  assert.ok(!('screenshot' in parameters.properties));
  assert.ok(!('dom' in parameters.properties));
  assert.ok(!('artifactExport' in parameters.properties));
});

void test('browser_page_load_evidence requires an agent runtime service before loading', async () => {
  const result = await browserPageLoadEvidenceTool.execute(
    { url: 'https://example.com/' },
    {
      callId: 'call-browser-page-load-evidence-no-runtime',
      stateRoot: '/workspace/home-state',

      workingDirectory: 'project',
      threadId: testThreadId(951),
    },
  );

  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'execution_failed');
  assert.match(result.error ?? '', /runtime is required/u);
});

void test('browser_page_load_evidence returns page-load evidence without raw URL leaks', async () => {
  const daemonContext = createDaemonContext();
  let observedUrl = '';
  let observedTimeoutMs: number | undefined;
  const ptcBrowserPageLoadEvidence: PtcBrowserPageLoadEvidenceRuntime = {
    async collectEvidence(args) {
      observedUrl = args.request.url;
      observedTimeoutMs = args.request.timeoutMs;
      return {
        ok: true,
        value: browserPageLoadEvidenceSummary(),
      };
    },
    async closeAll() {
      return { ok: true };
    },
  };

  const result = await browserPageLoadEvidenceTool.execute(
    {
      url: 'https://example.com/private?access_token=secret#id_token=secret',
      timeoutMs: 1000,
    },
    {
      callId: 'call-browser-page-load-evidence-success',
      stateRoot: '/workspace/home-state',

      workingDirectory: 'project',
      threadId: testThreadId(952),
      agentSpawnRuntime: { ...daemonContext, ptcBrowserPageLoadEvidence },
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
  assert.equal(output.kind, 'ptc_lab_browser_page_load_evidence_result');
  assert.equal(
    output.capability,
    PTC_LAB_BROWSER_PAGE_LOAD_EVIDENCE_CAPABILITY,
  );
  assert.equal(
    output.browserPolicyId,
    PTC_LAB_BROWSER_PAGE_LOAD_EVIDENCE_POLICY_ID,
  );
  assert.equal(output.artifactExported, false);
  assert.equal(Object.hasOwn(output, 'url'), false);
  assert.equal(Object.hasOwn(output, 'rawUrl'), false);
  assert.equal(Object.hasOwn(output, 'dom'), false);
  assert.equal(Object.hasOwn(output, 'screenshot'), false);
  assert.equal(Object.hasOwn(output, 'containerId'), false);
  assert.deepEqual(output.responseStatus, {
    policyId: PTC_LAB_BROWSER_RESPONSE_STATUS_CODE_OPTIONAL_POLICY_ID,
    code: 200,
    source: 'final_main_resource_response',
  });
  assert.equal(output.title, 'Example Domain');
});

void test('browser_page_load_evidence strips unsafe failure diagnostics from tool output', async () => {
  const daemonContext = createDaemonContext();
  const ptcBrowserPageLoadEvidence: PtcBrowserPageLoadEvidenceRuntime = {
    async collectEvidence() {
      return {
        ok: false,
        kind: 'ptc_lab_browser_page_load_evidence_error',
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

  const result = await browserPageLoadEvidenceTool.execute(
    { url: 'https://example.com/private?access_token=secret' },
    {
      callId: 'call-browser-page-load-evidence-failure',
      stateRoot: '/workspace/home-state',

      workingDirectory: 'project',
      threadId: testThreadId(953),
      agentSpawnRuntime: { ...daemonContext, ptcBrowserPageLoadEvidence },
      approvalGranted: true,
    },
  );

  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'execution_failed');
  assert.equal(
    result.error,
    'PTC browser page-load evidence session is unavailable.',
  );
  assert.doesNotMatch(
    `${result.output}\n${result.error ?? ''}`,
    /example\.com|access_token|geulbat-private|private/u,
  );
  assert.deepEqual(JSON.parse(result.output), {
    kind: 'ptc_lab_browser_page_load_evidence_error',
    ok: false,
    reasonCode: 'ptc_lab_browser_session_unavailable',
    message: 'PTC browser page-load evidence session is unavailable.',
    phase: 'session_acquisition',
    diagnostics: {
      sessionReasonCode: 'container_create_failed',
    },
  });
});

void test('browser_page_load_evidence rejects later-owner browser action fields at the tool boundary', async () => {
  const result = await browserPageLoadEvidenceTool.execute(
    { url: 'https://example.com/', screenshot: true },
    {
      callId: 'call-browser-page-load-evidence-screenshot',
      stateRoot: '/workspace/home-state',

      workingDirectory: 'project',
      threadId: testThreadId(954),
    },
  );

  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'invalid_args');
  assert.match(result.error, /screenshot/u);
});

function browserPageLoadEvidenceSummary(): PtcBrowserPageLoadEvidenceRuntimeSummary {
  const targetDigest =
    `sha256:${'a'.repeat(64)}` as PtcBrowserPageLoadEvidenceRuntimeSummary['targetDigest'];
  return {
    kind: 'ptc_lab_browser_page_load_evidence_result',
    ok: true,
    profile: 'lab',
    capability: PTC_LAB_BROWSER_PAGE_LOAD_EVIDENCE_CAPABILITY,
    targetDigest,
    pageLoadEvidenceAttemptDigest:
      `sha256:${'b'.repeat(64)}` as PtcBrowserPageLoadEvidenceRuntimeSummary['pageLoadEvidenceAttemptDigest'],
    pageLoadEvidenceDigest:
      `sha256:${'c'.repeat(64)}` as PtcBrowserPageLoadEvidenceRuntimeSummary['pageLoadEvidenceDigest'],
    sessionLifecycle: {
      mode: 'runtime_owned',
      retainedAfterExecution: true,
      taintedAfterExecution: false,
    },
    policyFingerprint:
      `sha256:${'d'.repeat(64)}` as PtcBrowserPageLoadEvidenceRuntimeSummary['policyFingerprint'],
    maxNavigationMs: 15_000,
    maxTabs: 1,
    browserPolicyId: PTC_LAB_BROWSER_PAGE_LOAD_EVIDENCE_POLICY_ID,
    browserMode: 'page_load_evidence',
    browserEnginePolicyId: PTC_LAB_BROWSER_RUNTIME_ENGINE_CHROMIUM_POLICY_ID,
    browserNetworkPolicyId: PTC_LAB_OPEN_EGRESS_LOCAL_POLICY_ID,
    browserUrlGrammarPolicyId:
      PTC_LAB_BROWSER_URL_GRAMMAR_HTTP_HTTPS_NO_CREDENTIALS_POLICY_ID,
    browserRedirectPolicyId: PTC_LAB_BROWSER_REDIRECT_REVALIDATED_POLICY_ID,
    browserEvidencePolicyId:
      PTC_LAB_BROWSER_PAGE_LOAD_EVIDENCE_SUMMARY_POLICY_ID,
    pageLoadEvidenceDigestPolicyId:
      PTC_LAB_BROWSER_PAGE_LOAD_EVIDENCE_DIGEST_RESULT_WITH_TIMING_POLICY_ID,
    requestedUrlEchoPolicyId: PTC_LAB_BROWSER_URL_ECHO_DIGEST_ONLY_POLICY_ID,
    finalUrlEchoPolicyId: PTC_LAB_BROWSER_FINAL_URL_ECHO_DIGEST_ONLY_POLICY_ID,
    finalUrlDigestPolicyId:
      PTC_LAB_BROWSER_FINAL_URL_DIGEST_PUBLIC_SHA256_POLICY_ID,
    responseStatusPolicyId:
      PTC_LAB_BROWSER_RESPONSE_STATUS_CODE_OPTIONAL_POLICY_ID,
    redirectCountPolicyId: PTC_LAB_BROWSER_REDIRECT_COUNT_ONLY_POLICY_ID,
    timingPolicyId:
      PTC_LAB_BROWSER_TIMING_OWNER_AND_NAVIGATION_BOUNDED_POLICY_ID,
    artifactExported: false,
    requestedUrl: {
      digest: targetDigest,
      echoPolicyId: PTC_LAB_BROWSER_URL_ECHO_DIGEST_ONLY_POLICY_ID,
      redacted: true,
    },
    finalUrl: {
      digest:
        `sha256:${'e'.repeat(64)}` as PtcBrowserPageLoadEvidenceRuntimeSummary['finalUrl']['digest'],
      digestPolicyId: PTC_LAB_BROWSER_FINAL_URL_DIGEST_PUBLIC_SHA256_POLICY_ID,
      echoPolicyId: PTC_LAB_BROWSER_FINAL_URL_ECHO_DIGEST_ONLY_POLICY_ID,
      redacted: true,
    },
    loadOutcome: 'loaded',
    loadState: 'domcontentloaded',
    responseStatus: {
      policyId: PTC_LAB_BROWSER_RESPONSE_STATUS_CODE_OPTIONAL_POLICY_ID,
      code: 200,
      source: 'final_main_resource_response',
    },
    title: 'Example Domain',
    redirects: {
      policyId: PTC_LAB_BROWSER_REDIRECT_COUNT_ONLY_POLICY_ID,
      count: 1,
    },
    timing: {
      policyId: PTC_LAB_BROWSER_TIMING_OWNER_AND_NAVIGATION_BOUNDED_POLICY_ID,
      ownerDurationMs: 12,
      navigationDurationMs: 7,
    },
    evidenceAvailability: {
      responseStatus: 'available',
      title: 'available',
      finalUrl: 'available',
      navigationTiming: 'available',
    },
    checks: {
      targetVerified: true,
      engineAvailable: true,
      contextCreated: true,
      navigationStarted: true,
      navigationSettled: true,
      redirectPolicyEnforced: true,
      downloadPolicyEnforced: true,
      popupPolicyEnforced: true,
      evidenceCaptured: true,
      cleanupCompleted: true,
    },
  };
}
