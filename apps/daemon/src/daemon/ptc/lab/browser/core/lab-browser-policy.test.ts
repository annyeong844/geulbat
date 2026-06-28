import assert from 'node:assert/strict';
import test from 'node:test';
import {
  PTC_LAB_BROWSER_ARTIFACT_EXPORT_DISABLED_POLICY_ID,
  PTC_LAB_BROWSER_COOKIE_STORE_NONE_POLICY_ID,
  PTC_LAB_BROWSER_DISABLED_POLICY_ID,
  PTC_LAB_BROWSER_FINAL_URL_DIGEST_PUBLIC_SHA256_POLICY_ID,
  PTC_LAB_BROWSER_FINAL_URL_ECHO_DIGEST_ONLY_POLICY_ID,
  PTC_LAB_BROWSER_PAGE_LOAD_EVIDENCE_POLICY_ID,
  PTC_LAB_BROWSER_PAGE_LOAD_EVIDENCE_SUMMARY_POLICY_ID,
  PTC_LAB_BROWSER_PROFILE_NONE_POLICY_ID,
  PTC_LAB_BROWSER_RESPONSE_STATUS_CODE_OPTIONAL_POLICY_ID,
  PTC_LAB_BROWSER_RUNTIME_ENGINE_CHROMIUM_POLICY_ID,
  PTC_LAB_BROWSER_TELEMETRY_DISABLED_POLICY_ID,
} from './lab-browser-policy-ids.js';
import {
  PTC_LAB_OPEN_EGRESS_LOCAL_POLICY_ID,
  createPtcLabNetworkDisabledPolicy,
  createPtcLabOpenEgressLocalPolicy,
  toPtcLabNetworkIdentitySnapshot,
} from '../../network/lab-network-policy.js';
import {
  buildPtcLabBrowserIdentityLabels,
  validatePtcLabBrowserSessionPolicy,
  toPtcLabBrowserIdentitySnapshot,
} from './lab-browser-identity.js';
import {
  createPtcLabBrowserDisabledPolicy,
  createPtcLabBrowserPageLoadEvidencePolicy,
  createPtcLabBrowserUserUrlNavigationPolicy,
} from './lab-browser-policy.js';

void test('createPtcLabBrowserDisabledPolicy keeps browser authority off by default', () => {
  const policy = createPtcLabBrowserDisabledPolicy();

  assert.deepEqual(policy, {
    enabled: false,
    mode: 'disabled',
    policyVersion: 'ptc_lab_browser_policy_v1',
    browserPolicyId: PTC_LAB_BROWSER_DISABLED_POLICY_ID,
    profilePolicyId: PTC_LAB_BROWSER_PROFILE_NONE_POLICY_ID,
    cookieStorePolicyId: PTC_LAB_BROWSER_COOKIE_STORE_NONE_POLICY_ID,
    artifactExportPolicyId: PTC_LAB_BROWSER_ARTIFACT_EXPORT_DISABLED_POLICY_ID,
    telemetryPolicyId: PTC_LAB_BROWSER_TELEMETRY_DISABLED_POLICY_ID,
  });
  assert.deepEqual(toPtcLabBrowserIdentitySnapshot(policy), {
    enabled: false,
    mode: 'disabled',
    browserPolicyId: PTC_LAB_BROWSER_DISABLED_POLICY_ID,
    profilePolicyId: PTC_LAB_BROWSER_PROFILE_NONE_POLICY_ID,
    cookieStorePolicyId: PTC_LAB_BROWSER_COOKIE_STORE_NONE_POLICY_ID,
    artifactExportPolicyId: PTC_LAB_BROWSER_ARTIFACT_EXPORT_DISABLED_POLICY_ID,
    browserTelemetryPolicyId: PTC_LAB_BROWSER_TELEMETRY_DISABLED_POLICY_ID,
  });
});

