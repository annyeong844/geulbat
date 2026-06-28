import test from 'node:test';
import assert from 'node:assert/strict';
import { createDaemonContext } from '../../context.js';
import {
  PTC_BROWSER_TEXT_EVIDENCE_TOOL_NAME,
  type PtcBrowserTextEvidenceRuntime,
  type PtcBrowserTextEvidenceRuntimeSummary,
} from '../../ptc/runtime/browser/browser-text-evidence-runtime-contract.js';
import { PTC_LAB_BROWSER_TEXT_EVIDENCE_CAPABILITY } from '../../ptc/lab/browser/text-evidence/lab-browser-text-evidence-contract.js';
import {
  PTC_LAB_BROWSER_DOM_TEXT_EVIDENCE_POLICY_ID,
  PTC_LAB_BROWSER_FINAL_URL_DIGEST_PUBLIC_SHA256_POLICY_ID,
  PTC_LAB_BROWSER_FINAL_URL_ECHO_DIGEST_ONLY_POLICY_ID,
  PTC_LAB_BROWSER_REDIRECT_COUNT_ONLY_POLICY_ID,
  PTC_LAB_BROWSER_REDIRECT_REVALIDATED_POLICY_ID,
  PTC_LAB_BROWSER_RUNTIME_ENGINE_CHROMIUM_POLICY_ID,
  PTC_LAB_BROWSER_TEXT_EVIDENCE_DIGEST_RESULT_WITH_TIMING_POLICY_ID,
  PTC_LAB_BROWSER_TEXT_EVIDENCE_SUMMARY_POLICY_ID,
  PTC_LAB_BROWSER_TIMING_OWNER_AND_NAVIGATION_BOUNDED_POLICY_ID,
  PTC_LAB_BROWSER_URL_ECHO_DIGEST_ONLY_POLICY_ID,
  PTC_LAB_BROWSER_URL_GRAMMAR_HTTP_HTTPS_NO_CREDENTIALS_POLICY_ID,
} from '../../ptc/lab/browser/core/lab-browser-policy-ids.js';
import { PTC_LAB_OPEN_EGRESS_LOCAL_POLICY_ID } from '../../ptc/lab/network/lab-network-policy.js';
import { testProjectId } from '../../../test-support/project-id.js';
import { testThreadId } from '../../../test-support/thread-id.js';
import { isToolObjectParameters } from '../types.js';
import { browserTextEvidenceTool } from './browser-text-evidence.js';

void test('browser_text_evidence exposes scalar URL schema and approval-gated metadata', () => {
  assert.equal(
    browserTextEvidenceTool.name,
    PTC_BROWSER_TEXT_EVIDENCE_TOOL_NAME,
  );
  assert.equal(browserTextEvidenceTool.sideEffectLevel, 'write');
  assert.equal(browserTextEvidenceTool.requiresApproval, true);
  assert.equal(browserTextEvidenceTool.mayMutateWorkspaceFiles, false);
  const parameters = browserTextEvidenceTool.parameters;
  assert.ok(isToolObjectParameters(parameters));
  assert.deepEqual(parameters.required, ['url']);
  assert.ok('url' in parameters.properties);
  assert.ok('timeoutMs' in parameters.properties);
  assert.ok(!('maxTextChars' in parameters.properties));
  assert.ok(!('screenshot' in parameters.properties));
  assert.ok(!('dom' in parameters.properties));
  assert.ok(!('html' in parameters.properties));
  assert.ok(!('selector' in parameters.properties));
  assert.ok(!('artifactExport' in parameters.properties));
});

void test('browser_text_evidence requires an agent runtime service before loading', async () => {
  const result = await browserTextEvidenceTool.execute(
    { url: 'https://example.com/' },
    {
      callId: 'call-browser-text-evidence-no-runtime',
      workspaceRoot: '/workspace/project',
      threadId: testThreadId(955),
      projectId: testProjectId('project'),
    },
  );

  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'execution_failed');
  assert.match(result.error ?? '', /runtime is required/u);
});

