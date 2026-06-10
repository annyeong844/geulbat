import assert from 'node:assert/strict';
import test from 'node:test';
import { PTC_LAB_BROWSER_PAGE_LOAD_EVIDENCE_CAPABILITY } from './lab-browser-page-load-evidence-contract.js';
import { parsePageLoadEvidenceStdout } from './lab-browser-page-load-evidence-output.js';
import { PTC_BROWSER_PAGE_LOAD_EVIDENCE_TEST_SUCCESS_CHECKS } from '../../test-support/ptc-browser-page-load-evidence.js';

const TARGET_URL = 'https://example.com/private?nonce=private#frag';
const FINAL_URL_DIGEST =
  'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

void test('parsePageLoadEvidenceStdout rejects malformed adapter stdout before evidence deserialization', () => {
  for (const stdout of [
    '',
    '{"ok":true}\n{"ok":false}',
    '{',
    'x'.repeat(9 * 1024),
  ]) {
    const result = parsePageLoadEvidenceStdout({
      maxTitleChars: 160,
      stdout,
      targetUrl: TARGET_URL,
    });

    assert.equal(result.ok, false, stdout.slice(0, 20));
    assert.equal(
      result.ok ? '' : result.reasonCode,
      'ptc_lab_browser_evidence_output_invalid',
    );
    assert.equal(result.ok ? '' : result.phase, 'output_serialization');
  }
});

void test('parsePageLoadEvidenceStdout rejects raw browser output and invalid top-level shapes', () => {
  for (const payload of [
    [],
    {
      ok: true,
      capability: 'wrong_capability',
      checks: PTC_BROWSER_PAGE_LOAD_EVIDENCE_TEST_SUCCESS_CHECKS,
    },
    {
      ok: true,
      capability: PTC_LAB_BROWSER_PAGE_LOAD_EVIDENCE_CAPABILITY,
      checks: {},
    },
    {
      ok: true,
      capability: PTC_LAB_BROWSER_PAGE_LOAD_EVIDENCE_CAPABILITY,
      checks: PTC_BROWSER_PAGE_LOAD_EVIDENCE_TEST_SUCCESS_CHECKS,
      finalUrl: 'https://example.com/private?nonce=private',
    },
    {
      ok: true,
      capability: PTC_LAB_BROWSER_PAGE_LOAD_EVIDENCE_CAPABILITY,
      checks: PTC_BROWSER_PAGE_LOAD_EVIDENCE_TEST_SUCCESS_CHECKS,
      finalUrlDigest: FINAL_URL_DIGEST,
      loadOutcome: 'loaded',
      loadState: 'domcontentloaded',
      redirectCount: 0,
      title: {
        text: '?nonce=private',
        charCount: 14,
        truncated: false,
        maxChars: 160,
        redacted: false,
      },
    },
  ]) {
    const result = parsePageLoadEvidenceStdout({
      maxTitleChars: 160,
      stdout: JSON.stringify(payload),
      targetUrl: TARGET_URL,
    });

    assert.equal(result.ok, false, JSON.stringify(payload));
    assert.equal(
      result.ok ? '' : result.reasonCode,
      'ptc_lab_browser_evidence_output_invalid',
    );
    assert.doesNotMatch(
      JSON.stringify(result),
      /https?:\/\/|example\.com|nonce=private|frag/u,
    );
  }
});

void test('parsePageLoadEvidenceStdout accepts minimal evidence without optional browser details', () => {
  const cases = [
    {
      loadOutcome: 'no_committed_document',
      loadState: 'no_committed_document',
    },
    {
      loadOutcome: 'browser_error_page',
      loadState: 'load',
    },
  ];

  for (const item of cases) {
    const result = parsePageLoadEvidenceStdout({
      maxTitleChars: 160,
      stdout: JSON.stringify({
        ok: true,
        capability: PTC_LAB_BROWSER_PAGE_LOAD_EVIDENCE_CAPABILITY,
        checks: PTC_BROWSER_PAGE_LOAD_EVIDENCE_TEST_SUCCESS_CHECKS,
        finalUrlDigest: FINAL_URL_DIGEST,
        redirectCount: 0,
        ...item,
      }),
      targetUrl: TARGET_URL,
    });

    if (!result.ok || !result.value.ok) {
      assert.fail(
        `expected minimal successful evidence output: ${item.loadOutcome}`,
      );
    }
    assert.equal(result.value.responseStatus, undefined);
    assert.equal(result.value.title, undefined);
    assert.equal(result.value.navigationDurationMs, undefined);
  }
});

