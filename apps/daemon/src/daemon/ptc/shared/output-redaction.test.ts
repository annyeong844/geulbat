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
      input: 'provider_material=local-provider-material',
      forbidden: /provider_material|local-provider-material/u,
      expected: /\[redacted:secret\]/u,
    },
    {
      input: 'oauth_token=local-oauth-token',
      forbidden: /oauth_token|local-oauth-token/u,
      expected: /\[redacted:secret\]/u,
    },
    {
      input: 'session-secret=local-session-secret',
      forbidden: /session-secret|local-session-secret/u,
      expected: /\[redacted:secret\]/u,
    },
    {
      input: 'refresh_token=local-refresh-token',
      forbidden: /refresh_token|local-refresh-token/u,
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
    {
      input: 'api_key=sk-local-secret',
      forbidden: /api_key|sk-local-secret/u,
      expected: /\[redacted:secret\]/u,
    },
    {
      input: 'registry=https://registry.npmjs.org/:_authToken=secret',
      forbidden: /registry\.npmjs|_authToken/u,
      expected: /\[redacted:secret\]/u,
    },
    {
      input: 'npmrc=//registry.npmjs.org/:_authToken=secret',
      forbidden: /npmrc|registry\.npmjs|_authToken/u,
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

void test('sanitizePtcOutput redacts private markers without truncating success output', () => {
  const longSuffix = 'x'.repeat(64);
  const result = sanitizePtcOutput(
    `/tmp/geulbat-private/.geulbat/provider.json ${longSuffix}`,
  );

  assert.doesNotMatch(result, /geulbat-private|\.geulbat/u);
  assert.match(result, /\[redacted:path\]/u);
  assert.match(result, new RegExp(`${longSuffix}$`, 'u'));
  assert.doesNotMatch(result, /\[truncated\]/u);
});