void test('browser_text_evidence returns text evidence without raw URL leaks', async () => {
  const daemonContext = createDaemonContext();
  let observedUrl = '';
  let observedTimeoutMs: number | undefined;
  const ptcBrowserTextEvidence: PtcBrowserTextEvidenceRuntime = {
    async collectEvidence(args) {
      observedUrl = args.request.url;
      observedTimeoutMs = args.request.timeoutMs;
      return {
        ok: true,
        value: browserTextEvidenceSummary(),
      };
    },
    async closeAll() {
      return { ok: true };
    },
  };

  const result = await browserTextEvidenceTool.execute(
    {
      url: 'https://example.com/private?access_token=secret#id_token=secret',
      timeoutMs: 1000,
    },
    {
      callId: 'call-browser-text-evidence-success',
      workspaceRoot: '/workspace/project',
      threadId: testThreadId(956),
      projectId: testProjectId('project'),
      agentSpawnRuntime: { ...daemonContext, ptcBrowserTextEvidence },
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
  assert.equal(output.kind, 'ptc_lab_browser_text_evidence_result');
  assert.equal(output.capability, PTC_LAB_BROWSER_TEXT_EVIDENCE_CAPABILITY);
  assert.equal(
    output.browserPolicyId,
    PTC_LAB_BROWSER_DOM_TEXT_EVIDENCE_POLICY_ID,
  );
  assert.equal(output.artifactExported, false);
  assert.equal(Object.hasOwn(output, 'url'), false);
  assert.equal(Object.hasOwn(output, 'rawUrl'), false);
  assert.equal(Object.hasOwn(output, 'dom'), false);
  assert.equal(Object.hasOwn(output, 'html'), false);
  assert.equal(Object.hasOwn(output, 'screenshot'), false);
  assert.equal(Object.hasOwn(output, 'containerId'), false);
  assert.equal(output.visibleText, 'Visible page text');
});

void test('browser_text_evidence strips unsafe failure diagnostics from tool output', async () => {
  const daemonContext = createDaemonContext();
  const ptcBrowserTextEvidence: PtcBrowserTextEvidenceRuntime = {
    async collectEvidence() {
      return {
        ok: false,
        kind: 'ptc_lab_browser_text_evidence_error',
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

  const result = await browserTextEvidenceTool.execute(
    { url: 'https://example.com/private?access_token=secret' },
    {
      callId: 'call-browser-text-evidence-failure',
      workspaceRoot: '/workspace/project',
      threadId: testThreadId(957),
      projectId: testProjectId('project'),
      agentSpawnRuntime: { ...daemonContext, ptcBrowserTextEvidence },
      approvalGranted: true,
    },
  );

  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'execution_failed');
  assert.equal(
    result.error,
    'PTC browser text evidence session is unavailable.',
  );
  assert.doesNotMatch(
    `${result.output}\n${result.error ?? ''}`,
    /example\.com|access_token|geulbat-private|private/u,
  );
  assert.deepEqual(JSON.parse(result.output), {
    kind: 'ptc_lab_browser_text_evidence_error',
    ok: false,
    reasonCode: 'ptc_lab_browser_session_unavailable',
    message: 'PTC browser text evidence session is unavailable.',
    phase: 'session_acquisition',
    diagnostics: {
      sessionReasonCode: 'container_create_failed',
    },
  });
});

void test('browser_text_evidence rejects later-owner browser fields at the tool boundary', async () => {
  const result = await browserTextEvidenceTool.execute(
    { url: 'https://example.com/', screenshot: true },
    {
      callId: 'call-browser-text-evidence-screenshot',
      workspaceRoot: '/workspace/project',
      threadId: testThreadId(958),
      projectId: testProjectId('project'),
    },
  );

  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'invalid_args');
  assert.match(result.error, /screenshot/u);
});

function browserTextEvidenceSummary(): PtcBrowserTextEvidenceRuntimeSummary {
  const targetDigest =
    `sha256:${'a'.repeat(64)}` as PtcBrowserTextEvidenceRuntimeSummary['targetDigest'];
  return {
    kind: 'ptc_lab_browser_text_evidence_result',
    ok: true,
    profile: 'lab',
    capability: PTC_LAB_BROWSER_TEXT_EVIDENCE_CAPABILITY,
    targetDigest,
    textEvidenceAttemptDigest:
      `sha256:${'b'.repeat(64)}` as PtcBrowserTextEvidenceRuntimeSummary['textEvidenceAttemptDigest'],
    textEvidenceDigest:
      `sha256:${'c'.repeat(64)}` as PtcBrowserTextEvidenceRuntimeSummary['textEvidenceDigest'],
    sessionLifecycle: {
      mode: 'runtime_owned',
      retainedAfterExecution: true,
      taintedAfterExecution: false,
    },
    policyFingerprint:
      `sha256:${'d'.repeat(64)}` as PtcBrowserTextEvidenceRuntimeSummary['policyFingerprint'],
    maxNavigationMs: 15_000,
    maxTabs: 1,
    browserPolicyId: PTC_LAB_BROWSER_DOM_TEXT_EVIDENCE_POLICY_ID,
    browserMode: 'dom_text_evidence',
    browserEnginePolicyId: PTC_LAB_BROWSER_RUNTIME_ENGINE_CHROMIUM_POLICY_ID,
    browserNetworkPolicyId: PTC_LAB_OPEN_EGRESS_LOCAL_POLICY_ID,
    browserUrlGrammarPolicyId:
      PTC_LAB_BROWSER_URL_GRAMMAR_HTTP_HTTPS_NO_CREDENTIALS_POLICY_ID,
    browserRedirectPolicyId: PTC_LAB_BROWSER_REDIRECT_REVALIDATED_POLICY_ID,
    browserEvidencePolicyId: PTC_LAB_BROWSER_TEXT_EVIDENCE_SUMMARY_POLICY_ID,
    textEvidenceDigestPolicyId:
      PTC_LAB_BROWSER_TEXT_EVIDENCE_DIGEST_RESULT_WITH_TIMING_POLICY_ID,
    requestedUrlEchoPolicyId: PTC_LAB_BROWSER_URL_ECHO_DIGEST_ONLY_POLICY_ID,
    finalUrlEchoPolicyId: PTC_LAB_BROWSER_FINAL_URL_ECHO_DIGEST_ONLY_POLICY_ID,
    finalUrlDigestPolicyId:
      PTC_LAB_BROWSER_FINAL_URL_DIGEST_PUBLIC_SHA256_POLICY_ID,
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
        `sha256:${'e'.repeat(64)}` as PtcBrowserTextEvidenceRuntimeSummary['finalUrl']['digest'],
      digestPolicyId: PTC_LAB_BROWSER_FINAL_URL_DIGEST_PUBLIC_SHA256_POLICY_ID,
      echoPolicyId: PTC_LAB_BROWSER_FINAL_URL_ECHO_DIGEST_ONLY_POLICY_ID,
      redacted: true,
    },
    loadOutcome: 'loaded',
    loadState: 'domcontentloaded',
    visibleText: 'Visible page text',
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
      visibleText: 'available',
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
