import assert from 'node:assert/strict';
import {
  PTC_LAB_BROWSER_DOM_TEXT_EVIDENCE_POLICY_ID,
  PTC_LAB_BROWSER_FINAL_URL_DIGEST_PUBLIC_SHA256_POLICY_ID,
  PTC_LAB_BROWSER_FINAL_URL_ECHO_DIGEST_ONLY_POLICY_ID,
  PTC_LAB_BROWSER_RUNTIME_ENGINE_CHROMIUM_POLICY_ID,
  PTC_LAB_BROWSER_TEXT_EVIDENCE_SUMMARY_POLICY_ID,
} from '../core/lab-browser-policy-ids.js';
import test from 'node:test';
import { createPtcLabBrowserPageLoadEvidencePolicy } from '../core/lab-browser-policy.js';
import { normalizePtcLabBrowserUserUrlNavigationTarget } from '../core/lab-browser-url-navigation.js';
import { runPtcLabBrowserTextEvidence } from './lab-browser-text-evidence.js';
import {
  PTC_LAB_BROWSER_TEXT_EVIDENCE_CAPABILITY,
  buildPtcLabBrowserTextEvidenceExecutionIdentity,
} from './lab-browser-text-evidence-contract.js';
import {
  buildPtcLabBrowserTextEvidenceExecutionPolicyFields,
  buildPtcLabBrowserTextEvidenceSummaryPolicyFields,
} from '../core/lab-browser-policy-fields.js';
import { PTC_LAB_BROWSER_TEXT_EVIDENCE_RUNTIME_SCRIPT } from '../core/lab-browser-runtime-script.js';
import {
  readBrowserTextEvidencePolicy,
  validateBrowserTextEvidenceRequest,
} from './lab-browser-text-evidence-policy.js';
import { parseTextEvidenceStdout } from './lab-browser-text-evidence-output.js';
import {
  PTC_LAB_OPEN_EGRESS_LOCAL_POLICY_ID,
  createPtcLabOpenEgressLocalPolicy,
} from '../../network/lab-network-policy.js';
import { admitPtcExecutionProfile } from '../../profile/lab-profile.js';
import {
  browserTextEvidenceRequest,
  browserTextEvidenceStdout,
  createBrowserTextEvidenceLab,
  PTC_BROWSER_TEXT_EVIDENCE_TEST_IDENTITY,
  PTC_BROWSER_TEXT_EVIDENCE_TEST_SUCCESS_CHECKS,
  withBrowserTextEvidenceSessionManager,
} from '../../../../../test-support/ptc-browser-text-evidence.js';
import {
  PTC_BROWSER_RUNTIME_SCRIPT_FAKE_PLAYWRIGHT_MODULE,
  runPtcBrowserRuntimeScript,
} from '../../../../../test-support/ptc-browser-runtime-script.js';
import {
  collectPtcStaticImportGraph,
  ptcSourceUrl,
  readPtcStaticImportSpecifiers,
} from '../../../../../test-support/ptc-static-import-graph.js';

void test('text evidence runtime script emits a redacted evidence envelope', async () => {
  const visibleText = 'Visible evidence text '.repeat(20).trim();
  const run = await runPtcBrowserRuntimeScript({
    script: PTC_LAB_BROWSER_TEXT_EVIDENCE_RUNTIME_SCRIPT,
    input: {
      targetUrl:
        'https://example.com/private?access_token=secret#id_token=secret',
      timeoutMs: 1_000,
      loadWaitState: 'domcontentloaded',
    },
    playwrightModuleSource:
      PTC_BROWSER_RUNTIME_SCRIPT_FAKE_PLAYWRIGHT_MODULE.replace(
        "'Example visible text'",
        JSON.stringify(visibleText),
      ),
  });

  assert.equal(run.exitCode, 0);
  assert.equal(run.stderr, '');
  assert.equal(run.jsonLines.length, 1);
  const [payload] = run.jsonLines as Array<Record<string, unknown>>;
  assert.ok(payload);
  assert.equal(payload.capability, PTC_LAB_BROWSER_TEXT_EVIDENCE_CAPABILITY);
  assert.equal(payload.ok, true);
  assert.deepEqual(payload.checks, {
    engineAvailable: true,
    contextCreated: true,
    navigationStarted: true,
    navigationSettled: true,
    redirectPolicyEnforced: true,
    downloadPolicyEnforced: true,
    popupPolicyEnforced: true,
    evidenceCaptured: true,
    cleanupCompleted: true,
  });
  assert.equal(payload.loadOutcome, 'loaded');
  assert.equal(payload.loadState, 'domcontentloaded');
  assert.equal(payload.visibleText, visibleText);
  assert.equal(payload.redirectCount, 0);
  const navigationDurationMs = payload.navigationDurationMs;
  if (typeof navigationDurationMs !== 'number') {
    assert.fail('expected numeric navigationDurationMs');
  }
  assert.ok(navigationDurationMs >= 0);
  const finalUrlDigest = payload.finalUrlDigest;
  if (typeof finalUrlDigest !== 'string') {
    assert.fail('expected string finalUrlDigest');
  }
  assert.match(finalUrlDigest, /^sha256:[0-9a-f]{64}$/u);
  assert.doesNotMatch(
    JSON.stringify(run.jsonLines),
    /example\.com|access_token|id_token|secret/u,
  );
});

