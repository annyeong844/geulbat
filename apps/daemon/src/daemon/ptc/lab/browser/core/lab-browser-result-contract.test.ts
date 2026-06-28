import assert from 'node:assert/strict';
import test from 'node:test';
import {
  browserPageLoadEvidenceFailure,
  type PtcLabBrowserPageLoadEvidenceAttemptDigest,
} from '../page-load-evidence/lab-browser-page-load-evidence-contract.js';
import {
  browserUserUrlNavigationFailure,
  type PtcLabBrowserUserUrlNavigationAttemptDigest,
} from '../user-url-navigation/lab-browser-user-url-navigation-contract.js';
import {
  buildPtcLabBrowserEvidenceCommonAvailability,
  buildPtcLabBrowserEvidencePublicBaseFields,
  buildPtcLabBrowserEvidenceSummarySharedFields,
  arePtcLabBrowserEvidenceAdapterChecksComplete,
  mapPtcLabBrowserEvidenceAdapterFailureToResult,
  mapPtcLabBrowserEvidenceCommandFailureResult,
} from './lab-browser-result-contract.js';
import type { PtcLabBrowserUserUrlTargetDigest } from './lab-browser-url-navigation.js';

void test('phased browser failures preserve feature kind, phase, and lifecycle extras', () => {
  const targetDigest =
    `sha256:${'a'.repeat(64)}` as PtcLabBrowserUserUrlTargetDigest;
  const navigationAttemptDigest = `sha256:${'b'.repeat(
    64,
  )}` as PtcLabBrowserUserUrlNavigationAttemptDigest;
  const pageLoadEvidenceAttemptDigest = `sha256:${'c'.repeat(
    64,
  )}` as PtcLabBrowserPageLoadEvidenceAttemptDigest;

  assert.deepEqual(
    browserUserUrlNavigationFailure(
      'ptc_lab_browser_timeout',
      'timed out',
      'navigation',
      {
        targetDigest,
        navigationAttemptDigest,
        sessionLifecycle: {
          mode: 'runtime_owned',
          retainedAfterExecution: false,
          taintedAfterExecution: true,
        },
      },
    ),
    {
      kind: 'ptc_lab_browser_user_url_navigation_error',
      ok: false,
      reasonCode: 'ptc_lab_browser_timeout',
      message: 'timed out',
      phase: 'navigation',
      targetDigest,
      navigationAttemptDigest,
      sessionLifecycle: {
        mode: 'runtime_owned',
        retainedAfterExecution: false,
        taintedAfterExecution: true,
      },
    },
  );

  assert.deepEqual(
    browserPageLoadEvidenceFailure(
      'ptc_lab_browser_evidence_output_invalid',
      'bad evidence',
      'output_serialization',
      {
        targetDigest,
        pageLoadEvidenceAttemptDigest,
        diagnostics: { evidenceCaptured: false },
      },
    ),
    {
      kind: 'ptc_lab_browser_page_load_evidence_error',
      ok: false,
      reasonCode: 'ptc_lab_browser_evidence_output_invalid',
      message: 'bad evidence',
      phase: 'output_serialization',
      targetDigest,
      pageLoadEvidenceAttemptDigest,
      diagnostics: { evidenceCaptured: false },
    },
  );
});

