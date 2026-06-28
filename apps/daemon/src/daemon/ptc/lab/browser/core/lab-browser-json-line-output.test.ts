import assert from 'node:assert/strict';
import test from 'node:test';
import {
  admitPtcLabBrowserAdapterStdoutEnvelope,
  admitPtcLabBrowserJsonLineOutput,
  formatPtcLabBrowserAdapterStdoutParseFailure,
  parsePtcLabBrowserAdapterStdout,
} from './lab-browser-json-line-output.js';
import {
  collectPtcStaticImportGraph,
  ptcSourceUrl,
  ptcStaticImportGraphIncludesSource,
  readPtcStaticImportSpecifiers,
} from '../../../../../test-support/ptc-static-import-graph.js';

const TARGET_URL = 'https://example.com/private?access_token=secret#id_token';

void test('browser JSON-line output admission has no public result-owner dependency', async () => {
  const sourceUrl = ptcSourceUrl(
    'lab/browser/core/lab-browser-json-line-output.ts',
  );
  const graph = await collectPtcStaticImportGraph(sourceUrl);

  assert.deepEqual(readPtcStaticImportSpecifiers(graph, sourceUrl), [
    '../../../shared/record-shape.js',
    './lab-browser-output-guard.js',
  ]);
  for (const forbiddenSource of [
    '/lab/browser/user-url-navigation/',
    '/lab/browser/page-load-evidence/',
    '/lab/browser/text-evidence/',
    '/lab/browser/core/lab-browser-result-contract.ts',
    '/lab/browser/core/lab-browser-runtime-command.ts',
  ]) {
    assert.equal(
      ptcStaticImportGraphIncludesSource(graph, forbiddenSource),
      false,
      forbiddenSource,
    );
  }
});

void test('admitPtcLabBrowserJsonLineOutput rejects real stdout boundary failures before shape parsing', () => {
  for (const item of [
    { stdout: '', reason: 'stdout_not_one_json_line' },
    {
      stdout: '{"ok":true}\n{"ok":false}',
      reason: 'stdout_not_one_json_line',
    },
    {
      stdout: '{"ok":true}\r{"ok":false}',
      reason: 'stdout_not_one_json_line',
    },
    { stdout: '{', reason: 'stdout_invalid_json' },
  ] as const) {
    assert.deepEqual(
      admitPtcLabBrowserJsonLineOutput({
        stdout: item.stdout,
      }),
      { ok: false, reason: item.reason },
      item.reason,
    );
  }
});

void test('admitPtcLabBrowserJsonLineOutput applies base, extra, and target leak guards', () => {
  for (const payload of [
    { ok: true, finalUrl: 'https://example.com/final' },
    { ok: true, browserConsole: 'console output' },
    { ok: true, finalUrlDigest: `sha256:${'a'.repeat(64)}` },
    { ok: true, title: 'Page title' },
    { ok: true, hostEcho: 'example.com' },
    { ok: true, queryEcho: '?access_token=secret' },
  ]) {
    const result = admitPtcLabBrowserJsonLineOutput({
      extraForbiddenKeys: ['finalUrlDigest', 'title'],
      forbidTargetHostname: true,
      forbidTargetSearchAndHash: true,
      stdout: JSON.stringify(payload),
      targetUrl: TARGET_URL,
    });

    assert.deepEqual(
      result,
      { ok: false, reason: 'stdout_forbidden_browser_output' },
      JSON.stringify(payload),
    );
    assert.doesNotMatch(JSON.stringify(result), /example\.com|access_token/u);
  }
});

void test('admitPtcLabBrowserJsonLineOutput admits one trimmed JSON line without interpreting shape', () => {
  const payload = {
    ok: true,
    capability: 'owner_specific_capability',
    checks: { cleanupCompleted: true },
  };
  const result = admitPtcLabBrowserJsonLineOutput({
    stdout: `  ${JSON.stringify(payload)}  \n`,
  });

  assert.deepEqual(result, { ok: true, value: payload });
});

void test('admitPtcLabBrowserJsonLineOutput does not reject large JSON lines by byte count', () => {
  const payload = {
    ok: true,
    payload: 'large neutral payload '.repeat(5_000),
  };
  const result = admitPtcLabBrowserJsonLineOutput({
    stdout: JSON.stringify(payload),
  });

  assert.deepEqual(result, { ok: true, value: payload });
});