void test('text evidence contract does not import the runtime script owner', async () => {
  const sourceUrl = ptcSourceUrl(
    'lab/browser/text-evidence/lab-browser-text-evidence-contract.ts',
  );
  const graph = await collectPtcStaticImportGraph(sourceUrl);

  assert.equal(
    readPtcStaticImportSpecifiers(graph, sourceUrl).includes(
      '../core/lab-browser-runtime-script.js',
    ),
    false,
  );
});

void test('readBrowserTextEvidencePolicy rejects missing, wrong, and incompatible policy identities', () => {
  const missingAdmission = readBrowserTextEvidencePolicy(undefined);
  assert.ok(!missingAdmission.ok);
  assert.equal(
    missingAdmission.reasonCode,
    'ptc_lab_browser_admission_required',
  );

  const disabledNetwork = readBrowserTextEvidencePolicy(
    createBrowserTextEvidenceLab({ networkMode: 'disabled' }).admission,
  );
  assert.ok(!disabledNetwork.ok);
  assert.equal(disabledNetwork.reasonCode, 'ptc_lab_browser_network_disabled');

  const { labPolicy } = createBrowserTextEvidenceLab();
  const wrongBrowserAdmission = admitPtcExecutionProfile({
    requestedProfile: 'lab',
    labEnabled: true,
    reason: 'explicit_user_request',
    labPolicy: {
      ...labPolicy,
      browser: createPtcLabBrowserPageLoadEvidencePolicy({
        maxNavigationMs: 5000,
      }),
    },
  });
  assert.ok(wrongBrowserAdmission.ok);
  const wrongBrowser = readBrowserTextEvidencePolicy(
    wrongBrowserAdmission.value,
  );
  assert.ok(!wrongBrowser.ok);
  assert.equal(wrongBrowser.reasonCode, 'ptc_lab_browser_policy_mismatch');

  const runtimeObservedAdmission = admitPtcExecutionProfile({
    requestedProfile: 'lab',
    labEnabled: true,
    reason: 'explicit_user_request',
    labPolicy: {
      ...labPolicy,
      network: createPtcLabOpenEgressLocalPolicy({
        metricsCoverage: 'runtime_observed',
      }),
    },
  });
  assert.ok(runtimeObservedAdmission.ok);
  const incompatibleNetwork = readBrowserTextEvidencePolicy(
    runtimeObservedAdmission.value,
  );
  assert.ok(!incompatibleNetwork.ok);
  assert.equal(
    incompatibleNetwork.reasonCode,
    'ptc_lab_browser_policy_mismatch',
  );
});

void test('validateBrowserTextEvidenceRequest rejects malformed request, invalid timeout, and later-owner fields', () => {
  const nonObjectRequest = validateBrowserTextEvidenceRequest({
    request: 'https://example.com',
    maxTimeoutMs: 10_000,
  });
  assert.ok(!nonObjectRequest.ok);
  assert.equal(
    nonObjectRequest.reasonCode,
    'ptc_lab_browser_url_admission_failed',
  );

  const fractionalTimeout = validateBrowserTextEvidenceRequest({
    request: browserTextEvidenceRequest({ timeoutMs: 1.5 }),
    maxTimeoutMs: 1000,
  });
  assert.ok(!fractionalTimeout.ok);
  assert.equal(fractionalTimeout.reasonCode, 'ptc_lab_browser_request_invalid');

  const staleTextBudgetField = validateBrowserTextEvidenceRequest({
    request: { ...browserTextEvidenceRequest(), maxTextChars: 4_001 },
    maxTimeoutMs: 1000,
  });
  assert.ok(!staleTextBudgetField.ok);
  assert.equal(
    staleTextBudgetField.reasonCode,
    'ptc_lab_browser_request_invalid',
  );

  const laterOwnerField = validateBrowserTextEvidenceRequest({
    request: { ...browserTextEvidenceRequest(), screenshot: true },
    maxTimeoutMs: 10_000,
  });
  assert.ok(!laterOwnerField.ok);
  assert.equal(
    laterOwnerField.reasonCode,
    'ptc_lab_browser_url_admission_failed',
  );
});

