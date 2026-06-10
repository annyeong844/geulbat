import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  digestPtcLabBrowserUserUrlNavigationTarget,
  normalizePtcLabBrowserUserUrlNavigationTarget,
  PTC_LAB_BROWSER_BODY_NONE_POLICY_ID,
  PTC_LAB_BROWSER_CALLER_HEADERS_NONE_POLICY_ID,
  PTC_LAB_BROWSER_URL_GRAMMAR_HTTP_HTTPS_NO_CREDENTIALS_POLICY_ID,
  PTC_LAB_BROWSER_USER_URL_MAX_BYTES,
  type PtcLabBrowserUserUrlAdmissionFailureReasonCode,
  type PtcLabBrowserUserUrlNavigationTarget,
} from './lab-browser-url-navigation.js';

void test('user URL target normalization canonicalizes admitted http and https URL intents', () => {
  const result = normalizePtcLabBrowserUserUrlNavigationTarget({
    url: '\t https://EXAMPLE.com/a%20b?x=1#frag \n',
  });

  assert.equal(result.ok, true);
  const target = expectTarget(result);
  assert.deepEqual(target, {
    url: 'https://example.com/a%20b?x=1#frag',
    method: 'GET',
    callerHeadersPolicyId: PTC_LAB_BROWSER_CALLER_HEADERS_NONE_POLICY_ID,
    bodyPolicyId: PTC_LAB_BROWSER_BODY_NONE_POLICY_ID,
    urlGrammarPolicyId:
      PTC_LAB_BROWSER_URL_GRAMMAR_HTTP_HTTPS_NO_CREDENTIALS_POLICY_ID,
    targetDigest: target.targetDigest,
  });
  assert.match(target.targetDigest, /^sha256:[0-9a-f]{64}$/u);
  assert.equal(Object.hasOwn(target, 'navigationAttemptDigest'), false);
});

void test('user URL target digest is stable, caller-intent-only, and excludes timeout policy', () => {
  const first = expectTarget(
    normalizePtcLabBrowserUserUrlNavigationTarget({
      url: 'https://example.com/path',
      timeoutMs: 1000,
    }),
  );
  const second = expectTarget(
    normalizePtcLabBrowserUserUrlNavigationTarget({
      url: 'https://example.com/path',
      timeoutMs: 5000,
    }),
  );
  const changed = expectTarget(
    normalizePtcLabBrowserUserUrlNavigationTarget({
      url: 'https://example.com/other',
      timeoutMs: 1000,
    }),
  );

  assert.equal(first.targetDigest, second.targetDigest);
  assert.notEqual(first.targetDigest, changed.targetDigest);
  assert.equal(
    digestPtcLabBrowserUserUrlNavigationTarget({
      url: first.url,
      method: first.method,
      callerHeadersPolicyId: first.callerHeadersPolicyId,
      bodyPolicyId: first.bodyPolicyId,
      urlGrammarPolicyId: first.urlGrammarPolicyId,
    }),
    first.targetDigest,
  );
});

void test('user URL target normalization accepts localhost, loopback, private ranges, and container DNS as URL intents', () => {
  const urls = [
    'http://localhost:3000/',
    'http://127.0.0.1:5173/',
    'http://10.0.0.2/',
    'http://172.16.0.2/',
    'http://192.168.1.50/',
    'http://app:3000/',
  ];

  for (const url of urls) {
    const target = expectTarget(
      normalizePtcLabBrowserUserUrlNavigationTarget({ url }),
    );
    assert.equal(target.url, url);
  }
});

void test('user URL target normalization rejects malformed or unsafe admitted fields before browser acquisition', () => {
  const tooLargeUrl = `https://example.com/${'a'.repeat(
    PTC_LAB_BROWSER_USER_URL_MAX_BYTES,
  )}`;
  const cases: Array<{
    name: string;
    request: unknown;
    reasonCode: PtcLabBrowserUserUrlAdmissionFailureReasonCode;
  }> = [
    {
      name: 'request is not an object',
      request: 'https://example.com/',
      reasonCode: 'url_not_string',
    },
    {
      name: 'url is not a string',
      request: { url: 123 },
      reasonCode: 'url_not_string',
    },
    {
      name: 'url is empty after ASCII trim',
      request: { url: '\t \r\n' },
      reasonCode: 'url_empty',
    },
    {
      name: 'url is over byte limit',
      request: { url: tooLargeUrl },
      reasonCode: 'url_too_large',
    },
    {
      name: 'unsupported scheme',
      request: { url: 'ftp://example.com/' },
      reasonCode: 'url_scheme_not_admitted_by_grammar_policy',
    },
    {
      name: 'relative URL',
      request: { url: 'example.com' },
      reasonCode: 'url_parse_failed',
    },
    {
      name: 'embedded raw space',
      request: { url: 'https://example.com/a b' },
      reasonCode: 'url_raw_control_character_disallowed',
    },
    {
      name: 'embedded newline',
      request: { url: 'https://example.com/a\nb' },
      reasonCode: 'url_raw_control_character_disallowed',
    },
    {
      name: 'embedded control character',
      request: { url: 'https://example.com/a\u0007b' },
      reasonCode: 'url_raw_control_character_disallowed',
    },
  ];

  for (const item of cases) {
    const result = normalizePtcLabBrowserUserUrlNavigationTarget(item.request);
    assert.equal(result.ok, false, item.name);
    assert.equal(
      result.ok ? '' : result.reasonCode,
      item.reasonCode,
      item.name,
    );
  }
});

