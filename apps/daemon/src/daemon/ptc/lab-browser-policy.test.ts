import assert from 'node:assert/strict';
import test from 'node:test';
import {
  PTC_LAB_OPEN_EGRESS_LOCAL_POLICY_ID,
  createPtcLabNetworkDisabledPolicy,
  createPtcLabOpenEgressLocalPolicy,
  toPtcLabNetworkIdentitySnapshot,
} from './lab-network-policy.js';
import {
  buildPtcLabBrowserLabels,
  createPtcLabBrowserDisabledPolicy,
  createPtcLabBrowserFixedNavigationProbePolicy,
  createPtcLabBrowserFixedPreflightPolicy,
  createPtcLabBrowserFixedRuntimeProbePolicy,
  createPtcLabBrowserPageLoadEvidencePolicy,
  createPtcLabBrowserUserUrlNavigationPolicy,
  doesPtcLabBrowserSessionMatchPolicy,
  hasOnlyPtcLabBrowserRequestKeys,
  isPtcLabBrowserSafeProbeId,
  validatePtcLabBrowserSessionPolicy,
  PTC_LAB_BROWSER_ARTIFACT_EXPORT_DISABLED_POLICY_ID,
  PTC_LAB_BROWSER_COOKIE_STORE_NONE_POLICY_ID,
  PTC_LAB_BROWSER_DISABLED_POLICY_ID,
  PTC_LAB_BROWSER_FINAL_URL_DIGEST_PUBLIC_SHA256_POLICY_ID,
  PTC_LAB_BROWSER_FINAL_URL_ECHO_DIGEST_ONLY_POLICY_ID,
  PTC_LAB_BROWSER_FIXED_NAVIGATION_PROBE_POLICY_ID,
  PTC_LAB_BROWSER_FIXED_PREFLIGHT_POLICY_ID,
  PTC_LAB_BROWSER_FIXED_RUNTIME_PROBE_POLICY_ID,
  PTC_LAB_BROWSER_NAVIGATION_SUMMARY_ONLY_POLICY_ID,
  PTC_LAB_BROWSER_NAVIGATION_TARGET_FIXED_HTTPS_POLICY_ID,
  PTC_LAB_BROWSER_PAGE_LOAD_EVIDENCE_POLICY_ID,
  PTC_LAB_BROWSER_PAGE_LOAD_EVIDENCE_SUMMARY_POLICY_ID,
  PTC_LAB_BROWSER_PROFILE_NONE_POLICY_ID,
  PTC_LAB_BROWSER_REDIRECT_DISABLED_POLICY_ID,
  PTC_LAB_BROWSER_RESPONSE_STATUS_CODE_OPTIONAL_POLICY_ID,
  PTC_LAB_BROWSER_RUNTIME_ENGINE_CHROMIUM_POLICY_ID,
  PTC_LAB_BROWSER_TELEMETRY_DISABLED_POLICY_ID,
  PTC_LAB_BROWSER_TELEMETRY_OWNER_OUTCOME_POLICY_ID,
  PTC_LAB_BROWSER_TITLE_BOUNDED_TEXT_POLICY_ID,
  PTC_LAB_BROWSER_URL_GRAMMAR_POLICY_OWNED_TARGET_REF_POLICY_ID,
  toPtcLabBrowserIdentitySnapshot,
} from './lab-browser-policy.js';

void test('isPtcLabBrowserSafeProbeId accepts only bounded ASCII probe ids with an alnum prefix', () => {
  assert.equal(isPtcLabBrowserSafeProbeId('probe-1_ok'), true);
  assert.equal(isPtcLabBrowserSafeProbeId('a'.repeat(64)), true);

  for (const value of [
    '',
    '-probe',
    '_probe',
    'a'.repeat(65),
    'probe id',
    'probe/id',
    'probe.id',
    '프로브',
  ]) {
    assert.equal(isPtcLabBrowserSafeProbeId(value), false, value);
  }
});

