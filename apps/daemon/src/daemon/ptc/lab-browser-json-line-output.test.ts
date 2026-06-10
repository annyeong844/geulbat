import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  admitPtcLabBrowserAdapterStdoutEnvelope,
  admitPtcLabBrowserJsonLineOutput,
  formatPtcLabBrowserAdapterStdoutParseFailure,
  parsePtcLabBrowserAdapterStdout,
} from './lab-browser-json-line-output.js';

const TARGET_URL = 'https://example.com/private?access_token=secret#id_token';

void test('browser JSON-line output admission has no public result-owner dependency', async () => {
  const source = await readFile(
    new URL(
      '../../../src/daemon/ptc/lab-browser-json-line-output.ts',
      import.meta.url,
    ),
    'utf8',
  );

  assert.match(source, /lab-browser-output-guard\.js/u);
  assert.doesNotMatch(source, /browser[A-Za-z]+Failure/u);
  assert.doesNotMatch(
    source,
    /lab-browser-(?:user-url-navigation|page-load-evidence|runtime|navigation)-(?:contract|result|output)\.js/u,
  );
});

void test('admitPtcLabBrowserJsonLineOutput rejects real stdout boundary failures before shape parsing', () => {
  for (const item of [
    {
      stdout: `${JSON.stringify({ ok: true })}${'x'.repeat(32)}`,
      maxStdoutBytes: 8,
      reason: 'stdout_too_large',
    },
    { stdout: '', maxStdoutBytes: 1024, reason: 'stdout_not_one_json_line' },
    {
      stdout: '{"ok":true}\n{"ok":false}',
      maxStdoutBytes: 1024,
      reason: 'stdout_not_one_json_line',
    },
    {
      stdout: '{"ok":true}\r{"ok":false}',
      maxStdoutBytes: 1024,
      reason: 'stdout_not_one_json_line',
    },
    { stdout: '{', maxStdoutBytes: 1024, reason: 'stdout_invalid_json' },
  ] as const) {
    assert.deepEqual(
      admitPtcLabBrowserJsonLineOutput({
        maxStdoutBytes: item.maxStdoutBytes,
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
      maxStdoutBytes: 1024,
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
    maxStdoutBytes: 1024,
    stdout: `  ${JSON.stringify(payload)}  \n`,
  });

  assert.deepEqual(result, { ok: true, value: payload });
});

void test('admitPtcLabBrowserAdapterStdoutEnvelope preserves compact evidence fields after shared shell admission', () => {
  const payload = {
    ok: true,
    capability: 'page_load_evidence_capability',
    checks: { cleanupCompleted: true },
    finalUrlDigest: `sha256:${'a'.repeat(64)}`,
    title: {
      text: 'Example',
      charCount: 7,
      truncated: false,
      maxChars: 160,
      redacted: false,
    },
  };

  const result = admitPtcLabBrowserAdapterStdoutEnvelope({
    capability: 'page_load_evidence_capability',
    isChecks,
    maxStdoutBytes: 1024,
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
      maxStdoutBytes: 1024,
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
      maxStdoutBytes: 1024,
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
    maxStdoutBytes: 1024,
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