void test('user URL target normalization rejects userinfo delimiter cases as credentials', () => {
  const urls = [
    'https://user@example.com/',
    'https://user:pass@example.com/',
    'https://%75ser@example.com/',
    'https://@example.com/',
  ];

  for (const url of urls) {
    const result = normalizePtcLabBrowserUserUrlNavigationTarget({ url });
    assert.equal(result.ok, false, url);
    assert.equal(
      result.ok ? '' : result.reasonCode,
      'url_credentials_disallowed',
      url,
    );
  }
});

void test('user URL target normalization rejects browser address-bar recovery inputs in v1 grammar', () => {
  const urls = [
    'example.com',
    '//example.com',
    'https:example.com',
    'https:/example.com',
    String.raw`http:\\example.com`,
  ];

  for (const url of urls) {
    const result = normalizePtcLabBrowserUserUrlNavigationTarget({ url });
    assert.equal(result.ok, false, url);
    assert.equal(result.ok ? '' : result.reasonCode, 'url_parse_failed', url);
  }
});

void test('user URL target normalization classifies later-owner fields without leaking raw values', () => {
  const result = normalizePtcLabBrowserUserUrlNavigationTarget({
    url: 'https://example.com/private?access_token=secret#id_token=secret',
    screenshot: true,
  });

  assert.equal(result.ok, false);
  assert.equal(result.ok ? '' : result.reasonCode, 'unsupported_by_this_owner');
  assert.deepEqual(result.ok ? undefined : result.diagnostics, {
    unsupportedCategory: 'browser_evidence',
  });
  assert.doesNotMatch(
    JSON.stringify(result),
    /example\.com|access_token|id_token|secret|true/iu,
  );
});

void test('user URL admission diagnostics do not echo credential-bearing URLs', () => {
  const result = normalizePtcLabBrowserUserUrlNavigationTarget({
    url: 'https://user:pass@example.com/?access_token=secret#id_token=secret',
  });

  assert.equal(result.ok, false);
  assert.equal(
    result.ok ? '' : result.reasonCode,
    'url_credentials_disallowed',
  );
  assert.doesNotMatch(
    JSON.stringify(result),
    /user:pass|example\.com|access_token|id_token|secret/iu,
  );
});

void test('user URL grammar owner does not import browser runtime or session owners', async () => {
  const source = await readFile(
    'src/daemon/ptc/lab-browser-url-navigation.ts',
    'utf8',
  );
  const runtimeContractSource = await readFile(
    'src/daemon/ptc/lab-browser-user-url-navigation-contract.ts',
    'utf8',
  );

  assert.doesNotMatch(
    source,
    /from '\.\/(?:lab-browser-(?:navigation|owner|policy|runtime)|session-docker)\.js'/u,
  );
  assert.doesNotMatch(source, /runPtcLabBrowser|PtcSessionDocker|newContext/u);
  assert.match(source, /export type PtcLabBrowserUserUrlAdmissionResult<T>/u);
  assert.doesNotMatch(
    source,
    /export type PtcLabBrowserUserUrlNavigationResult<T>/u,
  );
  assert.doesNotMatch(
    runtimeContractSource,
    /export\s+\{\s*PTC_LAB_BROWSER_USER_URL_NAVIGATION_CAPABILITY\s*\}/u,
  );
});

function expectTarget(
  result: ReturnType<typeof normalizePtcLabBrowserUserUrlNavigationTarget>,
): PtcLabBrowserUserUrlNavigationTarget {
  assert.equal(result.ok, true);
  return result.value;
}