void test('hasOnlyPtcLabBrowserRequestKeys rejects browser capability fields owned by later slices', () => {
  const preflightKeys = new Set(['probeId', 'timeoutMs']);

  assert.equal(
    hasOnlyPtcLabBrowserRequestKeys(
      { probeId: 'probe-1', timeoutMs: 1000 },
      preflightKeys,
    ),
    true,
  );
  assert.equal(
    hasOnlyPtcLabBrowserRequestKeys(
      {
        probeId: 'probe-1',
        timeoutMs: 1000,
        url: 'https://example.com/private',
      },
      preflightKeys,
    ),
    false,
  );
  assert.equal(hasOnlyPtcLabBrowserRequestKeys({}, preflightKeys), true);
});

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

void test('createPtcLabBrowserFixedPreflightPolicy is explicit and summary-only', () => {
  const policy = createPtcLabBrowserFixedPreflightPolicy({ maxActionMs: 1200 });

  assert.equal(policy.enabled, true);
  assert.equal(policy.mode, 'fixed_preflight');
  assert.equal(
    policy.browserPolicyId,
    PTC_LAB_BROWSER_FIXED_PREFLIGHT_POLICY_ID,
  );
  assert.equal(policy.networkPolicyId, PTC_LAB_OPEN_EGRESS_LOCAL_POLICY_ID);
  assert.equal(policy.maxTabs, 1);
  assert.equal(policy.maxActionMs, 1200);
  assert.equal(policy.profilePolicyId, PTC_LAB_BROWSER_PROFILE_NONE_POLICY_ID);
  assert.equal(
    policy.cookieStorePolicyId,
    PTC_LAB_BROWSER_COOKIE_STORE_NONE_POLICY_ID,
  );
  assert.equal(
    policy.artifactExportPolicyId,
    PTC_LAB_BROWSER_ARTIFACT_EXPORT_DISABLED_POLICY_ID,
  );
  assert.equal(
    policy.telemetryPolicyId,
    PTC_LAB_BROWSER_TELEMETRY_OWNER_OUTCOME_POLICY_ID,
  );
  assert.equal(policy.outputPolicy, 'summary_only');
  assert.deepEqual(toPtcLabBrowserIdentitySnapshot(policy), {
    enabled: true,
    mode: 'fixed_preflight',
    browserPolicyId: PTC_LAB_BROWSER_FIXED_PREFLIGHT_POLICY_ID,
    networkPolicyId: PTC_LAB_OPEN_EGRESS_LOCAL_POLICY_ID,
    maxTabs: 1,
    maxActionMs: 1200,
    profilePolicyId: PTC_LAB_BROWSER_PROFILE_NONE_POLICY_ID,
    cookieStorePolicyId: PTC_LAB_BROWSER_COOKIE_STORE_NONE_POLICY_ID,
    artifactExportPolicyId: PTC_LAB_BROWSER_ARTIFACT_EXPORT_DISABLED_POLICY_ID,
    browserTelemetryPolicyId: PTC_LAB_BROWSER_TELEMETRY_OWNER_OUTCOME_POLICY_ID,
    outputPolicy: 'summary_only',
  });
});

void test('createPtcLabBrowserFixedPreflightPolicy rejects unbounded timeouts', () => {
  assert.throws(
    () => createPtcLabBrowserFixedPreflightPolicy({ maxActionMs: 0 }),
    /maxActionMs/u,
  );
  assert.throws(
    () => createPtcLabBrowserFixedPreflightPolicy({ maxActionMs: 15_001 }),
    /maxActionMs/u,
  );
});

