import test from 'node:test';
import assert from 'node:assert/strict';

import {
  isAllowedBrowserOrigin,
  readConfiguredAllowedOrigins,
  readRequestSelfOrigin,
} from './origin-policy.js';

const NO_CONFIGURED_ORIGINS = new Set<string>();

void test('a browser origin is allowed when it is the origin the request arrived at', () => {
  const selfOrigin = readRequestSelfOrigin('127.0.0.1:3456');

  assert.equal(selfOrigin, 'http://127.0.0.1:3456');
  assert.equal(
    isAllowedBrowserOrigin(
      'http://127.0.0.1:3456',
      NO_CONFIGURED_ORIGINS,
      selfOrigin,
    ),
    true,
  );
});

void test('other local origins are not the shell', () => {
  // 데몬이 화면까지 서빙하므로 shell은 데몬 자신의 origin에 산다. loopback이면
  // 포트를 묻지 않던 예전 정책은 같은 기계의 다른 로컬 페이지까지 열어두었다.
  const selfOrigin = readRequestSelfOrigin('127.0.0.1:3456');

  for (const origin of [
    'http://127.0.0.1:5173',
    'http://localhost:3456',
    'https://127.0.0.1:3456',
    'http://192.168.0.10:3456',
  ]) {
    assert.equal(
      isAllowedBrowserOrigin(origin, NO_CONFIGURED_ORIGINS, selfOrigin),
      false,
      origin,
    );
  }
});

void test('an operator can declare additional origins', () => {
  const configured = readConfiguredAllowedOrigins(
    'https://demo.trycloudflare.com',
  );

  assert.equal(
    isAllowedBrowserOrigin(
      'https://demo.trycloudflare.com',
      configured,
      readRequestSelfOrigin('127.0.0.1:3456'),
    ),
    true,
  );
});

void test('a request without a usable Host has nothing to compare against', () => {
  // 비교 대상이 없으면 "같다"고 말할 수 없다. 추측하지 않고 닫는다.
  for (const host of [undefined, '', '   ', 'ho st']) {
    assert.equal(readRequestSelfOrigin(host), undefined, String(host));
  }

  assert.equal(
    isAllowedBrowserOrigin(
      'http://127.0.0.1:3456',
      NO_CONFIGURED_ORIGINS,
      undefined,
    ),
    false,
  );
});

void test('a request without an Origin header is not a browser origin', () => {
  assert.equal(
    isAllowedBrowserOrigin(
      undefined,
      NO_CONFIGURED_ORIGINS,
      readRequestSelfOrigin('127.0.0.1:3456'),
    ),
    false,
  );
});

void test('configured origins must be bare http(s) origins without credentials', () => {
  assert.deepEqual([...readConfiguredAllowedOrigins(undefined)], []);
  assert.deepEqual([...readConfiguredAllowedOrigins('  ')], []);
  assert.throws(
    () => readConfiguredAllowedOrigins('ftp://example.com'),
    /http\/https/,
  );
  assert.throws(
    () => readConfiguredAllowedOrigins('https://user:pw@example.com'),
    /credentials/,
  );
  assert.throws(
    () => readConfiguredAllowedOrigins('https://example.com/path'),
    /bare origins/,
  );
});
