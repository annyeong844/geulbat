import assert from 'node:assert/strict';
import test from 'node:test';
import { runPtcLabBrowserPageLoadEvidence } from './lab-browser-page-load-evidence.js';
import type { PtcLabBrowserPageLoadEvidenceChecks } from './lab-browser-page-load-evidence-contract.js';
import {
  browserPageLoadEvidenceRequest,
  browserPageLoadEvidenceStdout,
  createBrowserPageLoadEvidenceLab,
  PTC_BROWSER_PAGE_LOAD_EVIDENCE_TEST_IDENTITY,
  PTC_BROWSER_PAGE_LOAD_EVIDENCE_TEST_PRIVATE_PATH,
  PTC_BROWSER_PAGE_LOAD_EVIDENCE_TEST_SUCCESS_CHECKS,
  withBrowserPageLoadEvidenceSessionManager,
} from '../../test-support/ptc-browser-page-load-evidence.js';

type AdapterChecks = Omit<
  PtcLabBrowserPageLoadEvidenceChecks,
  'targetVerified'
>;

void test('runPtcLabBrowserPageLoadEvidence classifies runtime and browser evidence failures without raw leaks', async () => {
  const { admission, dockerPolicy } = createBrowserPageLoadEvidenceLab();
  const cases: Array<{
    errorCode:
      | 'browser_runtime_unavailable'
      | 'redirect_disallowed'
      | 'download_disallowed'
      | 'popup_disallowed'
      | 'permission_disallowed'
      | 'evidence_unavailable'
      | 'evidence_output_invalid';
    reasonCode: string;
    phase: string;
    checks: AdapterChecks;
  }> = [
    {
      errorCode: 'browser_runtime_unavailable',
      reasonCode: 'ptc_lab_browser_runtime_unavailable',
      phase: 'runtime_start',
      checks: {
        engineAvailable: false,
        contextCreated: false,
        navigationStarted: false,
        navigationSettled: false,
        redirectPolicyEnforced: false,
        downloadPolicyEnforced: false,
        popupPolicyEnforced: false,
        permissionPolicyEnforced: true,
        evidenceSanitized: false,
        cleanupCompleted: true,
      },
    },
    {
      errorCode: 'redirect_disallowed',
      reasonCode: 'ptc_lab_browser_redirect_disallowed',
      phase: 'redirect_revalidation',
      checks: {
        ...PTC_BROWSER_PAGE_LOAD_EVIDENCE_TEST_SUCCESS_CHECKS,
        redirectPolicyEnforced: false,
      },
    },
    {
      errorCode: 'download_disallowed',
      reasonCode: 'ptc_lab_browser_download_disallowed',
      phase: 'download_policy',
      checks: {
        ...PTC_BROWSER_PAGE_LOAD_EVIDENCE_TEST_SUCCESS_CHECKS,
        downloadPolicyEnforced: false,
      },
    },
    {
      errorCode: 'popup_disallowed',
      reasonCode: 'ptc_lab_browser_popup_disallowed',
      phase: 'popup_policy',
      checks: {
        ...PTC_BROWSER_PAGE_LOAD_EVIDENCE_TEST_SUCCESS_CHECKS,
        popupPolicyEnforced: false,
      },
    },
    {
      errorCode: 'permission_disallowed',
      reasonCode: 'ptc_lab_browser_permission_disallowed',
      phase: 'permission_policy',
      checks: {
        ...PTC_BROWSER_PAGE_LOAD_EVIDENCE_TEST_SUCCESS_CHECKS,
        permissionPolicyEnforced: false,
      },
    },
    {
      errorCode: 'evidence_unavailable',
      reasonCode: 'ptc_lab_browser_evidence_unavailable',
      phase: 'evidence_capture',
      checks: {
        ...PTC_BROWSER_PAGE_LOAD_EVIDENCE_TEST_SUCCESS_CHECKS,
        evidenceSanitized: false,
      },
    },
    {
      errorCode: 'evidence_output_invalid',
      reasonCode: 'ptc_lab_browser_evidence_output_invalid',
      phase: 'evidence_sanitization',
      checks: {
        ...PTC_BROWSER_PAGE_LOAD_EVIDENCE_TEST_SUCCESS_CHECKS,
        evidenceSanitized: false,
      },
    },
  ];

  for (const item of cases) {
    await withBrowserPageLoadEvidenceSessionManager(
      {
        policy: dockerPolicy,
        evidenceResult: {
          kind: 'exit',
          exitCode: item.errorCode === 'browser_runtime_unavailable' ? 3 : 2,
          stdout: browserPageLoadEvidenceStdout({
            ok: false,
            errorCode: item.errorCode,
            checks: item.checks,
          }),
          stderr: `${PTC_BROWSER_PAGE_LOAD_EVIDENCE_TEST_PRIVATE_PATH} https://example.com/private?access_token=secret#id_token=secret`,
        },
      },
      async ({ manager, runner, invocations }) => {
        const result = await runPtcLabBrowserPageLoadEvidence({
          admission,
          identity: PTC_BROWSER_PAGE_LOAD_EVIDENCE_TEST_IDENTITY,
          sessionManager: manager,
          request: browserPageLoadEvidenceRequest(),
          commandRunner: runner,
        });

        assert.equal(result.ok, false);
        assert.equal(result.ok ? '' : result.reasonCode, item.reasonCode);
        assert.equal(result.ok ? '' : result.phase, item.phase);
        assert.equal(
          invocations.some((invocation) => invocation.args[0] === 'rm'),
          false,
        );
        assert.doesNotMatch(
          JSON.stringify(result),
          /https?:\/\/|example\.com|access_token|id_token|secret|geulbat-private|\.geulbat/u,
        );
      },
    );
  }
});