void test('createPtcLabBrowserFixedRuntimeProbePolicy separates runtime identity from preflight', () => {
  const policy = createPtcLabBrowserFixedRuntimeProbePolicy({
    maxActionMs: 1300,
  });
  if (!policy.enabled || policy.mode !== 'fixed_runtime_probe') {
    throw new Error('expected fixed browser runtime probe policy');
  }

  assert.equal(policy.enabled, true);
  assert.equal(policy.mode, 'fixed_runtime_probe');
  assert.equal(
    policy.browserPolicyId,
    PTC_LAB_BROWSER_FIXED_RUNTIME_PROBE_POLICY_ID,
  );
  assert.equal(
    policy.runtimeEnginePolicyId,
    PTC_LAB_BROWSER_RUNTIME_ENGINE_CHROMIUM_POLICY_ID,
  );
  assert.equal(policy.networkPolicyId, PTC_LAB_OPEN_EGRESS_LOCAL_POLICY_ID);
  assert.equal(policy.maxTabs, 1);
  assert.equal(policy.maxActionMs, 1300);
  assert.equal(policy.profilePolicyId, PTC_LAB_BROWSER_PROFILE_NONE_POLICY_ID);
  assert.equal(
    policy.cookieStorePolicyId,
    PTC_LAB_BROWSER_COOKIE_STORE_NONE_POLICY_ID,
  );
  assert.equal(
    policy.artifactExportPolicyId,
    PTC_LAB_BROWSER_ARTIFACT_EXPORT_DISABLED_POLICY_ID,
  );
  assert.equal(
    policy.telemetryPolicyId,
    PTC_LAB_BROWSER_TELEMETRY_OWNER_OUTCOME_POLICY_ID,
  );
  assert.equal(policy.outputPolicy, 'summary_only');
  assert.deepEqual(toPtcLabBrowserIdentitySnapshot(policy), {
    enabled: true,
    mode: 'fixed_runtime_probe',
    browserPolicyId: PTC_LAB_BROWSER_FIXED_RUNTIME_PROBE_POLICY_ID,
    browserRuntimeEnginePolicyId:
      PTC_LAB_BROWSER_RUNTIME_ENGINE_CHROMIUM_POLICY_ID,
    networkPolicyId: PTC_LAB_OPEN_EGRESS_LOCAL_POLICY_ID,
    maxTabs: 1,
    maxActionMs: 1300,
    profilePolicyId: PTC_LAB_BROWSER_PROFILE_NONE_POLICY_ID,
    cookieStorePolicyId: PTC_LAB_BROWSER_COOKIE_STORE_NONE_POLICY_ID,
    artifactExportPolicyId: PTC_LAB_BROWSER_ARTIFACT_EXPORT_DISABLED_POLICY_ID,
    browserTelemetryPolicyId: PTC_LAB_BROWSER_TELEMETRY_OWNER_OUTCOME_POLICY_ID,
    outputPolicy: 'summary_only',
  });
});

void test('createPtcLabBrowserFixedNavigationProbePolicy separates navigation identity from runtime', () => {
  const policy = createPtcLabBrowserFixedNavigationProbePolicy({
    maxActionMs: 1400,
  });
  if (!policy.enabled || policy.mode !== 'fixed_navigation_probe') {
    throw new Error('expected fixed browser navigation probe policy');
  }

  assert.equal(
    policy.browserPolicyId,
    PTC_LAB_BROWSER_FIXED_NAVIGATION_PROBE_POLICY_ID,
  );
  assert.equal(
    policy.runtimeEnginePolicyId,
    PTC_LAB_BROWSER_RUNTIME_ENGINE_CHROMIUM_POLICY_ID,
  );
  assert.equal(
    policy.navigationTargetPolicyId,
    PTC_LAB_BROWSER_NAVIGATION_TARGET_FIXED_HTTPS_POLICY_ID,
  );
  assert.equal(
    policy.urlGrammarPolicyId,
    PTC_LAB_BROWSER_URL_GRAMMAR_POLICY_OWNED_TARGET_REF_POLICY_ID,
  );
  assert.equal(
    policy.redirectPolicyId,
    PTC_LAB_BROWSER_REDIRECT_DISABLED_POLICY_ID,
  );
  assert.equal(policy.networkPolicyId, PTC_LAB_OPEN_EGRESS_LOCAL_POLICY_ID);
  assert.equal(policy.maxTabs, 1);
  assert.equal(policy.maxActionMs, 1400);
  assert.equal(policy.profilePolicyId, PTC_LAB_BROWSER_PROFILE_NONE_POLICY_ID);
  assert.equal(
    policy.cookieStorePolicyId,
    PTC_LAB_BROWSER_COOKIE_STORE_NONE_POLICY_ID,
  );
  assert.equal(
    policy.artifactExportPolicyId,
    PTC_LAB_BROWSER_ARTIFACT_EXPORT_DISABLED_POLICY_ID,
  );
  assert.equal(
    policy.telemetryPolicyId,
    PTC_LAB_BROWSER_TELEMETRY_OWNER_OUTCOME_POLICY_ID,
  );
  assert.equal(policy.outputPolicy, 'summary_only');
  assert.equal(
    policy.evidencePolicyId,
    PTC_LAB_BROWSER_NAVIGATION_SUMMARY_ONLY_POLICY_ID,
  );
  assert.deepEqual(toPtcLabBrowserIdentitySnapshot(policy), {
    enabled: true,
    mode: 'fixed_navigation_probe',
    browserPolicyId: PTC_LAB_BROWSER_FIXED_NAVIGATION_PROBE_POLICY_ID,
    browserRuntimeEnginePolicyId:
      PTC_LAB_BROWSER_RUNTIME_ENGINE_CHROMIUM_POLICY_ID,
    networkPolicyId: PTC_LAB_OPEN_EGRESS_LOCAL_POLICY_ID,
    navigationTargetPolicyId:
      PTC_LAB_BROWSER_NAVIGATION_TARGET_FIXED_HTTPS_POLICY_ID,
    urlGrammarPolicyId:
      PTC_LAB_BROWSER_URL_GRAMMAR_POLICY_OWNED_TARGET_REF_POLICY_ID,
    redirectPolicyId: PTC_LAB_BROWSER_REDIRECT_DISABLED_POLICY_ID,
    maxTabs: 1,
    maxActionMs: 1400,
    profilePolicyId: PTC_LAB_BROWSER_PROFILE_NONE_POLICY_ID,
    cookieStorePolicyId: PTC_LAB_BROWSER_COOKIE_STORE_NONE_POLICY_ID,
    artifactExportPolicyId: PTC_LAB_BROWSER_ARTIFACT_EXPORT_DISABLED_POLICY_ID,
    browserTelemetryPolicyId: PTC_LAB_BROWSER_TELEMETRY_OWNER_OUTCOME_POLICY_ID,
    outputPolicy: 'summary_only',
    evidencePolicyId: PTC_LAB_BROWSER_NAVIGATION_SUMMARY_ONLY_POLICY_ID,
  });
});

