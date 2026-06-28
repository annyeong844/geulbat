import assert from 'node:assert/strict';
import {
  PTC_LAB_BROWSER_FINAL_URL_DIGEST_PUBLIC_SHA256_POLICY_ID,
  PTC_LAB_BROWSER_FINAL_URL_ECHO_DIGEST_ONLY_POLICY_ID,
  PTC_LAB_BROWSER_PAGE_LOAD_EVIDENCE_POLICY_ID,
  PTC_LAB_BROWSER_PAGE_LOAD_EVIDENCE_SUMMARY_POLICY_ID,
  PTC_LAB_BROWSER_RESPONSE_STATUS_CODE_OPTIONAL_POLICY_ID,
  PTC_LAB_BROWSER_RUNTIME_ENGINE_CHROMIUM_POLICY_ID,
} from '../core/lab-browser-policy-ids.js';
import { access } from 'node:fs/promises';
import test from 'node:test';
import {
  createPtcLabBrowserDisabledPolicy,
  createPtcLabBrowserTextEvidencePolicy,
  createPtcLabBrowserUserUrlNavigationPolicy,
} from '../core/lab-browser-policy.js';
import { normalizePtcLabBrowserUserUrlNavigationTarget } from '../core/lab-browser-url-navigation.js';
import { runPtcLabBrowserPageLoadEvidence } from './lab-browser-page-load-evidence.js';
import {
  PTC_LAB_BROWSER_PAGE_LOAD_EVIDENCE_CAPABILITY,
  buildPtcLabBrowserPageLoadEvidenceExecutionIdentity,
} from './lab-browser-page-load-evidence-contract.js';
import {
  buildPtcLabBrowserPageLoadEvidenceExecutionPolicyFields,
  buildPtcLabBrowserPageLoadEvidenceSummaryPolicyFields,
} from '../core/lab-browser-policy-fields.js';
import { PTC_LAB_BROWSER_PAGE_LOAD_EVIDENCE_RUNTIME_SCRIPT } from '../core/lab-browser-runtime-script.js';
import {
  readBrowserPageLoadEvidencePolicy,
  validateBrowserPageLoadEvidenceRequest,
} from './lab-browser-page-load-evidence-policy.js';
import {
  PTC_LAB_OPEN_EGRESS_LOCAL_POLICY_ID,
  createPtcLabOpenEgressLocalPolicy,
} from '../../network/lab-network-policy.js';
import { admitPtcExecutionProfile } from '../../profile/lab-profile.js';
import type { PtcSessionDockerPolicy } from '../../session/session-docker-contract.js';
import {
  browserPageLoadEvidenceRequest,
  browserPageLoadEvidenceStdout,
  createBrowserPageLoadEvidenceLab,
  PTC_BROWSER_PAGE_LOAD_EVIDENCE_TEST_IDENTITY,
  PTC_BROWSER_PAGE_LOAD_EVIDENCE_TEST_SUCCESS_CHECKS,
  withBrowserPageLoadEvidenceSessionManager,
} from '../../../../../test-support/ptc-browser-page-load-evidence.js';
import {
  PTC_BROWSER_RUNTIME_SCRIPT_FAKE_PLAYWRIGHT_MODULE,
  runPtcBrowserRuntimeScript,
} from '../../../../../test-support/ptc-browser-runtime-script.js';
import {
  collectPtcStaticImportGraph,
  ptcSourceUrl,
  readPtcStaticImportSpecifiers,
} from '../../../../../test-support/ptc-static-import-graph.js';