void test('buildPtcLabBrowserIdentityLabels projects only policy identity, not browser state', () => {
  const policy = createPtcLabBrowserUserUrlNavigationPolicy({
    maxActionMs: 1200,
  });
  const labels = buildPtcLabBrowserIdentityLabels(
    toPtcLabBrowserIdentitySnapshot(policy),
  );
  if (!policy.enabled || policy.mode !== 'user_url_navigation') {
    throw new Error('expected user URL navigation browser policy');
  }

  assert.equal(
    labels.includes(`geulbat.browserPolicyId=${policy.browserPolicyId}`),
    true,
  );
  assert.equal(
    labels.includes(`geulbat.browserProfilePolicyId=${policy.profilePolicyId}`),
    true,
  );
  assert.equal(
    labels.includes(
      `geulbat.browserCookieStorePolicyId=${policy.cookieStorePolicyId}`,
    ),
    true,
  );
  assert.equal(
    labels.includes(
      `geulbat.browserEnginePolicyId=${policy.browserEnginePolicyId}`,
    ),
    true,
  );
  assert.equal(
    labels.includes(
      `geulbat.browserUrlGrammarPolicyId=${policy.urlGrammarPolicyId}`,
    ),
    true,
  );
  assert.equal(
    labels.includes(
      `geulbat.browserRedirectPolicyId=${policy.redirectPolicyId}`,
    ),
    true,
  );
  assert.equal(
    labels.includes(
      `geulbat.browserEvidencePolicyId=${policy.evidencePolicyId}`,
    ),
    true,
  );
  assert.equal(
    labels.some((label) => /cookie=|profile=|https?:\/\//iu.test(label)),
    false,
  );
});

void test('createPtcLabBrowserPageLoadEvidencePolicy includes evidence budgets in identity', () => {
  const policy = createPtcLabBrowserPageLoadEvidencePolicy({
    maxNavigationMs: 1400,
  });
  if (!policy.enabled || policy.mode !== 'page_load_evidence') {
    throw new Error('expected page-load evidence browser policy');
  }

  assert.equal(
    policy.browserPolicyId,
    PTC_LAB_BROWSER_PAGE_LOAD_EVIDENCE_POLICY_ID,
  );
  assert.equal(
    policy.browserEnginePolicyId,
    PTC_LAB_BROWSER_RUNTIME_ENGINE_CHROMIUM_POLICY_ID,
  );
  assert.equal(policy.maxNavigationMs, 1400);
  assert.match(policy.policyFingerprint, /^sha256:[0-9a-f]{64}$/u);
  assert.equal(
    policy.evidencePolicyId,
    PTC_LAB_BROWSER_PAGE_LOAD_EVIDENCE_SUMMARY_POLICY_ID,
  );
  assert.equal(
    policy.finalUrlEchoPolicyId,
    PTC_LAB_BROWSER_FINAL_URL_ECHO_DIGEST_ONLY_POLICY_ID,
  );
  assert.equal(
    policy.finalUrlDigestPolicyId,
    PTC_LAB_BROWSER_FINAL_URL_DIGEST_PUBLIC_SHA256_POLICY_ID,
  );
  assert.equal(
    policy.responseStatusPolicyId,
    PTC_LAB_BROWSER_RESPONSE_STATUS_CODE_OPTIONAL_POLICY_ID,
  );
  assert.deepEqual(toPtcLabBrowserIdentitySnapshot(policy), {
    enabled: true,
    mode: 'page_load_evidence',
    browserPolicyId: PTC_LAB_BROWSER_PAGE_LOAD_EVIDENCE_POLICY_ID,
    policyFingerprint: policy.policyFingerprint,
    browserEnginePolicyId: PTC_LAB_BROWSER_RUNTIME_ENGINE_CHROMIUM_POLICY_ID,
    networkPolicyId: PTC_LAB_OPEN_EGRESS_LOCAL_POLICY_ID,
    urlGrammarPolicyId: policy.urlGrammarPolicyId,
    callerHeadersPolicyId: policy.callerHeadersPolicyId,
    browserHeadersPolicyId: policy.browserHeadersPolicyId,
    bodyPolicyId: policy.bodyPolicyId,
    redirectPolicyId: policy.redirectPolicyId,
    maxTabs: 1,
    maxNavigationMs: 1400,
    profilePolicyId: policy.profilePolicyId,
    cookieStorePolicyId: policy.cookieStorePolicyId,
    downloadPolicyId: policy.downloadPolicyId,
    artifactExportPolicyId: policy.artifactExportPolicyId,
    browserTelemetryPolicyId: policy.telemetryPolicyId,
    evidencePolicyId: PTC_LAB_BROWSER_PAGE_LOAD_EVIDENCE_SUMMARY_POLICY_ID,
    pageLoadEvidenceDigestPolicyId: policy.pageLoadEvidenceDigestPolicyId,
    requestedUrlEchoPolicyId: policy.requestedUrlEchoPolicyId,
    finalUrlEchoPolicyId: PTC_LAB_BROWSER_FINAL_URL_ECHO_DIGEST_ONLY_POLICY_ID,
    finalUrlDigestPolicyId:
      PTC_LAB_BROWSER_FINAL_URL_DIGEST_PUBLIC_SHA256_POLICY_ID,
    responseStatusPolicyId:
      PTC_LAB_BROWSER_RESPONSE_STATUS_CODE_OPTIONAL_POLICY_ID,
    redirectCountPolicyId: policy.redirectCountPolicyId,
    timingPolicyId: policy.timingPolicyId,
    popupPolicyId: policy.popupPolicyId,
    permissionPolicyId: policy.permissionPolicyId,
    timeoutPolicyId: policy.timeoutPolicyId,
    loadWaitPolicyId: policy.loadWaitPolicyId,
    viewportPolicyId: policy.viewportPolicyId,
    localePolicyId: policy.localePolicyId,
    timezonePolicyId: policy.timezonePolicyId,
  });

  const labels = buildPtcLabBrowserIdentityLabels(
    toPtcLabBrowserIdentitySnapshot(policy),
  );
  const labelSet = new Set(labels);
  assert.equal(
    labelSet.has(`geulbat.browserPolicyId=${policy.browserPolicyId}`),
    true,
  );
  assert.equal(
    labelSet.has(
      `geulbat.browserPolicyFingerprint=${policy.policyFingerprint}`,
    ),
    true,
  );
  for (const expectedLabel of [
    `geulbat.browserMaxNavigationMs=${policy.maxNavigationMs}`,
    `geulbat.browserPageLoadEvidenceDigestPolicyId=${policy.pageLoadEvidenceDigestPolicyId}`,
    `geulbat.browserRequestedUrlEchoPolicyId=${policy.requestedUrlEchoPolicyId}`,
    `geulbat.browserFinalUrlEchoPolicyId=${policy.finalUrlEchoPolicyId}`,
    `geulbat.browserFinalUrlDigestPolicyId=${policy.finalUrlDigestPolicyId}`,
    `geulbat.browserResponseStatusPolicyId=${policy.responseStatusPolicyId}`,
    `geulbat.browserRedirectCountPolicyId=${policy.redirectCountPolicyId}`,
    `geulbat.browserTimingPolicyId=${policy.timingPolicyId}`,
  ]) {
    assert.equal(labelSet.has(expectedLabel), true, expectedLabel);
  }
  assert.equal(
    labels.some((label) =>
      /https?:\/\/|example\.com|access_token|id_token|secret/iu.test(label),
    ),
    false,
  );
});

void test('toPtcLabBrowserIdentitySnapshot preserves effective policy fields except documented projections', () => {
  const policies = [
    createPtcLabBrowserDisabledPolicy(),
    createPtcLabBrowserUserUrlNavigationPolicy({ maxActionMs: 1500 }),
    createPtcLabBrowserPageLoadEvidencePolicy({
      maxNavigationMs: 1600,
    }),
  ];

  for (const policy of policies) {
    const snapshot = toPtcLabBrowserIdentitySnapshot(policy);
    const policyRecord = policy as unknown as Record<string, unknown>;
    const snapshotRecord = snapshot as unknown as Record<string, unknown>;
    const expectedKeys = new Set(Object.keys(policyRecord));

    expectedKeys.delete('policyVersion');
    expectedKeys.delete('telemetryPolicyId');
    expectedKeys.add('browserTelemetryPolicyId');

    assert.equal(Object.hasOwn(snapshotRecord, 'policyVersion'), false);
    assert.equal(Object.hasOwn(snapshotRecord, 'telemetryPolicyId'), false);
    assert.equal(
      snapshotRecord.browserTelemetryPolicyId,
      policyRecord.telemetryPolicyId,
      `${policy.mode}.telemetryPolicyId projection`,
    );
    assert.deepEqual(
      Object.keys(snapshotRecord).sort(),
      [...expectedKeys].sort(),
      policy.mode,
    );

    for (const [key, value] of Object.entries(policyRecord)) {
      if (key === 'policyVersion' || key === 'telemetryPolicyId') {
        continue;
      }
      assert.deepEqual(snapshotRecord[key], value, `${policy.mode}.${key}`);
    }
  }
});

void test('validatePtcLabBrowserSessionPolicy rejects network and browser identity drift', () => {
  const policyId = 'ptc_lab_session_policy_for_test_v1';
  const networkPolicy = createPtcLabOpenEgressLocalPolicy();
  if (networkPolicy.mode !== 'open') {
    throw new Error('expected open network policy');
  }
  const differentExplicitOptInNetwork = createPtcLabOpenEgressLocalPolicy({
    explicitOptInPolicyId: 'different_explicit_opt_in_v1',
  });
  if (differentExplicitOptInNetwork.mode !== 'open') {
    throw new Error('expected open network policy');
  }
  const browserPolicy = createPtcLabBrowserPageLoadEvidencePolicy({
    maxNavigationMs: 1600,
  });
  const browserIdentity = toPtcLabBrowserIdentitySnapshot(browserPolicy);
  if (browserIdentity.mode !== 'page_load_evidence') {
    throw new Error('expected page-load evidence browser identity');
  }

  const handle = {
    reuseKey: {
      labPolicyId: policyId,
      network: toPtcLabNetworkIdentitySnapshot(networkPolicy),
      browser: browserIdentity,
    },
  };

  assert.deepEqual(
    validatePtcLabBrowserSessionPolicy({
      handle,
      policyId,
      browser: browserPolicy,
      network: networkPolicy,
      capabilityLabel: 'page-load evidence',
    }),
    { ok: true, value: undefined },
  );
  assert.equal(
    validatePtcLabBrowserSessionPolicy({
      handle,
      policyId: 'different_lab_policy_v1',
      browser: browserPolicy,
      network: networkPolicy,
      capabilityLabel: 'page-load evidence',
    }).ok,
    false,
  );
  assert.equal(
    validatePtcLabBrowserSessionPolicy({
      handle: {
        reuseKey: {
          ...handle.reuseKey,
          network: toPtcLabNetworkIdentitySnapshot(
            createPtcLabNetworkDisabledPolicy(),
          ),
        },
      },
      policyId,
      browser: browserPolicy,
      network: networkPolicy,
      capabilityLabel: 'page-load evidence',
    }).ok,
    false,
  );
  assert.equal(
    validatePtcLabBrowserSessionPolicy({
      handle,
      policyId,
      browser: browserPolicy,
      network: differentExplicitOptInNetwork,
      capabilityLabel: 'page-load evidence',
    }).ok,
    false,
  );
  assert.equal(
    validatePtcLabBrowserSessionPolicy({
      handle: {
        reuseKey: {
          ...handle.reuseKey,
          browser: {
            ...browserIdentity,
            policyFingerprint:
              'sha256:1111111111111111111111111111111111111111111111111111111111111111',
          },
        },
      },
      policyId,
      browser: browserPolicy,
      network: networkPolicy,
      capabilityLabel: 'page-load evidence',
    }).ok,
    false,
  );
});

void test('validatePtcLabBrowserSessionPolicy returns one canonical mismatch envelope for identity drift', () => {
  const policyId = 'ptc_lab_session_policy_for_test_v1';
  const networkPolicy = createPtcLabOpenEgressLocalPolicy();
  if (networkPolicy.mode !== 'open') {
    throw new Error('expected open network policy');
  }
  const browserPolicy = createPtcLabBrowserPageLoadEvidencePolicy({
    maxNavigationMs: 1600,
  });
  const browserIdentity = toPtcLabBrowserIdentitySnapshot(browserPolicy);
  if (browserIdentity.mode !== 'page_load_evidence') {
    throw new Error('expected page-load evidence browser identity');
  }

  const matching = validatePtcLabBrowserSessionPolicy({
    handle: {
      reuseKey: {
        labPolicyId: policyId,
        network: toPtcLabNetworkIdentitySnapshot(networkPolicy),
        browser: browserIdentity,
      },
    },
    policyId,
    browser: browserPolicy,
    network: networkPolicy,
    capabilityLabel: 'page-load evidence',
  });
  assert.deepEqual(matching, { ok: true, value: undefined });

  const drifted = validatePtcLabBrowserSessionPolicy({
    handle: {
      reuseKey: {
        labPolicyId: policyId,
        network: toPtcLabNetworkIdentitySnapshot(networkPolicy),
        browser: {
          ...browserIdentity,
          policyFingerprint:
            'sha256:1111111111111111111111111111111111111111111111111111111111111111',
        },
      },
    },
    policyId,
    browser: browserPolicy,
    network: networkPolicy,
    capabilityLabel: 'page-load evidence',
  });
  assert.deepEqual(drifted, {
    ok: false,
    reasonCode: 'ptc_lab_browser_policy_mismatch',
    message:
      'PTC lab browser page-load evidence session does not match admitted policy',
  });
});

void test('browser policy creation rejects invalid runtime timeout budgets', () => {
  assert.throws(
    () => createPtcLabBrowserUserUrlNavigationPolicy({ maxActionMs: 1.5 }),
    /user URL navigation maxActionMs is invalid/u,
  );
});
