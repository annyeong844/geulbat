import assert from 'node:assert/strict';
import test from 'node:test';
import {
  sanitizePtcOutput,
  sanitizePtcPrivateMarkers,
} from './output-redaction.js';

void test('sanitizePtcPrivateMarkers redacts shared PTC private markers and unquoted secrets', () => {
  const cases = [
    {
      input: '/geulbat/package-cache/npm/.npmrc',
      forbidden: /\/geulbat\/package-cache|\.npmrc/u,
      expected: /\[redacted:package-cache-path\]/u,
    },
    {
      input: '/tmp/geulbat-package-installs/install-1/.npmrc',
      forbidden: /\/tmp\/geulbat-package-installs|\.npmrc/u,
      expected: /\[redacted:install-workdir\]/u,
    },
    {
      input: '/geulbat/artifacts/candidate.txt',
      forbidden: /\/geulbat\/artifacts/u,
      expected: /\[redacted:artifact-path\]/u,
    },
    {
      input: '/geulbat/callbacks/epoch-1/callback.sock',
      forbidden: /\/geulbat\/callbacks|callback\.sock/u,
      expected: /\[redacted:callback-path\]/u,
    },
    {
      input: '/var/run/docker.sock',
      forbidden: /\/var\/run\/docker\.sock/u,
      expected: /\[redacted:docker-socket\]/u,
    },
    {
      input: '/tmp/geulbat-private/.geulbat/provider.json',
      forbidden: /geulbat-private|\.geulbat/u,
      expected: /\[redacted:path\]/u,
    },
    {
      input: 'token=secret',
      forbidden: /token=secret/u,
      expected: /\[redacted:secret\]/u,
    },
    {
      input: 'access_token=secret',
      forbidden: /access_token=secret/u,
      expected: /\[redacted:secret\]/u,
    },
    {
      input: 'provider_secret="secret"',
      forbidden: /provider_secret="secret"/u,
      expected: /\[redacted:secret\]/u,
    },
    {
      input: 'Authorization: Bearer local-token',
      forbidden: /Authorization|Bearer|local-token/u,
      expected: /\[redacted:secret\]/u,
    },
    {
      input: '"access_token":"eyJhbGciOiJredacted"',
      forbidden: /access_token|eyJhbGci/u,
      expected: /\[redacted:secret\]/u,
    },
    {
      input: '"authorization": "Bearer eyJhbGciOiJredacted"',
      forbidden: /authorization|Bearer|eyJhbGci/u,
      expected: /\[redacted:secret\]/u,
    },
  ];

  for (const item of cases) {
    const sanitized = sanitizePtcPrivateMarkers(item.input);
    assert.doesNotMatch(sanitized, item.forbidden, item.input);
    assert.match(sanitized, item.expected, item.input);
  }
});

void test('sanitizePtcPrivateMarkers redacts URLs only when the caller opts in', () => {
  const url = 'https://registry.npmjs.org/@scope/pkg';

  assert.equal(sanitizePtcPrivateMarkers(url), url);
  assert.equal(
    sanitizePtcPrivateMarkers(url, { redactUrls: true }),
    '[redacted:url]',
  );
});

void test('sanitizePtcOutput truncates after private markers are redacted', () => {
  const result = sanitizePtcOutput(
    `/tmp/geulbat-private/.geulbat/provider.json ${'x'.repeat(64)}`,
    24,
  );

  assert.equal(result.truncated, true);
  assert.doesNotMatch(result.value, /geulbat-private|\.geulbat/u);
  assert.match(result.value, /\[redacted:path\]/u);
  assert.match(result.value, /\[truncated\]/u);
});
