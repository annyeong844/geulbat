import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DEV_TOKEN_HEADER_NAME,
  SHELL_ACCESS_TOKEN_META_NAME,
} from '@geulbat/protocol/shell-auth';

import {
  buildRunChannelAuthMessage,
  buildShellAuthHeaders,
  readShellAccessTokenFromDocument,
} from './shell-auth.js';

/**
 * 데몬이 진입 문서에 심는 meta를 그대로 재현한다. 조회 문자열까지 실제 값이라
 * 선택자가 바뀌면 이 대역이 먼저 못 찾는다.
 */
function documentWithMeta(content: string | null): {
  querySelector: (selectors: string) => {
    getAttribute: (name: string) => string | null;
  } | null;
} {
  return {
    querySelector: (selectors) =>
      selectors === `meta[name="${SHELL_ACCESS_TOKEN_META_NAME}"]` &&
      content !== null
        ? { getAttribute: (name) => (name === 'content' ? content : null) }
        : null,
  };
}

void test('the daemon-served document supplies the access token', () => {
  assert.equal(
    readShellAccessTokenFromDocument(documentWithMeta('token-from-document')),
    'token-from-document',
  );
});

void test('a served document without the token is a failure, not a fallback', () => {
  // 데몬이 화면을 서빙하는 위상이 하나뿐이다. 문서가 왔는데 토큰이 없으면 그
  // 문서는 데몬이 낸 것이 아니므로, 대체값으로 덮지 않고 원인을 드러낸다.
  assert.throws(
    () => readShellAccessTokenFromDocument(documentWithMeta(null)),
    new RegExp(SHELL_ACCESS_TOKEN_META_NAME),
  );
  assert.throws(() => readShellAccessTokenFromDocument(documentWithMeta('  ')));
});

void test('a missing document means there is no token to read', () => {
  // 브라우저가 아닌 실행 환경(도구, Node 테스트)에는 토큰이 있을 자리가 없다.
  // 이것은 설정 오류가 아니라 다른 환경이므로 실패로 올리지 않는다.
  assert.equal(readShellAccessTokenFromDocument(undefined), undefined);
});

void test('the token authenticates both the http and websocket surfaces', () => {
  assert.equal(
    buildShellAuthHeaders('token-from-document')[DEV_TOKEN_HEADER_NAME],
    'token-from-document',
  );
  assert.deepEqual(
    buildRunChannelAuthMessage('request-1', 'token-from-document'),
    {
      type: 'run.auth',
      requestId: 'request-1',
      token: 'token-from-document',
    },
  );
});

void test('without a token the http request carries no credential header', () => {
  // 자격증명이 없는 요청은 잘 정의된 상태다: 데몬이 401로 답하고 이유가 남는다.
  const headers = buildShellAuthHeaders(undefined);
  assert.equal(headers[DEV_TOKEN_HEADER_NAME], undefined);
  assert.equal(headers['Content-Type'], 'application/json');
});

void test('without a token the run channel refuses to send an empty credential', () => {
  // `run.auth` 프레임은 자격증명 그 자체다. 빈 문자열을 채우면 데몬은 "틀린
  // 토큰"으로 읽고, 진짜 원인(토큰을 못 읽었다)은 사라진다.
  assert.throws(
    () => buildRunChannelAuthMessage('request-1', undefined),
    /shell access token/,
  );
});