void test('parsePageLoadEvidenceStdout accepts known adapter failures and rejects unknown ones', () => {
  for (const errorCode of ['navigation_failed', 'cleanup_uncertain']) {
    const result = parsePageLoadEvidenceStdout({
      maxTitleChars: 160,
      stdout: JSON.stringify({
        ok: false,
        capability: PTC_LAB_BROWSER_PAGE_LOAD_EVIDENCE_CAPABILITY,
        checks: PTC_BROWSER_PAGE_LOAD_EVIDENCE_TEST_SUCCESS_CHECKS,
        errorCode,
      }),
      targetUrl: TARGET_URL,
    });

    assert.equal(result.ok, true, errorCode);
    assert.equal(result.ok ? result.value.ok : true, false);
    assert.equal(
      result.ok && !result.value.ok ? result.value.errorCode : '',
      errorCode,
    );
  }

  const result = parsePageLoadEvidenceStdout({
    maxTitleChars: 160,
    stdout: JSON.stringify({
      ok: false,
      capability: PTC_LAB_BROWSER_PAGE_LOAD_EVIDENCE_CAPABILITY,
      checks: PTC_BROWSER_PAGE_LOAD_EVIDENCE_TEST_SUCCESS_CHECKS,
      errorCode: 'unknown_failure',
    }),
    targetUrl: TARGET_URL,
  });

  assert.equal(result.ok, false);
  assert.equal(
    result.ok ? '' : result.reasonCode,
    'ptc_lab_browser_evidence_output_invalid',
  );
});

void test('parsePageLoadEvidenceStdout rejects unsafe response status and title evidence shapes', () => {
  const invalidEvidenceCases: Array<Record<string, unknown>> = [
    { responseStatus: null },
    { responseStatus: { code: 99, source: 'final_main_resource_response' } },
    { responseStatus: { code: 600, source: 'final_main_resource_response' } },
    { responseStatus: { code: 200.5, source: 'final_main_resource_response' } },
    { responseStatus: { code: 200, source: 'redirect_response' } },
    { title: null },
    {
      title: {
        text: 123,
        charCount: 3,
        truncated: false,
        maxChars: 160,
        redacted: false,
      },
    },
    {
      title: {
        text: 'Title',
        charCount: -1,
        truncated: false,
        maxChars: 160,
        redacted: false,
      },
    },
    {
      title: {
        text: 'Title',
        charCount: 5.5,
        truncated: false,
        maxChars: 160,
        redacted: false,
      },
    },
    {
      title: {
        text: 'Title',
        charCount: 5,
        truncated: 'false',
        maxChars: 160,
        redacted: false,
      },
    },
    {
      title: {
        text: 'Title',
        charCount: 5,
        truncated: false,
        maxChars: 80,
        redacted: false,
      },
    },
    {
      title: {
        text: 'Title',
        charCount: 5,
        truncated: false,
        maxChars: 160,
        redacted: 'false',
      },
    },
    {
      title: {
        text: 'A'.repeat(161),
        charCount: 161,
        truncated: false,
        maxChars: 160,
        redacted: false,
      },
    },
    {
      title: {
        text: '<script>alert(1)</script>',
        charCount: 25,
        truncated: false,
        maxChars: 160,
        redacted: false,
      },
    },
  ];

  for (const invalidEvidence of invalidEvidenceCases) {
    const result = parsePageLoadEvidenceStdout({
      maxTitleChars: 160,
      stdout: JSON.stringify({
        ok: true,
        capability: PTC_LAB_BROWSER_PAGE_LOAD_EVIDENCE_CAPABILITY,
        checks: PTC_BROWSER_PAGE_LOAD_EVIDENCE_TEST_SUCCESS_CHECKS,
        finalUrlDigest: FINAL_URL_DIGEST,
        loadOutcome: 'loaded',
        loadState: 'domcontentloaded',
        redirectCount: 0,
        ...invalidEvidence,
      }),
      targetUrl: TARGET_URL,
    });

    assert.equal(result.ok, false, JSON.stringify(invalidEvidence));
    assert.equal(
      result.ok ? '' : result.reasonCode,
      'ptc_lab_browser_evidence_output_invalid',
    );
  }
});

void test('parsePageLoadEvidenceStdout rejects invalid successful evidence fields', () => {
  for (const invalidEvidence of [
    { loadOutcome: 'loaded_elsewhere' },
    { loadState: 'networkidle' },
    { finalUrlDigest: 'sha256:not-a-digest' },
    { redirectCount: -1 },
    { redirectCount: 1.5 },
    { navigationDurationMs: -1 },
  ]) {
    const result = parsePageLoadEvidenceStdout({
      maxTitleChars: 160,
      stdout: JSON.stringify({
        ok: true,
        capability: PTC_LAB_BROWSER_PAGE_LOAD_EVIDENCE_CAPABILITY,
        checks: PTC_BROWSER_PAGE_LOAD_EVIDENCE_TEST_SUCCESS_CHECKS,
        finalUrlDigest: FINAL_URL_DIGEST,
        loadOutcome: 'loaded',
        loadState: 'domcontentloaded',
        redirectCount: 0,
        ...invalidEvidence,
      }),
      targetUrl: TARGET_URL,
    });

    assert.equal(result.ok, false, JSON.stringify(invalidEvidence));
    assert.equal(
      result.ok ? '' : result.reasonCode,
      'ptc_lab_browser_evidence_output_invalid',
    );
  }
});
