import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildRunChannelAuthMessage,
  buildShellAuthHeaders,
  COOKIE_AUTH_RUN_CHANNEL_TOKEN,
  DEV_TOKEN_HEADER_NAME,
  type ShellAuthBootstrap,
} from './shell-auth.js';

const BOOTSTRAP: ShellAuthBootstrap = {
  mode: 'dev-token',
  token: 'test-token-123456',
};

void test('buildShellAuthHeaders emits the canonical daemon auth header', () => {
  assert.deepEqual(buildShellAuthHeaders(BOOTSTRAP), {
    'Content-Type': 'application/json',
    [DEV_TOKEN_HEADER_NAME]: 'test-token-123456',
  });
});

void test('buildShellAuthHeaders omits the daemon secret when cookie auth is active', () => {
  assert.deepEqual(buildShellAuthHeaders({ mode: 'dev-cookie' }), {
    'Content-Type': 'application/json',
  });
});

void test('buildRunChannelAuthMessage uses a non-secret websocket sentinel for cookie auth', () => {
  assert.deepEqual(buildRunChannelAuthMessage('req-1'), {
    type: 'run.auth',
    requestId: 'req-1',
    token: COOKIE_AUTH_RUN_CHANNEL_TOKEN,
  });
});

void test('buildRunChannelAuthMessage still supports explicit legacy token auth', () => {
  assert.deepEqual(buildRunChannelAuthMessage('req-1', BOOTSTRAP), {
    type: 'run.auth',
    requestId: 'req-1',
    token: 'test-token-123456',
  });
});