void test('admitPtcLabBrowserAdapterStdoutEnvelope preserves compact evidence fields after shared shell admission', () => {
  const payload = {
    ok: true,
    capability: 'page_load_evidence_capability',
    checks: { cleanupCompleted: true },
    finalUrlDigest: `sha256:${'a'.repeat(64)}`,
    title: 'Example',
  };

  const result = admitPtcLabBrowserAdapterStdoutEnvelope({
    capability: 'page_load_evidence_capability',
    isChecks,
    stdout: JSON.stringify(payload),
  });

  assert.deepEqual(result, {
    ok: true,
    value: {
      checks: payload.checks,
      parsed: payload,
    },
  });
});

void test('admitPtcLabBrowserAdapterStdoutEnvelope rejects capability/checks drift without owner parsing', () => {
  for (const payload of [
    {
      ok: true,
      capability: 'wrong_capability',
      checks: { cleanupCompleted: true },
    },
    {
      ok: true,
      capability: 'owner_specific_capability',
      checks: { cleanupCompleted: 'true' },
    },
  ]) {
    const result = admitPtcLabBrowserAdapterStdoutEnvelope({
      capability: 'owner_specific_capability',
      isChecks,
      stdout: JSON.stringify(payload),
    });

    assert.deepEqual(
      result,
      { ok: false, reason: 'stdout_invalid_shape' },
      JSON.stringify(payload),
    );
  }
});

void test('parsePtcLabBrowserAdapterStdout rejects owner-shape drift before result mapping', () => {
  const cases = [
    {
      stdout: JSON.stringify({
        ok: true,
        capability: 'wrong_capability',
        checks: { cleanupCompleted: true },
      }),
      reason: 'stdout_invalid_shape',
    },
    {
      stdout: JSON.stringify({
        ok: false,
        capability: 'owner_specific_capability',
        checks: { cleanupCompleted: true },
        errorCode: 'future_error_code',
      }),
      reason: 'stdout_invalid_result',
    },
    {
      stdout: JSON.stringify({
        ok: false,
        capability: 'owner_specific_capability',
        checks: { cleanupCompleted: true },
      }),
      reason: 'stdout_invalid_result',
    },
  ] as const;

  for (const item of cases) {
    const result = parsePtcLabBrowserAdapterStdout({
      capability: 'owner_specific_capability',
      errorCodes: ['known_error_code'],
      isChecks,
      stdout: item.stdout,
    });

    assert.deepEqual(result, { ok: false, reason: item.reason }, item.reason);
  }
});

void test('parsePtcLabBrowserAdapterStdout applies leak admission before adapter shape parsing', () => {
  const result = parsePtcLabBrowserAdapterStdout({
    capability: 'owner_specific_capability',
    errorCodes: ['known_error_code'],
    forbidTargetHostname: true,
    forbidTargetSearchAndHash: true,
    isChecks,
    stdout: JSON.stringify({
      ok: false,
      capability: 'owner_specific_capability',
      checks: { cleanupCompleted: true },
      errorCode: 'known_error_code',
      leaked: 'https://example.com/private?access_token=secret#id_token',
    }),
    targetUrl: TARGET_URL,
  });

  assert.deepEqual(result, {
    ok: false,
    reason: 'stdout_forbidden_browser_output',
  });
  assert.doesNotMatch(JSON.stringify(result), /example\.com|access_token/u);
});

void test('formatPtcLabBrowserAdapterStdoutParseFailure keeps owner messages deterministic', () => {
  assert.equal(
    formatPtcLabBrowserAdapterStdoutParseFailure({
      reason: 'stdout_invalid_result',
      subject: 'user URL navigation',
    }),
    'PTC lab browser user URL navigation stdout has invalid result',
  );
  assert.equal(
    formatPtcLabBrowserAdapterStdoutParseFailure({
      reason: 'stdout_forbidden_browser_output',
      subject: 'runtime probe',
    }),
    'PTC lab browser runtime probe stdout contains forbidden browser output',
  );
});

function isChecks(value: unknown): value is { cleanupCompleted: boolean } {
  return (
    typeof value === 'object' &&
    value !== null &&
    'cleanupCompleted' in value &&
    typeof value.cleanupCompleted === 'boolean'
  );
}
