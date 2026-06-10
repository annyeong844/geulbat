import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  createPtcLabBrowserDisabledPolicy,
  createPtcLabBrowserFixedNavigationProbePolicy,
  createPtcLabBrowserFixedPreflightPolicy,
  createPtcLabBrowserFixedRuntimeProbePolicy,
  PTC_LAB_BROWSER_FINAL_URL_DIGEST_PUBLIC_SHA256_POLICY_ID,
  PTC_LAB_BROWSER_FINAL_URL_ECHO_DIGEST_ONLY_POLICY_ID,
  PTC_LAB_BROWSER_PAGE_LOAD_EVIDENCE_POLICY_ID,
  PTC_LAB_BROWSER_PAGE_LOAD_EVIDENCE_SUMMARY_POLICY_ID,
  PTC_LAB_BROWSER_RESPONSE_STATUS_CODE_OPTIONAL_POLICY_ID,
  PTC_LAB_BROWSER_RUNTIME_ENGINE_CHROMIUM_POLICY_ID,
  PTC_LAB_BROWSER_TITLE_BOUNDED_TEXT_POLICY_ID,
} from './lab-browser-policy.js';
import { runPtcLabBrowserPageLoadEvidence } from './lab-browser-page-load-evidence.js';
import {
  buildPtcLabBrowserPageLoadEvidenceExecutionIdentity,
  buildPtcLabBrowserPageLoadEvidenceExecutionPolicyFields,
  buildPtcLabBrowserPageLoadEvidenceSummaryPolicyFields,
} from './lab-browser-page-load-evidence-contract.js';
import { PTC_LAB_BROWSER_PAGE_LOAD_EVIDENCE_RUNTIME_SCRIPT } from './lab-browser-page-load-evidence-runtime-script.js';
import {
  readBrowserPageLoadEvidencePolicy,
  validateBrowserPageLoadEvidenceRequest,
  validateBrowserPageLoadEvidenceRuntimeInput,
} from './lab-browser-page-load-evidence-policy.js';
import { normalizePtcLabBrowserUserUrlNavigationTarget } from './lab-browser-url-navigation.js';
import {
  PTC_LAB_OPEN_EGRESS_LOCAL_POLICY_ID,
  createPtcLabOpenEgressLocalPolicy,
} from './lab-network-policy.js';
import { admitPtcExecutionProfile } from './lab-profile.js';
import type { PtcSessionDockerPolicy } from './session-docker-contract.js';
import {
  browserPageLoadEvidenceRequest,
  browserPageLoadEvidenceStdout,
  createBrowserPageLoadEvidenceLab,
  PTC_BROWSER_PAGE_LOAD_EVIDENCE_TEST_IDENTITY,
  PTC_BROWSER_PAGE_LOAD_EVIDENCE_TEST_SUCCESS_CHECKS,
  withBrowserPageLoadEvidenceSessionManager,
} from '../../test-support/ptc-browser-page-load-evidence.js';