void test('text evidence policy projections are derived from the browser policy owner', () => {
  const { labPolicy } = createBrowserTextEvidenceLab({
    browserMaxNavigationMs: 1200,
  });
  const browser = labPolicy.browser;
  if (browser.mode !== 'dom_text_evidence') {
    assert.fail('expected text evidence browser policy');
  }

  const executionFields =
    buildPtcLabBrowserTextEvidenceExecutionPolicyFields(browser);
  assert.deepEqual(executionFields, {
    policyFingerprint: browser.policyFingerprint,
    maxNavigationMs: browser.maxNavigationMs,
    maxTabs: browser.maxTabs,
    evidencePolicyId: browser.evidencePolicyId,
    textEvidenceDigestPolicyId: browser.textEvidenceDigestPolicyId,
    requestedUrlEchoPolicyId: browser.requestedUrlEchoPolicyId,
    finalUrlEchoPolicyId: browser.finalUrlEchoPolicyId,
    finalUrlDigestPolicyId: browser.finalUrlDigestPolicyId,
    redirectCountPolicyId: browser.redirectCountPolicyId,
    timingPolicyId: browser.timingPolicyId,
  });

  const summaryFields =
    buildPtcLabBrowserTextEvidenceSummaryPolicyFields(browser);
  assert.deepEqual(summaryFields, {
    policyFingerprint: browser.policyFingerprint,
    maxNavigationMs: browser.maxNavigationMs,
    maxTabs: browser.maxTabs,
    browserPolicyId: browser.browserPolicyId,
    browserMode: browser.mode,
    browserEnginePolicyId: browser.browserEnginePolicyId,
    browserNetworkPolicyId: browser.networkPolicyId,
    browserUrlGrammarPolicyId: browser.urlGrammarPolicyId,
    browserRedirectPolicyId: browser.redirectPolicyId,
    browserEvidencePolicyId: browser.evidencePolicyId,
    textEvidenceDigestPolicyId: browser.textEvidenceDigestPolicyId,
    requestedUrlEchoPolicyId: browser.requestedUrlEchoPolicyId,
    finalUrlEchoPolicyId: browser.finalUrlEchoPolicyId,
    finalUrlDigestPolicyId: browser.finalUrlDigestPolicyId,
    redirectCountPolicyId: browser.redirectCountPolicyId,
    timingPolicyId: browser.timingPolicyId,
    artifactExported: false,
  });

  assert.equal(
    browser.browserPolicyId,
    PTC_LAB_BROWSER_DOM_TEXT_EVIDENCE_POLICY_ID,
  );
  assert.equal(
    summaryFields.browserEnginePolicyId,
    PTC_LAB_BROWSER_RUNTIME_ENGINE_CHROMIUM_POLICY_ID,
  );
  assert.equal(
    summaryFields.browserNetworkPolicyId,
    PTC_LAB_OPEN_EGRESS_LOCAL_POLICY_ID,
  );
  assert.equal(
    summaryFields.browserEvidencePolicyId,
    PTC_LAB_BROWSER_TEXT_EVIDENCE_SUMMARY_POLICY_ID,
  );
  assert.equal(
    summaryFields.finalUrlDigestPolicyId,
    PTC_LAB_BROWSER_FINAL_URL_DIGEST_PUBLIC_SHA256_POLICY_ID,
  );
  assert.equal(
    summaryFields.finalUrlEchoPolicyId,
    PTC_LAB_BROWSER_FINAL_URL_ECHO_DIGEST_ONLY_POLICY_ID,
  );
});

