import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEV_AUTH_COOKIE_NAME,
  DEV_TOKEN_HEADER_NAME,
  INVALID_DEV_TOKEN_MESSAGE,
  SHELL_AUTH_ALLOWED_HEADERS,
  hasShellAuthCookie,
  isAuthorizedShellHeaders,
  isAuthorizedShellWebSocketToken,
  readShellAuthCookie,
  readShellAuthHeader,
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

void test('readShellAuthHeader reads the canonical daemon auth header name', () => {
  assert.equal(
    readShellAuthHeader({
      'x-geulbat-dev-token': 'test-token-123456',
    }),
    'test-token-123456',
  );
});

void test('readShellAuthCookie reads the canonical daemon auth cookie name', () => {
  assert.equal(
    readShellAuthCookie({
      cookie: `${DEV_AUTH_COOKIE_NAME}=test-token-123456; other=value`,
    }),
    'test-token-123456',
  );
});

void test('hasShellAuthCookie reflects cookie presence without validating the token', () => {
  assert.equal(
    hasShellAuthCookie({
      cookie: `${DEV_AUTH_COOKIE_NAME}=test-token-123456`,
    }),
    true,
  );
  assert.equal(hasShellAuthCookie({}), false);
});

void test('readShellAuthCookie reports malformed auth cookie values', () => {
  const originalWarn = console.warn;
  const warnings: unknown[][] = [];
  console.warn = (...args: unknown[]) => {
    warnings.push(args);
  };
  try {
    assert.equal(
      readShellAuthCookie({
        cookie: `${DEV_AUTH_COOKIE_NAME}=%`,
      }),
      undefined,
    );
  } finally {
    console.warn = originalWarn;
  }

  assert.equal(warnings.length, 1);
  assert.match(String(warnings[0]?.[0]), /shell auth cookie decode failed/);
});

void test('shell auth seam shares the same header name and unauthorized message', () => {
  assert.equal(DEV_TOKEN_HEADER_NAME, 'X-Geulbat-Dev-Token');
  assert.equal(DEV_AUTH_COOKIE_NAME, 'geulbat_dev_auth');
  assert.equal(
    INVALID_DEV_TOKEN_MESSAGE,
    'missing or invalid X-Geulbat-Dev-Token',
  );
  assert.equal(SHELL_AUTH_ALLOWED_HEADERS, 'Content-Type, X-Geulbat-Dev-Token');
});

void test('shell auth seam validates both HTTP headers and websocket tokens', () => {
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
    assert.equal(isAuthorizedShellWebSocketToken('test-token-123456'), true);
    assert.equal(isAuthorizedShellWebSocketToken('wrong-token'), false);
  });
});