void test('runPtcLabBrowserPageLoadEvidence taints timeout, cancellation, and cleanup uncertainty', async () => {
  const cleanupFailureStdout = browserPageLoadEvidenceStdout({
    ok: false,
    errorCode: 'cleanup_failed',
    checks: {
      ...PTC_BROWSER_PAGE_LOAD_EVIDENCE_TEST_SUCCESS_CHECKS,
      cleanupCompleted: false,
    },
  });
  const cases = [
    {
      evidenceResult: {
        kind: 'timeout' as const,
        stdout: '',
        stderr: PTC_BROWSER_PAGE_LOAD_EVIDENCE_TEST_PRIVATE_PATH,
      },
      reasonCode: 'ptc_lab_browser_timeout',
      phase: 'navigation',
    },
    {
      evidenceResult: {
        kind: 'cancelled' as const,
        stdout: '',
        stderr: PTC_BROWSER_PAGE_LOAD_EVIDENCE_TEST_PRIVATE_PATH,
      },
      reasonCode: 'ptc_lab_browser_cancelled',
      phase: 'navigation',
    },
    {
      evidenceResult: {
        kind: 'exit' as const,
        exitCode: 2,
        stdout: cleanupFailureStdout,
        stderr: PTC_BROWSER_PAGE_LOAD_EVIDENCE_TEST_PRIVATE_PATH,
      },
      reasonCode: 'ptc_lab_browser_cleanup_failed',
      phase: 'cleanup',
    },
  ];

  for (const item of cases) {
    const { admission, dockerPolicy } = createBrowserPageLoadEvidenceLab();
    await withBrowserPageLoadEvidenceSessionManager(
      {
        policy: dockerPolicy,
        evidenceResult: item.evidenceResult,
      },
      async ({ manager, runner, invocations }) => {
        const result = await runPtcLabBrowserPageLoadEvidence({
          admission,
          identity: PTC_BROWSER_PAGE_LOAD_EVIDENCE_TEST_IDENTITY,
          sessionManager: manager,
          request: browserPageLoadEvidenceRequest(),
          commandRunner: runner,
        });

        assert.equal(result.ok, false);
        assert.equal(result.ok ? '' : result.reasonCode, item.reasonCode);
        assert.equal(result.ok ? '' : result.phase, item.phase);
        assert.equal(
          result.ok ? false : result.sessionLifecycle?.taintedAfterExecution,
          true,
        );
        assert.equal(
          invocations.some((invocation) => invocation.args[0] === 'rm'),
          true,
        );
        assert.doesNotMatch(
          JSON.stringify(result),
          /https?:\/\/|example\.com|access_token|id_token|secret|geulbat-private|\.geulbat/u,
        );
      },
    );
  }
});

void test('runPtcLabBrowserPageLoadEvidence rejects adapter output leaks before returning evidence', async () => {
  const { admission, dockerPolicy } = createBrowserPageLoadEvidenceLab();

  await withBrowserPageLoadEvidenceSessionManager(
    {
      policy: dockerPolicy,
      evidenceResult: {
        kind: 'exit',
        exitCode: 0,
        stdout: `${JSON.stringify({
          ok: true,
          capability: 'ptc_lab_browser_page_load_evidence',
          checks: PTC_BROWSER_PAGE_LOAD_EVIDENCE_TEST_SUCCESS_CHECKS,
          finalUrlDigest:
            'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          finalUrl: 'https://example.com/final?access_token=secret',
          responseHeaders: { location: 'https://example.com/final' },
          browserConsole: `console ${PTC_BROWSER_PAGE_LOAD_EVIDENCE_TEST_PRIVATE_PATH}`,
          title: {
            text: 'Reset token access_token=secret',
            charCount: 31,
            truncated: false,
            maxChars: 160,
            redacted: false,
          },
          userDataDir: '/tmp/geulbat-private/.geulbat/browser-profile',
          redirectCount: 0,
          navigationDurationMs: 37,
        })}\n`,
        stderr: `${PTC_BROWSER_PAGE_LOAD_EVIDENCE_TEST_PRIVATE_PATH} https://example.com/private?access_token=secret#id_token=secret`,
      },
    },
    async ({ manager, runner }) => {
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
        'ptc_lab_browser_evidence_output_invalid',
      );
      assert.equal(result.ok ? '' : result.phase, 'output_serialization');
      assert.doesNotMatch(
        JSON.stringify(result),
        /https?:\/\/|example\.com|access_token|id_token|secret|final|headers|console|userDataDir|geulbat-private|\.geulbat/u,
      );
    },
  );
});

void test('runPtcLabBrowserPageLoadEvidence rejects malformed summary evidence fields', async () => {
  const { admission, dockerPolicy } = createBrowserPageLoadEvidenceLab();

  await withBrowserPageLoadEvidenceSessionManager(
    {
      policy: dockerPolicy,
      evidenceResult: {
        kind: 'exit',
        exitCode: 0,
        stdout: browserPageLoadEvidenceStdout({
          ok: true,
          checks: PTC_BROWSER_PAGE_LOAD_EVIDENCE_TEST_SUCCESS_CHECKS,
          statusCode: 700,
        }),
        stderr: '',
      },
    },
    async ({ manager, runner }) => {
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
        'ptc_lab_browser_evidence_output_invalid',
      );
    },
  );
});
