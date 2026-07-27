import test from 'node:test';
import assert from 'node:assert/strict';
import { DEV_TOKEN_HEADER_NAME } from '@geulbat/protocol/shell-auth';

import * as shellAuth from './shell-auth.js';
import {
  INVALID_DEV_TOKEN_MESSAGE,
  SHELL_AUTH_ALLOWED_HEADERS,
  isAuthorizedShellHeaders,
  isAuthorizedShellWebSocketToken,
} from './shell-auth.js';

function withTokenEnv(token: string, fn: () => void): void {
  const previous = process.env['GEULBAT_DEV_TOKEN'];
  process.env['GEULBAT_DEV_TOKEN'] = token;
  try {
    fn();
  } finally {
    if (previous === undefined) {
      delete process.env['GEULBAT_DEV_TOKEN'];
    } else {
      process.env['GEULBAT_DEV_TOKEN'] = previous;
    }
  }
}

void test('shell auth module keeps parser internals private', () => {
  assert.equal('DEV_TOKEN_HEADER_NAME' in shellAuth, false);
  assert.equal('DEV_AUTH_COOKIE_NAME' in shellAuth, false);
  assert.equal('readShellAuthHeader' in shellAuth, false);
  assert.equal('readShellAuthCookie' in shellAuth, false);
  assert.equal('hasShellAuthCookie' in shellAuth, false);
});

void test('shell auth seam shares the same header name and unauthorized message', () => {
  assert.equal(DEV_TOKEN_HEADER_NAME, 'X-Geulbat-Dev-Token');
  assert.equal(
    INVALID_DEV_TOKEN_MESSAGE,
    'missing or invalid X-Geulbat-Dev-Token',
  );
  assert.equal(SHELL_AUTH_ALLOWED_HEADERS, 'Content-Type, X-Geulbat-Dev-Token');
});

void test('shell auth seam validates explicit HTTP headers and websocket tokens', () => {
  withTokenEnv('test-token-123456', () => {
    assert.equal(
      isAuthorizedShellHeaders({
        'x-geulbat-dev-token': 'test-token-123456',
      }),
      true,
    );
    assert.equal(
      isAuthorizedShellHeaders({
        'x-geulbat-dev-token': 'wrong-token',
      }),
      false,
    );
    assert.equal(
      isAuthorizedShellHeaders({
        cookie: 'geulbat_dev_auth=test-token-123456',
      }),
      true,
    );
    assert.equal(
      isAuthorizedShellHeaders({
        cookie: 'geulbat_dev_auth=wrong-token',
      }),
      false,
    );
    assert.equal(isAuthorizedShellWebSocketToken('test-token-123456'), true);
    assert.equal(isAuthorizedShellWebSocketToken('wrong-token'), false);
  });
});
