import test from 'node:test';
import assert from 'node:assert/strict';
import { afterEach } from 'node:test';

import {
  didProviderCredentialRefresh,
  getProviderStatusObserveDelayMs,
  isAllowedProviderAuthorizeUrl,
  PROVIDER_AUTH_READY_POLL_MS,
  useProviderAuthState,
} from './use-provider-auth-state.js';
import {
  installFetchSequence,
  installShellAuthDocument,
  jsonResponse,
  renderHook,
} from '../test-support/hook-test.js';

let restoreDocument = () => {};
let restoreFetch = () => {};
let restoreWindow = () => {};

afterEach(() => {
  restoreWindow();
  restoreWindow = () => {};
  restoreFetch();
  restoreFetch = () => {};
  restoreDocument();
  restoreDocument = () => {};
});

void test('isAllowedProviderAuthorizeUrl accepts the canonical OpenAI authorize URL', () => {
  assert.equal(
    isAllowedProviderAuthorizeUrl(
      'https://auth.openai.com/oauth/authorize?response_type=code&client_id=test',
    ),
    true,
  );
});

void test('isAllowedProviderAuthorizeUrl accepts the canonical xAI authorize URL', () => {
  assert.equal(
    isAllowedProviderAuthorizeUrl(
      'https://auth.x.ai/oauth2/authorize?response_type=code&client_id=test',
    ),
    true,
  );
});

void test('isAllowedProviderAuthorizeUrl accepts loopback authorize URLs for local provider auth development', () => {
  assert.equal(
    isAllowedProviderAuthorizeUrl(
      'http://localhost:1455/oauth/authorize?response_type=code',
    ),
    true,
  );
});

void test('isAllowedProviderAuthorizeUrl rejects unexpected external hosts and schemes', () => {
  assert.equal(
    isAllowedProviderAuthorizeUrl('https://evil.example.com/oauth/authorize'),
    false,
  );
  assert.equal(isAllowedProviderAuthorizeUrl('javascript:alert(1)'), false);
});

void test('didProviderCredentialRefresh only fires for ready-to-ready expiry extension', () => {
  assert.equal(
    didProviderCredentialRefresh(
      { state: 'ready', ready: true, expiresAt: 1_000 },
      { state: 'ready', ready: true, expiresAt: 2_000 },
    ),
    true,
  );
  assert.equal(
    didProviderCredentialRefresh(
      {
        state: 'pending',
        ready: false,
        authSessionId: 'auth-1',
        expiresAt: 1_000,
        pollAfterMs: 1000,
      },
      { state: 'ready', ready: true, expiresAt: 2_000 },
    ),
    false,
  );
  assert.equal(
    didProviderCredentialRefresh(
      { state: 'ready', ready: true, expiresAt: 2_000 },
      { state: 'ready', ready: true, expiresAt: 2_000 },
    ),
    false,
  );
});

void test('getProviderStatusObserveDelayMs waits until auth nears expiry, then polls', () => {
  assert.equal(
    getProviderStatusObserveDelayMs(
      {
        state: 'ready',
        ready: true,
        expiresAt: 500_000,
      },
      100_000,
    ),
    310_000,
  );
  assert.equal(
    getProviderStatusObserveDelayMs(
      {
        state: 'ready',
        ready: true,
        expiresAt: 150_000,
      },
      100_000,
    ),
    PROVIDER_AUTH_READY_POLL_MS,
  );
  assert.equal(
    getProviderStatusObserveDelayMs({
      state: 'missing',
      ready: false,
    }),
    null,
  );
});

void test('useProviderAuthState treats already-connected start conflicts as status sync, not UI error', async () => {
  restoreDocument = installShellAuthDocument();
  restoreWindow = installProviderAuthWindow();
  const fetchMock = installFetchSequence(
    () => jsonResponse({ state: 'missing', ready: false }),
    () => jsonResponse({ state: 'missing', ready: false }),
    () =>
      jsonResponse(
        {
          code: 'provider_auth_already_connected',
          message: 'Provider auth is already connected.',
        },
        { status: 409 },
      ),
    () =>
      jsonResponse({
        state: 'ready',
        ready: true,
        expiresAt: 2_000,
      }),
  );
  restoreFetch = fetchMock.restore;

  const hook = await renderHook(useProviderAuthState, undefined);
  await hook.flush();
  await hook.run((current) => current.handleConnectProvider());

  assert.equal(hook.result.current.providerAuthError, null);
  assert.equal(
    hook.result.current.providerAuthNotice,
    'Provider account is already connected.',
  );
  assert.equal(hook.result.current.providerAuthStatus?.state, 'ready');
  hook.unmount();
});

void test('useProviderAuthState skips startProviderAuth when the current status is already ready', async () => {
  restoreDocument = installShellAuthDocument();
  restoreWindow = installProviderAuthWindow();
  const fetchMock = installFetchSequence(
    () =>
      jsonResponse({
        state: 'ready',
        ready: true,
        expiresAt: 2_000,
      }),
    () => jsonResponse({ state: 'missing', ready: false }),
  );
  restoreFetch = fetchMock.restore;

  const hook = await renderHook(useProviderAuthState, undefined);
  await hook.flush();
  await hook.run((current) => current.handleConnectProvider());

  assert.equal(fetchMock.calls.length, 2);
  assert.equal(hook.result.current.providerAuthError, null);
  assert.equal(
    hook.result.current.providerAuthNotice,
    'Provider account is already connected.',
  );
  hook.unmount();
});