void test('text evidence run returns text without raw URL leaks', async () => {
  const { admission, dockerPolicy } = createBrowserTextEvidenceLab();
  let observedInput:
    | {
        targetUrl: string;
        timeoutMs: number;
        loadWaitState: string;
      }
    | undefined;

  await withBrowserTextEvidenceSessionManager(
    {
      policy: dockerPolicy,
      onExec: ({ invocation, input }) => {
        observedInput = input;
        assert.deepEqual(invocation.outputBufferPolicy, {
          maxBufferedBytesPerStream:
            admission.labPolicy?.shell.maxBufferedBytesPerStream,
        });
        assert.equal(
          invocation.args.some((arg) =>
            /https?:\/\/|example\.com|access_token|id_token|secret/u.test(arg),
          ),
          false,
        );
      },
      evidenceResult: {
        kind: 'exit',
        exitCode: 0,
        stdout: browserTextEvidenceStdout({
          ok: true,
          checks: PTC_BROWSER_TEXT_EVIDENCE_TEST_SUCCESS_CHECKS,
          visibleText: 'Visible page text',
          redirectCount: 2,
          navigationDurationMs: 41,
        }),
        stderr: '',
      },
    },
    async ({ manager, runner }) => {
      const result = await runPtcLabBrowserTextEvidence({
        admission,
        identity: PTC_BROWSER_TEXT_EVIDENCE_TEST_IDENTITY,
        sessionManager: manager,
        request: browserTextEvidenceRequest({
          timeoutMs: 1000,
        }),
        now: (() => {
          let value = 100;
          return () => {
            value += 11;
            return value;
          };
        })(),
        commandRunner: runner,
      });

      assert.equal(result.ok, true);
      assert.deepEqual(observedInput, {
        targetUrl:
          'https://example.com/private?access_token=secret#id_token=secret',
        timeoutMs: 1000,
        loadWaitState: 'domcontentloaded',
      });
      assert.equal(
        result.ok ? result.value.visibleText : '',
        'Visible page text',
      );
      assert.equal(result.ok ? result.value.redirects.count : 0, 2);
      assert.equal(result.ok ? result.value.timing.ownerDurationMs : 0, 11);
      assert.equal(
        result.ok ? result.value.finalUrl.echoPolicyId : '',
        PTC_LAB_BROWSER_FINAL_URL_ECHO_DIGEST_ONLY_POLICY_ID,
      );
      assert.equal(
        JSON.stringify(result).includes(
          'https://example.com/private?access_token=secret#id_token=secret',
        ),
        false,
      );
    },
  );
});

void test('text evidence stdout parser rejects unsafe visible text values', () => {
  const parsed = parseTextEvidenceStdout({
    stdout: browserTextEvidenceStdout({
      ok: true,
      checks: PTC_BROWSER_TEXT_EVIDENCE_TEST_SUCCESS_CHECKS,
      visibleText: 'token access_token should not pass',
    }),
    targetUrl:
      'https://example.com/private?access_token=secret#id_token=secret',
  });

  assert.ok(!parsed.ok);
  assert.equal(parsed.reasonCode, 'ptc_lab_browser_evidence_output_invalid');
});

void test('text evidence stdout parser preserves visible text longer than the legacy maxChars field', () => {
  const longText = 'Visible evidence text '.repeat(20);
  const parsed = parseTextEvidenceStdout({
    stdout: browserTextEvidenceStdout({
      ok: true,
      checks: PTC_BROWSER_TEXT_EVIDENCE_TEST_SUCCESS_CHECKS,
      visibleText: longText,
    }),
    targetUrl: 'https://example.com/private',
  });

  assert.equal(parsed.ok, true);
  assert.equal(parsed.ok ? parsed.value.ok : false, true);
  assert.equal(
    parsed.ok && parsed.value.ok ? parsed.value.visibleText : '',
    longText,
  );
});

void test('text evidence attempt digest changes with runtime timeout while target digest does not', () => {
  const lab = createBrowserTextEvidenceLab();
  if (lab.labPolicy.browser.mode !== 'dom_text_evidence') {
    throw new Error('expected text evidence browser policy');
  }
  const target = normalizePtcLabBrowserUserUrlNavigationTarget(
    browserTextEvidenceRequest(),
  );
  assert.ok(target.ok);

  const first = buildPtcLabBrowserTextEvidenceExecutionIdentity({
    browser: lab.labPolicy.browser,
    effectiveTimeoutMs: 1000,
    targetDigest: target.value.targetDigest,
  });
  const second = buildPtcLabBrowserTextEvidenceExecutionIdentity({
    browser: lab.labPolicy.browser,
    effectiveTimeoutMs: 1001,
    targetDigest: target.value.targetDigest,
  });

  assert.equal(first.targetDigest, second.targetDigest);
  assert.notEqual(
    first.textEvidenceAttemptDigest,
    second.textEvidenceAttemptDigest,
  );
});