void test('page-load evidence runtime script stays daemon-authored and data-envelope based', () => {
  assert.match(
    PTC_LAB_BROWSER_PAGE_LOAD_EVIDENCE_RUNTIME_SCRIPT,
    /page\.goto\(input\.targetUrl/u,
  );
  assert.match(
    PTC_LAB_BROWSER_PAGE_LOAD_EVIDENCE_RUNTIME_SCRIPT,
    /require\('playwright'\)/u,
  );
  assert.match(
    PTC_LAB_BROWSER_PAGE_LOAD_EVIDENCE_RUNTIME_SCRIPT,
    /finalUrlDigest/u,
  );
  assert.doesNotMatch(
    PTC_LAB_BROWSER_PAGE_LOAD_EVIDENCE_RUNTIME_SCRIPT,
    /npm install|pip install|playwright install|userDataDir|storageState|cookieJar|cookies:/iu,
  );
  assert.doesNotMatch(
    PTC_LAB_BROWSER_PAGE_LOAD_EVIDENCE_RUNTIME_SCRIPT,
    /example\.com|access_token|id_token|secret/u,
  );
});

void test('page-load evidence contract does not own runtime script source', async () => {
  const contractSource = await readFile(
    new URL(
      '../../../src/daemon/ptc/lab-browser-page-load-evidence-contract.ts',
      import.meta.url,
    ),
    'utf8',
  );
  const runtimeScriptSource = await readFile(
    new URL(
      '../../../src/daemon/ptc/lab-browser-page-load-evidence-runtime-script.ts',
      import.meta.url,
    ),
    'utf8',
  );

  assert.doesNotMatch(
    contractSource,
    /PAGE_LOAD_EVIDENCE_RUNTIME_SCRIPT\s*=\s*String\.raw/u,
  );
  assert.match(
    runtimeScriptSource,
    /PAGE_LOAD_EVIDENCE_RUNTIME_SCRIPT\s*=\s*String\.raw/u,
  );
});

void test('readBrowserPageLoadEvidencePolicy rejects missing, wrong, and incompatible policy identities', () => {
  const missingAdmission = readBrowserPageLoadEvidencePolicy(undefined);
  assert.ok(!missingAdmission.ok);
  assert.equal(missingAdmission.reasonCode, 'ptc_lab_browser_policy_disabled');

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
      browser: createPtcLabBrowserFixedPreflightPolicy({ maxActionMs: 5000 }),
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

void test('validateBrowserPageLoadEvidenceRuntimeInput rejects malformed request and digest drift before runtime', () => {
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

  const target = normalizePtcLabBrowserUserUrlNavigationTarget(
    browserPageLoadEvidenceRequest(),
  );
  assert.ok(target.ok);
  const digestDrift = validateBrowserPageLoadEvidenceRuntimeInput({
    input: {
      target: {
        ...target.value,
        targetDigest: 'sha256:different',
      },
      timeoutMs: 1000,
    },
    maxTimeoutMs: 1000,
  });
  assert.ok(!digestDrift.ok);
  assert.equal(
    digestDrift.reasonCode,
    'ptc_lab_browser_target_digest_mismatch',
  );
});

void test('page-load evidence policy projections are derived from the browser policy owner', () => {
  const { labPolicy } = createBrowserPageLoadEvidenceLab({
    browserMaxNavigationMs: 1200,
    maxTitleChars: 64,
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
    maxTitleChars: browser.maxTitleChars,
    maxTabs: browser.maxTabs,
    evidencePolicyId: browser.evidencePolicyId,
    pageLoadEvidenceDigestPolicyId: browser.pageLoadEvidenceDigestPolicyId,
    requestedUrlEchoPolicyId: browser.requestedUrlEchoPolicyId,
    finalUrlEchoPolicyId: browser.finalUrlEchoPolicyId,
    finalUrlDigestPolicyId: browser.finalUrlDigestPolicyId,
    responseStatusPolicyId: browser.responseStatusPolicyId,
    titlePolicyId: browser.titlePolicyId,
    redirectCountPolicyId: browser.redirectCountPolicyId,
    timingPolicyId: browser.timingPolicyId,
  });

  const summaryFields =
    buildPtcLabBrowserPageLoadEvidenceSummaryPolicyFields(browser);
  assert.deepEqual(summaryFields, {
    policyFingerprint: browser.policyFingerprint,
    maxNavigationMs: browser.maxNavigationMs,
    maxTitleChars: browser.maxTitleChars,
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
    titlePolicyId: browser.titlePolicyId,
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
    maxTitleChars: 64,
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
          title: {
            text: 'Example Domain',
            charCount: 14,
            truncated: false,
            maxChars: 64,
            redacted: false,
          },
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
        assert.equal(input.maxTitleChars, 64);
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
      assert.equal(
        result.ok ? result.value.titlePolicyId : '',
        PTC_LAB_BROWSER_TITLE_BOUNDED_TEXT_POLICY_ID,
      );
      assert.equal(result.ok ? result.value.maxNavigationMs : 0, 1200);
      assert.equal(result.ok ? result.value.maxTitleChars : 0, 64);
      assert.equal(result.ok ? result.value.responseStatus?.code : 0, 404);
      assert.equal(result.ok ? result.value.title?.text : '', 'Example Domain');
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
    maxTitleChars: 64,
  });
  const secondLab = createBrowserPageLoadEvidenceLab({
    browserMaxNavigationMs: 1200,
    maxTitleChars: 80,
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
      browser: createPtcLabBrowserFixedNavigationProbePolicy({
        maxActionMs: 5000,
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