void test('useProviderAuthState keeps the same status reference across identical pending polls', async () => {
  restoreDocument = installShellAuthDocument();
  let intervalCallback: (() => void) | null = null;
  restoreWindow = installProviderAuthWindow({
    setInterval(callback: TimerHandler) {
      if (typeof callback !== 'function') {
        throw new Error('provider auth test expected interval callback');
      }
      intervalCallback = () => callback();
      return 1;
    },
    clearInterval() {
      return;
    },
  });
  const fetchMock = installFetchSequence(
    () =>
      jsonResponse({
        state: 'pending',
        ready: false,
        authSessionId: 'auth-1',
        expiresAt: 2_000,
        pollAfterMs: 1000,
      }),
    () => jsonResponse({ state: 'missing', ready: false }),
    () =>
      jsonResponse({
        state: 'pending',
        ready: false,
        authSessionId: 'auth-1',
        expiresAt: 2_000,
        pollAfterMs: 1000,
      }),
    () => jsonResponse({ state: 'missing', ready: false }),
  );
  restoreFetch = fetchMock.restore;

  const hook = await renderHook(useProviderAuthState, undefined);
  await hook.flush();
  const firstStatus = hook.result.current.providerAuthStatus;

  assert.ok(firstStatus);
  assert.equal(firstStatus.state, 'pending');
  assert.ok(intervalCallback);

  await hook.run(async () => {
    intervalCallback?.();
    await Promise.resolve();
    await Promise.resolve();
  });

  assert.equal(fetchMock.calls.length, 4);
  assert.equal(hook.result.current.providerAuthStatus, firstStatus);
  hook.unmount();
});

void test('useProviderAuthState rejects invalid pending poll intervals without scheduling a poll', async () => {
  restoreDocument = installShellAuthDocument();
  let intervalScheduled = false;
  restoreWindow = installProviderAuthWindow({
    setInterval() {
      intervalScheduled = true;
      return 1;
    },
    clearInterval() {
      return;
    },
  });
  const fetchMock = installFetchSequence(
    () =>
      jsonResponse({
        state: 'pending',
        ready: false,
        authSessionId: 'auth-1',
        expiresAt: 2_000,
        pollAfterMs: 0.5,
      }),
    () => jsonResponse({ state: 'missing', ready: false }),
  );
  restoreFetch = fetchMock.restore;

  const hook = await renderHook(useProviderAuthState, undefined);
  await hook.flush();

  assert.equal(fetchMock.calls.length, 2);
  assert.equal(intervalScheduled, false);
  assert.equal(hook.result.current.providerAuthStatus, null);
  assert.match(
    hook.result.current.providerAuthError ?? '',
    /Unable to load provider auth status\./,
  );
  hook.unmount();
});

void test('useProviderAuthState observes ready status near expiry and surfaces refresh notices', async () => {
  restoreDocument = installShellAuthDocument();
  const timeoutCallbacks: Array<{
    timeout: number | undefined;
    callback: () => void;
  }> = [];
  restoreWindow = installProviderAuthWindow({
    setTimeout(callback: TimerHandler, timeout?: number) {
      if (typeof callback !== 'function') {
        throw new Error('provider auth test expected timeout callback');
      }
      timeoutCallbacks.push({ timeout, callback: () => callback() });
      return timeoutCallbacks.length;
    },
    clearTimeout() {
      return;
    },
  });
  const firstExpiry = Date.now() + 60_000;
  const fetchMock = installFetchSequence(
    () =>
      jsonResponse({
        state: 'ready',
        ready: true,
        expiresAt: firstExpiry,
      }),
    () => jsonResponse({ state: 'missing', ready: false }),
    () =>
      jsonResponse({
        state: 'ready',
        ready: true,
        expiresAt: firstExpiry + 60_000,
      }),
    () => jsonResponse({ state: 'missing', ready: false }),
  );
  restoreFetch = fetchMock.restore;

  const hook = await renderHook(useProviderAuthState, undefined);
  await hook.flush();
  const observeTimer = timeoutCallbacks.find(
    (entry) => entry.timeout === PROVIDER_AUTH_READY_POLL_MS,
  );
  assert.ok(observeTimer);

  await hook.run(async () => {
    observeTimer.callback();
    await Promise.resolve();
    await Promise.resolve();
  });

  assert.equal(fetchMock.calls.length, 4);
  assert.equal(hook.result.current.providerAuthNotice, 'Codex auth refreshed.');
  assert.equal(
    hook.result.current.providerAuthStatus?.expiresAt,
    firstExpiry + 60_000,
  );
  hook.unmount();
});

interface ProviderAuthWindowStub {
  open(): Window | null;
  location: {
    assign(url: string): void;
  };
  setInterval(callback: TimerHandler, timeout?: number): unknown;
  clearInterval(handle?: unknown): void;
  setTimeout(callback: TimerHandler, timeout?: number): unknown;
  clearTimeout(handle?: unknown): void;
}

function installProviderAuthWindow(
  overrides: Partial<ProviderAuthWindowStub> = {},
) {
  const hadWindow = 'window' in globalThis;
  const originalWindow = globalThis.window;
  const windowStub: ProviderAuthWindowStub = {
    open() {
      return null;
    },
    location: {
      assign() {
        return;
      },
    },
    setInterval: globalThis.setInterval.bind(globalThis),
    clearInterval: globalThis.clearInterval.bind(globalThis),
    setTimeout: globalThis.setTimeout.bind(globalThis),
    clearTimeout: globalThis.clearTimeout.bind(globalThis),
    ...overrides,
  };

  Object.defineProperty(globalThis, 'window', {
    value: windowStub,
    configurable: true,
    writable: true,
  });

  return () => {
    if (hadWindow) {
      Object.defineProperty(globalThis, 'window', {
        value: originalWindow,
        configurable: true,
        writable: true,
      });
      return;
    }
    Reflect.deleteProperty(globalThis, 'window');
  };
}
