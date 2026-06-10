import assert from 'node:assert/strict';
import test from 'node:test';
import { browserNavigationFailure } from './lab-browser-navigation-contract.js';
import { browserOwnerFailure } from './lab-browser-owner-contract.js';
import {
  browserPageLoadEvidenceFailure,
  PTC_LAB_BROWSER_PAGE_LOAD_EVIDENCE_ERROR_KIND,
  type PtcLabBrowserPageLoadEvidenceAttemptDigest,
} from './lab-browser-page-load-evidence-contract.js';
import { browserRuntimeFailure } from './lab-browser-runtime-contract.js';
import {
  browserUserUrlNavigationFailure,
  PTC_LAB_BROWSER_USER_URL_NAVIGATION_ERROR_KIND,
  type PtcLabBrowserUserUrlNavigationAttemptDigest,
} from './lab-browser-user-url-navigation-contract.js';
import type { PtcLabBrowserUserUrlTargetDigest } from './lab-browser-url-navigation.js';

void test('browser failure wrappers use one compact diagnostics envelope', () => {
  assert.deepEqual(
    browserRuntimeFailure('ptc_lab_browser_output_invalid', 'bad output'),
    {
      ok: false,
      reasonCode: 'ptc_lab_browser_output_invalid',
      message: 'bad output',
    },
  );

  assert.deepEqual(
    browserOwnerFailure('ptc_lab_browser_session_unavailable', 'no session', {
      sessionReasonCode: 'container_create_failed',
    }),
    {
      ok: false,
      reasonCode: 'ptc_lab_browser_session_unavailable',
      message: 'no session',
      diagnostics: { sessionReasonCode: 'container_create_failed' },
    },
  );

  assert.deepEqual(
    browserNavigationFailure('ptc_lab_browser_cleanup_uncertain', 'tainted', {
      cleanupCompleted: false,
    }),
    {
      ok: false,
      reasonCode: 'ptc_lab_browser_cleanup_uncertain',
      message: 'tainted',
      diagnostics: { cleanupCompleted: false },
    },
  );
});

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
      kind: PTC_LAB_BROWSER_USER_URL_NAVIGATION_ERROR_KIND,
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
        diagnostics: { evidenceSanitized: false },
      },
    ),
    {
      kind: PTC_LAB_BROWSER_PAGE_LOAD_EVIDENCE_ERROR_KIND,
      ok: false,
      reasonCode: 'ptc_lab_browser_evidence_output_invalid',
      message: 'bad evidence',
      phase: 'output_serialization',
      targetDigest,
      pageLoadEvidenceAttemptDigest,
      diagnostics: { evidenceSanitized: false },
    },
  );
});