void test('browser evidence summary shared fields preserve runtime-owned success shape', () => {
  const targetDigest =
    `sha256:${'a'.repeat(64)}` as PtcLabBrowserUserUrlTargetDigest;
  const finalUrlDigest = `sha256:${'b'.repeat(64)}` as const;

  assert.deepEqual(
    buildPtcLabBrowserEvidenceSummarySharedFields({
      checks: {
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
      finalUrlDigest,
      finalUrlDigestPolicyId: 'final_url_digest_policy',
      finalUrlEchoPolicyId: 'final_url_echo_policy',
      navigationDurationMs: 0,
      ownerDurationMs: 12,
      redirectCount: 0,
      redirectCountPolicyId: 'redirect_count_policy',
      requestedUrlEchoPolicyId: 'requested_url_echo_policy',
      targetDigest,
      timingPolicyId: 'timing_policy',
    }),
    {
      targetDigest,
      requestedUrl: {
        digest: targetDigest,
        echoPolicyId: 'requested_url_echo_policy',
        redacted: true,
      },
      finalUrl: {
        digest: finalUrlDigest,
        digestPolicyId: 'final_url_digest_policy',
        echoPolicyId: 'final_url_echo_policy',
        redacted: true,
      },
      redirects: {
        policyId: 'redirect_count_policy',
        count: 0,
      },
      sessionLifecycle: {
        mode: 'runtime_owned',
        retainedAfterExecution: true,
        taintedAfterExecution: false,
      },
      timing: {
        policyId: 'timing_policy',
        ownerDurationMs: 12,
        navigationDurationMs: 0,
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
    },
  );
});

void test('browser evidence completeness depends on observed adapter checks', () => {
  assert.equal(
    arePtcLabBrowserEvidenceAdapterChecksComplete({
      engineAvailable: true,
      contextCreated: true,
      navigationStarted: true,
      navigationSettled: true,
      redirectPolicyEnforced: true,
      downloadPolicyEnforced: true,
      popupPolicyEnforced: false,
      evidenceCaptured: true,
      cleanupCompleted: true,
    }),
    false,
  );
});

void test('browser evidence public field helpers preserve common output shape', () => {
  const targetDigest =
    `sha256:${'a'.repeat(64)}` as PtcLabBrowserUserUrlTargetDigest;
  const finalUrl = {
    digest: `sha256:${'b'.repeat(64)}` as const,
    digestPolicyId: 'final_url_digest_policy',
    echoPolicyId: 'final_url_echo_policy',
    redacted: true,
  };
  const redirects = { policyId: 'redirect_count_policy', count: 2 };
  const timing = {
    policyId: 'timing_policy',
    ownerDurationMs: 12,
    navigationDurationMs: 7,
  };

  assert.deepEqual(
    buildPtcLabBrowserEvidencePublicBaseFields({
      targetDigest,
      finalUrl,
      loadOutcome: 'loaded',
      loadState: 'domcontentloaded',
      redirects,
      timing,
    }),
    {
      targetDigest,
      finalUrl,
      loadOutcome: 'loaded',
      loadState: 'domcontentloaded',
      redirects,
      timing,
    },
  );
  assert.deepEqual(
    buildPtcLabBrowserEvidenceCommonAvailability({
      navigationDurationMs: undefined,
    }),
    {
      finalUrl: 'available',
      navigationTiming: 'unavailable_allowed',
    },
  );
  assert.deepEqual(
    buildPtcLabBrowserEvidenceCommonAvailability({ navigationDurationMs: 0 }),
    {
      finalUrl: 'available',
      navigationTiming: 'available',
    },
  );
});

void test('browser evidence result mappers centralize taint and retained-session failure envelopes', async () => {
  const attemptDetails = {
    targetDigest:
      `sha256:${'a'.repeat(64)}` as PtcLabBrowserUserUrlTargetDigest,
    pageLoadEvidenceAttemptDigest: `sha256:${'b'.repeat(
      64,
    )}` as PtcLabBrowserPageLoadEvidenceAttemptDigest,
  };
  const taintEnvelope = {
    sessionLifecycle: {
      mode: 'runtime_owned',
      retainedAfterExecution: false,
      taintedAfterExecution: true,
    },
    diagnostics: { taintCloseFailed: true },
  } as const;
  let closeCount = 0;
  const closeTaintedSession = async () => {
    closeCount += 1;
    return taintEnvelope;
  };

  const commandFailure = await mapPtcLabBrowserEvidenceCommandFailureResult({
    attemptDetails,
    closeTaintedSession,
    executionKind: 'crash',
    subject: 'page-load evidence',
    toFailure: (failure) => failure,
  });

  assert.equal(closeCount, 1);
  assert.deepEqual(commandFailure, {
    reasonCode: 'ptc_lab_browser_navigation_failed',
    message: 'PTC lab browser page-load evidence failed to execute',
    phase: 'navigation',
    details: {
      ...attemptDetails,
      diagnostics: {
        taintCloseFailed: true,
      },
      sessionLifecycle: taintEnvelope.sessionLifecycle,
    },
  });

  const retainedFailure = await mapPtcLabBrowserEvidenceAdapterFailureToResult({
    attemptDetails,
    closeTaintedSession,
    errorCode: 'browser_runtime_unavailable',
    subject: 'page-load evidence',
    toFailure: (failure) => failure,
  });

  assert.equal(closeCount, 1);
  assert.deepEqual(retainedFailure, {
    reasonCode: 'ptc_lab_browser_runtime_unavailable',
    message: 'PTC lab browser runtime is unavailable',
    phase: 'runtime_start',
    details: {
      ...attemptDetails,
      sessionLifecycle: {
        mode: 'runtime_owned',
        retainedAfterExecution: true,
        taintedAfterExecution: false,
      },
    },
  });

  const cleanupFailure = await mapPtcLabBrowserEvidenceAdapterFailureToResult({
    attemptDetails,
    closeTaintedSession,
    errorCode: 'cleanup_uncertain',
    subject: 'text evidence',
    toFailure: (failure) => failure,
  });

  assert.equal(closeCount, 2);
  assert.deepEqual(cleanupFailure, {
    reasonCode: 'ptc_lab_browser_cleanup_uncertain',
    message: 'PTC lab browser text evidence cleanup was not proven',
    phase: 'cleanup',
    details: {
      ...attemptDetails,
      diagnostics: {
        taintCloseFailed: true,
      },
      sessionLifecycle: taintEnvelope.sessionLifecycle,
    },
  });
});