void test('buildPtcLabBrowserLabels projects only policy identity, not browser state', () => {
  const policy = createPtcLabBrowserFixedNavigationProbePolicy({
    maxActionMs: 1200,
  });
  const labels = buildPtcLabBrowserLabels(policy);
  if (!policy.enabled || policy.mode !== 'fixed_navigation_probe') {
    throw new Error('expected fixed browser navigation probe policy');
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
    labels.includes(`geulbat.browserOutputPolicy=${policy.outputPolicy}`),
    true,
  );
  assert.equal(
    labels.includes(
      `geulbat.browserRuntimeEnginePolicyId=${policy.runtimeEnginePolicyId}`,
    ),
    true,
  );
  assert.equal(
    labels.includes(
      `geulbat.browserNavigationTargetPolicyId=${policy.navigationTargetPolicyId}`,
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
    maxTitleChars: 80,
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
  assert.equal(policy.maxTitleChars, 80);
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
  assert.equal(
    policy.titlePolicyId,
    PTC_LAB_BROWSER_TITLE_BOUNDED_TEXT_POLICY_ID,
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
    maxTitleChars: 80,
    profilePolicyId: policy.profilePolicyId,
    cookieStorePolicyId: policy.cookieStorePolicyId,
    downloadPolicyId: policy.downloadPolicyId,
    artifactExportPolicyId: policy.artifactExportPolicyId,
    browserTelemetryPolicyId: policy.telemetryPolicyId,
    outputPolicy: 'summary_only',
    evidencePolicyId: PTC_LAB_BROWSER_PAGE_LOAD_EVIDENCE_SUMMARY_POLICY_ID,
    pageLoadEvidenceDigestPolicyId: policy.pageLoadEvidenceDigestPolicyId,
    requestedUrlEchoPolicyId: policy.requestedUrlEchoPolicyId,
    finalUrlEchoPolicyId: PTC_LAB_BROWSER_FINAL_URL_ECHO_DIGEST_ONLY_POLICY_ID,
    finalUrlDigestPolicyId:
      PTC_LAB_BROWSER_FINAL_URL_DIGEST_PUBLIC_SHA256_POLICY_ID,
    responseStatusPolicyId:
      PTC_LAB_BROWSER_RESPONSE_STATUS_CODE_OPTIONAL_POLICY_ID,
    titlePolicyId: PTC_LAB_BROWSER_TITLE_BOUNDED_TEXT_POLICY_ID,
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

  const labels = buildPtcLabBrowserLabels(policy);
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
    `geulbat.browserMaxTitleChars=${policy.maxTitleChars}`,
    `geulbat.browserPageLoadEvidenceDigestPolicyId=${policy.pageLoadEvidenceDigestPolicyId}`,
    `geulbat.browserRequestedUrlEchoPolicyId=${policy.requestedUrlEchoPolicyId}`,
    `geulbat.browserFinalUrlEchoPolicyId=${policy.finalUrlEchoPolicyId}`,
    `geulbat.browserFinalUrlDigestPolicyId=${policy.finalUrlDigestPolicyId}`,
    `geulbat.browserResponseStatusPolicyId=${policy.responseStatusPolicyId}`,
    `geulbat.browserTitlePolicyId=${policy.titlePolicyId}`,
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
    createPtcLabBrowserFixedPreflightPolicy({ maxActionMs: 1200 }),
    createPtcLabBrowserFixedRuntimeProbePolicy({ maxActionMs: 1300 }),
    createPtcLabBrowserFixedNavigationProbePolicy({ maxActionMs: 1400 }),
    createPtcLabBrowserUserUrlNavigationPolicy({ maxActionMs: 1500 }),
    createPtcLabBrowserPageLoadEvidencePolicy({
      maxNavigationMs: 1600,
      maxTitleChars: 90,
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

    if (
      policy.mode === 'fixed_runtime_probe' ||
      policy.mode === 'fixed_navigation_probe'
    ) {
      expectedKeys.delete('runtimeEnginePolicyId');
      expectedKeys.add('browserRuntimeEnginePolicyId');
      assert.equal(
        snapshotRecord.browserRuntimeEnginePolicyId,
        policyRecord.runtimeEnginePolicyId,
        `${policy.mode}.runtimeEnginePolicyId projection`,
      );
      assert.equal(
        Object.hasOwn(snapshotRecord, 'runtimeEnginePolicyId'),
        false,
      );
    }

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
      if (
        key === 'runtimeEnginePolicyId' &&
        (policy.mode === 'fixed_runtime_probe' ||
          policy.mode === 'fixed_navigation_probe')
      ) {
        continue;
      }
      assert.deepEqual(snapshotRecord[key], value, `${policy.mode}.${key}`);
    }
  }
});

void test('doesPtcLabBrowserSessionMatchPolicy rejects network and browser identity drift', () => {
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
    maxTitleChars: 90,
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

  assert.equal(
    doesPtcLabBrowserSessionMatchPolicy({
      handle,
      policyId,
      browser: browserPolicy,
      network: networkPolicy,
    }),
    true,
  );
  assert.equal(
    doesPtcLabBrowserSessionMatchPolicy({
      handle,
      policyId: 'different_lab_policy_v1',
      browser: browserPolicy,
      network: networkPolicy,
    }),
    false,
  );
  assert.equal(
    doesPtcLabBrowserSessionMatchPolicy({
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
    }),
    false,
  );
  assert.equal(
    doesPtcLabBrowserSessionMatchPolicy({
      handle,
      policyId,
      browser: browserPolicy,
      network: differentExplicitOptInNetwork,
    }),
    false,
  );
  assert.equal(
    doesPtcLabBrowserSessionMatchPolicy({
      handle: {
        reuseKey: {
          ...handle.reuseKey,
          browser: { ...browserIdentity, maxTitleChars: 91 },
        },
      },
      policyId,
      browser: browserPolicy,
      network: networkPolicy,
    }),
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
    maxTitleChars: 90,
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
        browser: { ...browserIdentity, maxTitleChars: 91 },
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

void test('browser policy creation rejects invalid bounded runtime budgets', () => {
  assert.throws(
    () => createPtcLabBrowserFixedPreflightPolicy({ maxActionMs: 0 }),
    /fixed preflight maxActionMs is invalid/u,
  );
  assert.throws(
    () => createPtcLabBrowserFixedRuntimeProbePolicy({ maxActionMs: 15_001 }),
    /fixed runtime probe maxActionMs is invalid/u,
  );
  assert.throws(
    () => createPtcLabBrowserUserUrlNavigationPolicy({ maxActionMs: 1.5 }),
    /user URL navigation maxActionMs is invalid/u,
  );
  assert.throws(
    () => createPtcLabBrowserPageLoadEvidencePolicy({ maxTitleChars: 513 }),
    /page-load evidence maxTitleChars is invalid/u,
  );
});