void test('page-load evidence runtime script emits a redacted evidence envelope', async () => {
  const title = 'Long page title '.repeat(20).trim();
  const run = await runPtcBrowserRuntimeScript({
    script: PTC_LAB_BROWSER_PAGE_LOAD_EVIDENCE_RUNTIME_SCRIPT,
    input: {
      targetUrl:
        'https://example.com/private?access_token=secret#id_token=secret',
      timeoutMs: 1_000,
      loadWaitState: 'domcontentloaded',
    },
    playwrightModuleSource:
      PTC_BROWSER_RUNTIME_SCRIPT_FAKE_PLAYWRIGHT_MODULE.replace(
        "'Example Title'",
        JSON.stringify(title),
      ),
  });

  assert.equal(run.exitCode, 0);
  assert.equal(run.stderr, '');
  assert.equal(run.jsonLines.length, 1);
  const [payload] = run.jsonLines as Array<Record<string, unknown>>;
  assert.ok(payload);
  assert.equal(
    payload.capability,
    PTC_LAB_BROWSER_PAGE_LOAD_EVIDENCE_CAPABILITY,
  );
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
  assert.deepEqual(payload.responseStatus, {
    code: 204,
    source: 'final_main_resource_response',
  });
  assert.equal(payload.title, title);
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

void test('page-load evidence runtime script does not report permission policy before context creation', async () => {
  const run = await runPtcBrowserRuntimeScript({
    script: PTC_LAB_BROWSER_PAGE_LOAD_EVIDENCE_RUNTIME_SCRIPT,
    input: {
      targetUrl:
        'https://example.com/private?access_token=secret#id_token=secret',
      timeoutMs: 1_000,
      loadWaitState: 'domcontentloaded',
    },
  });

  assert.equal(run.exitCode, 3);
  assert.equal(run.stderr, '');
  assert.equal(run.jsonLines.length, 1);
  const [payload] = run.jsonLines as Array<Record<string, unknown>>;
  assert.ok(payload);
  assert.equal(payload.ok, false);
  assert.equal(payload.errorCode, 'browser_runtime_unavailable');
  assert.deepEqual(payload.checks, {
    engineAvailable: false,
    contextCreated: false,
    navigationStarted: false,
    navigationSettled: false,
    redirectPolicyEnforced: false,
    downloadPolicyEnforced: false,
    popupPolicyEnforced: false,
    evidenceCaptured: false,
    cleanupCompleted: true,
  });
});

void test('page-load evidence contract does not import the runtime script owner', async () => {
  const sourceUrl = ptcSourceUrl(
    'lab/browser/page-load-evidence/lab-browser-page-load-evidence-contract.ts',
  );
  const graph = await collectPtcStaticImportGraph(sourceUrl);

  assert.equal(
    readPtcStaticImportSpecifiers(graph, sourceUrl).includes(
      '../core/lab-browser-runtime-script.js',
    ),
    false,
  );
});

void test('readBrowserPageLoadEvidencePolicy rejects missing, wrong, and incompatible policy identities', () => {
  const missingAdmission = readBrowserPageLoadEvidencePolicy(undefined);
  assert.ok(!missingAdmission.ok);
  assert.equal(
    missingAdmission.reasonCode,
    'ptc_lab_browser_admission_required',
  );

  const disabledNetwork = readBrowserPageLoadEvidencePolicy(
    createBrowserPageLoadEvidenceLab({ networkMode: 'disabled' }).admission,
  );
  assert.ok(!disabledNetwork.ok);
  assert.equal(disabledNetwork.reasonCode, 'ptc_lab_browser_network_disabled');

  const { labPolicy } = createBrowserPageLoadEvidenceLab();
  const wrongBrowserAdmission = admitPtcExecutionProfile({
    requestedProfile: 'lab',
    labEnabled: true,
    reason: 'explicit_user_request',
    labPolicy: {
      ...labPolicy,
      browser: createPtcLabBrowserUserUrlNavigationPolicy({
        maxActionMs: 5000,
      }),
    },
  });
  assert.ok(wrongBrowserAdmission.ok);
  const wrongBrowser = readBrowserPageLoadEvidencePolicy(
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
  const incompatibleNetwork = readBrowserPageLoadEvidencePolicy(
    runtimeObservedAdmission.value,
  );
  assert.ok(!incompatibleNetwork.ok);
  assert.equal(
    incompatibleNetwork.reasonCode,
    'ptc_lab_browser_policy_mismatch',
  );
});

void test('validateBrowserPageLoadEvidenceRequest rejects malformed request and invalid timeout', () => {
  const nonObjectRequest = validateBrowserPageLoadEvidenceRequest({
    request: 'https://example.com',
    maxTimeoutMs: 10_000,
  });
  assert.ok(!nonObjectRequest.ok);
  assert.equal(
    nonObjectRequest.reasonCode,
    'ptc_lab_browser_url_admission_failed',
  );

  const fractionalTimeout = validateBrowserPageLoadEvidenceRequest({
    request: browserPageLoadEvidenceRequest({ timeoutMs: 1.5 }),
    maxTimeoutMs: 1000,
  });
  assert.ok(!fractionalTimeout.ok);
  assert.equal(fractionalTimeout.reasonCode, 'ptc_lab_browser_request_invalid');
});

void test('page-load evidence policy projections are derived from the browser policy owner', () => {
  const { labPolicy } = createBrowserPageLoadEvidenceLab({
    browserMaxNavigationMs: 1200,
  });
  const browser = labPolicy.browser;
  if (browser.mode !== 'page_load_evidence') {
    assert.fail('expected page-load evidence browser policy');
  }

  const executionFields =
    buildPtcLabBrowserPageLoadEvidenceExecutionPolicyFields(browser);
  assert.deepEqual(executionFields, {
    policyFingerprint: browser.policyFingerprint,
    maxNavigationMs: browser.maxNavigationMs,
    maxTabs: browser.maxTabs,
    evidencePolicyId: browser.evidencePolicyId,
    pageLoadEvidenceDigestPolicyId: browser.pageLoadEvidenceDigestPolicyId,
    requestedUrlEchoPolicyId: browser.requestedUrlEchoPolicyId,
    finalUrlEchoPolicyId: browser.finalUrlEchoPolicyId,
    finalUrlDigestPolicyId: browser.finalUrlDigestPolicyId,
    responseStatusPolicyId: browser.responseStatusPolicyId,
    redirectCountPolicyId: browser.redirectCountPolicyId,
    timingPolicyId: browser.timingPolicyId,
  });

  const summaryFields =
    buildPtcLabBrowserPageLoadEvidenceSummaryPolicyFields(browser);
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
    pageLoadEvidenceDigestPolicyId: browser.pageLoadEvidenceDigestPolicyId,
    requestedUrlEchoPolicyId: browser.requestedUrlEchoPolicyId,
    finalUrlEchoPolicyId: browser.finalUrlEchoPolicyId,
    finalUrlDigestPolicyId: browser.finalUrlDigestPolicyId,
    responseStatusPolicyId: browser.responseStatusPolicyId,
    redirectCountPolicyId: browser.redirectCountPolicyId,
    timingPolicyId: browser.timingPolicyId,
    artifactExported: false,
  });
  assert.equal(summaryFields.browserEvidencePolicyId, browser.evidencePolicyId);
  assert.equal(executionFields.evidencePolicyId, browser.evidencePolicyId);
});

void test('runPtcLabBrowserPageLoadEvidence rejects invalid admission before session acquisition', async () => {
  const { admission } = createBrowserPageLoadEvidenceLab();
  const cases = [
    {
      name: 'invalid timeout',
      request: browserPageLoadEvidenceRequest({ timeoutMs: 0 }),
      reasonCode: 'ptc_lab_browser_request_invalid',
    },
    {
      name: 'malformed URL',
      request: browserPageLoadEvidenceRequest({ url: 'example.com' }),
      reasonCode: 'ptc_lab_browser_url_admission_failed',
    },
    {
      name: 'later evidence field',
      request: {
        ...browserPageLoadEvidenceRequest(),
        screenshot: true,
      },
      reasonCode: 'ptc_lab_browser_url_admission_failed',
    },
  ];

  for (const item of cases) {
    await withBrowserPageLoadEvidenceSessionManager(
      {},
      async ({ manager, runner, invocations }) => {
        const result = await runPtcLabBrowserPageLoadEvidence({
          admission,
          identity: PTC_BROWSER_PAGE_LOAD_EVIDENCE_TEST_IDENTITY,
          sessionManager: manager,
          request: item.request,
          commandRunner: runner,
        });

        assert.equal(result.ok, false, item.name);
        assert.equal(result.ok ? '' : result.reasonCode, item.reasonCode);
        assert.deepEqual(invocations, []);
        assert.doesNotMatch(
          JSON.stringify(result),
          /example\.com|access_token|id_token|secret/u,
        );
      },
    );
  }
});

void test('runPtcLabBrowserPageLoadEvidence returns compact evidence without URL or session leaks', async () => {
  const { admission, dockerPolicy } = createBrowserPageLoadEvidenceLab({
    browserMaxNavigationMs: 1200,
  });
  let inputHostPath = '';

  await withBrowserPageLoadEvidenceSessionManager(
    {
      policy: dockerPolicy,
      evidenceResult: {
        kind: 'exit',
        exitCode: 0,
        stdout: browserPageLoadEvidenceStdout({
          ok: true,
          checks: PTC_BROWSER_PAGE_LOAD_EVIDENCE_TEST_SUCCESS_CHECKS,
          statusCode: 404,
          title: 'Example Domain',
          redirectCount: 2,
          navigationDurationMs: 37,
        }),
        stderr:
          '/tmp/geulbat-private/.geulbat https://example.com/private?access_token=secret#id_token=secret',
      },
      onExec: ({ invocation, input, inputHostPath: nextInputHostPath }) => {
        inputHostPath = nextInputHostPath;
        assert.equal(
          input.targetUrl,
          'https://example.com/private?access_token=secret#id_token=secret',
        );
        assert.equal(input.timeoutMs, 1000);
        assert.equal(input.loadWaitState, 'domcontentloaded');
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
    },
    async ({ manager, runner, invocations, runtimeRoot }) => {
      const result = await runPtcLabBrowserPageLoadEvidence({
        admission,
        identity: PTC_BROWSER_PAGE_LOAD_EVIDENCE_TEST_IDENTITY,
        sessionManager: manager,
        request: browserPageLoadEvidenceRequest({ timeoutMs: 1000 }),
        now: (() => {
          let value = 300;
          return () => {
            value += 23;
            return value;
          };
        })(),
        commandRunner: runner,
      });

      assert.equal(result.ok, true);
      assert.equal(
        result.ok ? result.value.kind : '',
        'ptc_lab_browser_page_load_evidence_result',
      );
      assert.equal(
        result.ok ? result.value.browserPolicyId : '',
        PTC_LAB_BROWSER_PAGE_LOAD_EVIDENCE_POLICY_ID,
      );
      assert.equal(
        result.ok ? result.value.browserEnginePolicyId : '',
        PTC_LAB_BROWSER_RUNTIME_ENGINE_CHROMIUM_POLICY_ID,
      );
      assert.equal(
        result.ok ? result.value.browserNetworkPolicyId : '',
        PTC_LAB_OPEN_EGRESS_LOCAL_POLICY_ID,
      );
      assert.equal(
        result.ok ? result.value.browserEvidencePolicyId : '',
        PTC_LAB_BROWSER_PAGE_LOAD_EVIDENCE_SUMMARY_POLICY_ID,
      );
      assert.equal(
        result.ok ? result.value.finalUrlEchoPolicyId : '',
        PTC_LAB_BROWSER_FINAL_URL_ECHO_DIGEST_ONLY_POLICY_ID,
      );
      assert.equal(
        result.ok ? result.value.finalUrlDigestPolicyId : '',
        PTC_LAB_BROWSER_FINAL_URL_DIGEST_PUBLIC_SHA256_POLICY_ID,
      );
      assert.equal(
        result.ok ? result.value.responseStatusPolicyId : '',
        PTC_LAB_BROWSER_RESPONSE_STATUS_CODE_OPTIONAL_POLICY_ID,
      );
      assert.equal(result.ok ? result.value.maxNavigationMs : 0, 1200);
      assert.equal(result.ok ? result.value.responseStatus?.code : 0, 404);
      assert.equal(result.ok ? result.value.title : '', 'Example Domain');
      assert.deepEqual(
        result.ok ? result.value.evidenceAvailability : undefined,
        {
          finalUrl: 'available',
          navigationTiming: 'available',
          responseStatus: 'available',
          title: 'available',
        },
      );
      assert.equal(result.ok ? result.value.redirects.count : -1, 2);
      assert.equal(result.ok ? result.value.timing.ownerDurationMs : 0, 23);
      assert.equal(
        result.ok ? result.value.timing.navigationDurationMs : 0,
        37,
      );
      assert.equal(
        result.ok ? result.value.requestedUrl.redacted : false,
        true,
      );
      assert.equal(result.ok ? result.value.finalUrl.redacted : false, true);
      assert.match(
        result.ok ? result.value.targetDigest : '',
        /^sha256:[0-9a-f]{64}$/u,
      );
      assert.match(
        result.ok ? result.value.pageLoadEvidenceAttemptDigest : '',
        /^sha256:[0-9a-f]{64}$/u,
      );
      assert.match(
        result.ok ? result.value.pageLoadEvidenceDigest : '',
        /^sha256:[0-9a-f]{64}$/u,
      );
      assert.deepEqual(result.ok ? result.value.checks : undefined, {
        targetVerified: true,
        ...PTC_BROWSER_PAGE_LOAD_EVIDENCE_TEST_SUCCESS_CHECKS,
      });
      assert.equal(
        Object.hasOwn(result.ok ? result.value : {}, 'labSessionId'),
        false,
      );
      assert.equal(
        Object.hasOwn(result.ok ? result.value : {}, 'containerId'),
        false,
      );
      assert.equal(
        Object.hasOwn(result.ok ? result.value : {}, 'requestedUrlEcho'),
        false,
      );
      assert.equal(
        Object.hasOwn(result.ok ? result.value : {}, 'finalUrlEcho'),
        false,
      );

      const createInvocation = invocations.find(
        (invocation) => invocation.args[0] === 'create',
      );
      assert.ok(createInvocation);
      assert.equal(
        createInvocation.args.includes(
          `geulbat.browserPolicyId=${PTC_LAB_BROWSER_PAGE_LOAD_EVIDENCE_POLICY_ID}`,
        ),
        true,
      );
      assert.equal(
        createInvocation.args.some((arg) =>
          /https?:\/\/|example\.com|access_token|id_token|secret/u.test(arg),
        ),
        false,
      );
      await assert.rejects(() => access(inputHostPath));

      const serialized = JSON.stringify(result);
      assert.doesNotMatch(
        serialized,
        /https?:\/\/|example\.com|access_token|id_token|secret|responseHeaders|<html|browserConsole|downloadPath|downloadUrl|screenshot|userDataDir/iu,
      );
      assert.equal(serialized.includes(runtimeRoot), false);
    },
  );
});

void test('page-load evidence attempt digest changes with runtime evidence policy while target digest does not', () => {
  const firstLab = createBrowserPageLoadEvidenceLab({
    browserMaxNavigationMs: 1200,
  });
  const secondLab = createBrowserPageLoadEvidenceLab({
    browserMaxNavigationMs: 1300,
  });
  if (
    !firstLab.labPolicy.browser.enabled ||
    firstLab.labPolicy.browser.mode !== 'page_load_evidence' ||
    !secondLab.labPolicy.browser.enabled ||
    secondLab.labPolicy.browser.mode !== 'page_load_evidence'
  ) {
    throw new Error('expected page-load evidence browser policies');
  }
  const target = normalizePtcLabBrowserUserUrlNavigationTarget(
    browserPageLoadEvidenceRequest(),
  );
  assert.equal(target.ok, true);

  const first = buildPtcLabBrowserPageLoadEvidenceExecutionIdentity({
    browser: firstLab.labPolicy.browser,
    effectiveTimeoutMs: 1000,
    targetDigest: target.value.targetDigest,
  });
  const second = buildPtcLabBrowserPageLoadEvidenceExecutionIdentity({
    browser: secondLab.labPolicy.browser,
    effectiveTimeoutMs: 1000,
    targetDigest: target.value.targetDigest,
  });

  assert.equal(first.targetDigest, second.targetDigest);
  assert.notEqual(
    first.pageLoadEvidenceAttemptDigest,
    second.pageLoadEvidenceAttemptDigest,
  );
});

void test('runPtcLabBrowserPageLoadEvidence rejects non-evidence browser sessions before exec', async () => {
  const { admission, dockerPolicy } = createBrowserPageLoadEvidenceLab();
  const policies: PtcSessionDockerPolicy[] = [
    {
      ...dockerPolicy,
      browser: createPtcLabBrowserUserUrlNavigationPolicy({
        maxActionMs: 5000,
      }),
    },
    {
      ...dockerPolicy,
      browser: createPtcLabBrowserTextEvidencePolicy({
        maxNavigationMs: 5000,
      }),
    },
    { ...dockerPolicy, browser: createPtcLabBrowserDisabledPolicy() },
  ];

  for (const policy of policies) {
    await withBrowserPageLoadEvidenceSessionManager(
      { policy },
      async ({ manager, runner, invocations }) => {
        const result = await runPtcLabBrowserPageLoadEvidence({
          admission,
          identity: PTC_BROWSER_PAGE_LOAD_EVIDENCE_TEST_IDENTITY,
          sessionManager: manager,
          request: browserPageLoadEvidenceRequest(),
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
