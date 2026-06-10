import assert from 'node:assert/strict';
import test from 'node:test';
import {
  PTC_LAB_BROWSER_SUMMARY_ONLY_EXTRA_FORBIDDEN_OUTPUT_KEYS,
  containsForbiddenBrowserOutputKey,
  containsForbiddenBrowserOutputValue,
  containsForbiddenBrowserTitle,
} from './lab-browser-output-guard.js';

void test('containsForbiddenBrowserOutputKey rejects shared raw browser/session output keys', () => {
  for (const key of [
    'browserConsole',
    'finalUrl',
    'labSessionId',
    'responseHeaders',
    'serverIp',
    'statusCode',
    'userDataDir',
  ]) {
    assert.equal(
      containsForbiddenBrowserOutputKey({ nested: { [key]: 'leak' } }),
      true,
      key,
    );
  }
});

void test('containsForbiddenBrowserOutputKey keeps page-load evidence keys allowed by default', () => {
  assert.equal(
    containsForbiddenBrowserOutputKey({
      finalUrlDigest:
        'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      navigationDurationMs: 12,
      redirectCount: 1,
      responseStatus: { code: 200, source: 'final_main_resource_response' },
      title: { text: 'Example', charCount: 7 },
    }),
    false,
  );
});

void test('containsForbiddenBrowserOutputKey can reject page-load evidence fields for summary-only owners', () => {
  assert.equal(
    containsForbiddenBrowserOutputKey(
      { finalUrlDigest: 'sha256:digest', title: { text: 'Example' } },
      {
        extraForbiddenKeys:
          PTC_LAB_BROWSER_SUMMARY_ONLY_EXTRA_FORBIDDEN_OUTPUT_KEYS,
      },
    ),
    true,
  );
});

void test('containsForbiddenBrowserOutputKey keeps safe nested values and treats empty extra keys as default policy', () => {
  assert.equal(containsForbiddenBrowserOutputKey('plain text'), false);
  assert.equal(
    containsForbiddenBrowserOutputKey([
      { summary: { loaded: true } },
      { metrics: [{ durationMs: 12 }] },
    ]),
    false,
  );
  assert.equal(
    containsForbiddenBrowserOutputKey(
      { title: { text: 'Example' } },
      { extraForbiddenKeys: [] },
    ),
    false,
  );
});

void test('containsForbiddenBrowserOutputValue detects URL, secret, path, and selected target leaks', () => {
  assert.equal(
    containsForbiddenBrowserOutputValue({ value: 'https://example.com' }),
    true,
  );
  assert.equal(
    containsForbiddenBrowserOutputValue({ value: 'access_token=secret' }),
    true,
  );
  assert.equal(
    containsForbiddenBrowserOutputValue({
      value: 'profile /tmp/geulbat-private/.geulbat/browser',
    }),
    true,
  );
  assert.equal(
    containsForbiddenBrowserOutputValue({
      forbidTargetHostname: true,
      forbidTargetSearchAndHash: true,
      targetUrl: 'https://app.local/path?access_token=secret#id_token=secret',
      value: 'app.local',
    }),
    true,
  );
  assert.equal(
    containsForbiddenBrowserOutputValue({
      forbidTargetSearchAndHash: true,
      targetUrl: 'https://app.local/path?nonce=private#frag',
      value: '?nonce=private',
    }),
    true,
  );
});

void test('containsForbiddenBrowserOutputValue treats safe nested output as non-leaking', () => {
  assert.equal(containsForbiddenBrowserOutputValue({ value: null }), false);
  assert.equal(
    containsForbiddenBrowserOutputValue({
      value: {
        checks: [{ cleanupCompleted: true }, { navigationSettled: true }],
        message: 'loaded with digest-only URL echo',
      },
    }),
    false,
  );
});

void test('containsForbiddenBrowserOutputValue ignores malformed target URL but still applies generic leak guards', () => {
  assert.equal(
    containsForbiddenBrowserOutputValue({
      forbidTargetHostname: true,
      forbidTargetSearchAndHash: true,
      targetUrl: 'not a url',
      value: 'app.local',
    }),
    false,
  );
  assert.equal(
    containsForbiddenBrowserOutputValue({
      forbidTargetHostname: true,
      forbidTargetSearchAndHash: true,
      targetUrl: 'not a url',
      value: 'Bearer local-token',
    }),
    true,
  );
});

void test('containsForbiddenBrowserOutputValue makes target hostname, search, hash, and HTML checks opt-in', () => {
  assert.equal(
    containsForbiddenBrowserOutputValue({
      targetUrl: 'https://app.local/path?nonce=private#frag',
      value: 'app.local ?nonce=private #frag <script>alert(1)</script>',
    }),
    false,
  );
  assert.equal(
    containsForbiddenBrowserOutputValue({
      forbidTargetHostname: true,
      targetUrl: 'https://app.local/path?nonce=private#frag',
      value: 'APP.LOCAL',
    }),
    true,
  );
  assert.equal(
    containsForbiddenBrowserOutputValue({
      forbidTargetSearchAndHash: true,
      targetUrl: 'https://app.local/path?nonce=private#frag',
      value: '#frag',
    }),
    true,
  );
  assert.equal(
    containsForbiddenBrowserOutputValue({
      forbidHtmlText: true,
      value: '<html><body>debug</body></html>',
    }),
    true,
  );
});

void test('containsForbiddenBrowserTitle rejects control, token, URL, and HTML-like text', () => {
  for (const value of [
    'bad\u0001title',
    'https://example.com',
    'access_token=secret',
    '<script>alert(1)</script>',
    '?nonce=private',
  ]) {
    assert.equal(
      containsForbiddenBrowserTitle({
        targetUrl: 'https://app.local/path?nonce=private',
        value,
      }),
      true,
      value,
    );
  }
});

void test('containsForbiddenBrowserTitle allows ordinary titles and ignores malformed target URL fragments', () => {
  assert.equal(containsForbiddenBrowserTitle({ value: 'Plain title' }), false);
  assert.equal(
    containsForbiddenBrowserTitle({
      targetUrl: 'not a url',
      value: '?nonce=private',
    }),
    false,
  );
});
