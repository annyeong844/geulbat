import test from 'node:test';
import assert from 'node:assert/strict';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { EventEmitter } from 'node:events';

import { completeProviderAuthCallback } from './callback.js';
import {
  createProviderAuthCallbackRequestHandler,
  createProviderAuthCallbackServerController,
} from './callback-server.js';
import { createProviderAuthRuntimeStore } from '../runtime-state.js';
import { createProviderAuthTestStores } from '../../../test-support/provider-auth.js';

void test('callback request handler resolves against injected bootstrap/runtime stores', async () => {
  const { bootstrapStore, runtimeStore } = createProviderAuthTestStores();
  const untouchedRuntimeStore = createProviderAuthRuntimeStore();
  bootstrapStore.setPendingProviderAuthSession({
    authSessionId: 'auth-local',
    state: 'state-local',
    codeVerifier: 'verifier-local',
    redirectUri: 'http://localhost:1455/auth/callback',
    createdAt: Date.now(),
    expiresAt: Date.now() + 60_000,
    status: 'pending',
  });

  const handler = createProviderAuthCallbackRequestHandler({
    bootstrapStore,
    runtimeStore,
    completeCallback: (query, options) =>
      completeProviderAuthCallback(query, {
        ...options,
        exchangeCode: async () => ({
          access_token: 'handler-local-access-token',
          refresh_token: 'handler-local-refresh-token',
          expires_in: 60,
          accountId: 'handler-local-account-id',
        }),
      }),
  });

  const req = {
    method: 'GET',
    url: '/auth/callback?code=code-local&state=state-local',
  } as IncomingMessage;

  const headers = new Map<string, string>();
  let body = '';
  const res = {
    statusCode: 200,
    setHeader(name: string, value: string) {
      headers.set(name.toLowerCase(), value);
      return this;
    },
    end(chunk?: string) {
      body = chunk ?? '';
      return this;
    },
  } as unknown as ServerResponse;

  await handler(req, res);

  assert.equal(res.statusCode, 200);
  assert.match(headers.get('content-type') ?? '', /text\/html/);
  assert.match(body, /Provider connected/i);
  assert.equal(
    runtimeStore.getCachedProviderCredential()?.accessToken,
    'handler-local-access-token',
  );
  assert.equal(bootstrapStore.getProviderAuthSessionSnapshot(), null);
  assert.equal(untouchedRuntimeStore.getCachedProviderCredential(), null);
});

void test('callback request handler returns generic 500 on unexpected callback failure', async () => {
  const { bootstrapStore, runtimeStore } = createProviderAuthTestStores();
  const handler = createProviderAuthCallbackRequestHandler({
    bootstrapStore,
    runtimeStore,
    completeCallback: async () => {
      throw new Error('boom');
    },
  });

  const req = {
    method: 'GET',
    url: '/auth/callback?code=code-local&state=state-local',
  } as IncomingMessage;

  const headers = new Map<string, string>();
  let body = '';
  const res = {
    statusCode: 200,
    setHeader(name: string, value: string) {
      headers.set(name.toLowerCase(), value);
      return this;
    },
    end(chunk?: string) {
      body = chunk ?? '';
      return this;
    },
  } as unknown as ServerResponse;

  await handler(req, res);

  assert.equal(res.statusCode, 500);
  assert.equal(headers.get('content-type'), 'text/plain; charset=utf-8');
  assert.equal(body, 'Internal provider auth callback error');
});

void test('callback request handler rejects non-GET methods without invoking callback completion', async () => {
  const { bootstrapStore, runtimeStore } = createProviderAuthTestStores();
  let completeCalled = false;
  const handler = createProviderAuthCallbackRequestHandler({
    bootstrapStore,
    runtimeStore,
    completeCallback: async () => {
      completeCalled = true;
      throw new Error('should not be called');
    },
  });

  const req = {
    method: 'POST',
    url: '/auth/callback?code=code-local&state=state-local',
  } as IncomingMessage;

  const headers = new Map<string, string>();
  let body = '';
  const res = {
    statusCode: 200,
    setHeader(name: string, value: string) {
      headers.set(name.toLowerCase(), value);
      return this;
    },
    end(chunk?: string) {
      body = chunk ?? '';
      return this;
    },
  } as unknown as ServerResponse;

  await handler(req, res);

  assert.equal(res.statusCode, 405);
  assert.equal(headers.get('allow'), 'GET');
  assert.equal(body, 'Method Not Allowed');
  assert.equal(completeCalled, false);
});

void test('callback request handler rejects requests for non-callback paths without invoking callback completion', async () => {
  const { bootstrapStore, runtimeStore } = createProviderAuthTestStores();
  let completeCalled = false;
  const handler = createProviderAuthCallbackRequestHandler({
    bootstrapStore,
    runtimeStore,
    completeCallback: async () => {
      completeCalled = true;
      throw new Error('should not be called');
    },
  });

  const req = {
    method: 'GET',
    url: '/auth/not-the-callback?code=code-local&state=state-local',
  } as IncomingMessage;

  const headers = new Map<string, string>();
  let body = '';
  const res = {
    statusCode: 200,
    setHeader(name: string, value: string) {
      headers.set(name.toLowerCase(), value);
      return this;
    },
    end(chunk?: string) {
      body = chunk ?? '';
      return this;
    },
  } as unknown as ServerResponse;

  await handler(req, res);

  assert.equal(res.statusCode, 404);
  assert.equal(headers.size, 0);
  assert.equal(body, 'Not Found');
  assert.equal(completeCalled, false);
});

void test('callback server controller surfaces bind failures with loopback listener context', async () => {
  const { bootstrapStore, runtimeStore } = createProviderAuthTestStores();
  let createServerCalls = 0;
  const controller = createProviderAuthCallbackServerController({
    bootstrapStore,
    runtimeStore,
    createHttpServer: () => {
      createServerCalls += 1;
      return new FakeCallbackServer({
        listen() {
          queueMicrotask(() => {
            this.emitError(
              Object.assign(new Error('bind failed'), { code: 'EADDRINUSE' }),
            );
          });
        },
      }).asServer();
    },
  });

  await assert.rejects(
    () => controller.ensureListening(),
    /Failed to bind provider auth callback listener .*EADDRINUSE/,
  );
  assert.equal(createServerCalls, 1);
});

class FakeCallbackServer extends EventEmitter {
  listening = false;
  private readonly onListenImpl: () => void;

  constructor(options: { listen: (this: FakeCallbackServer) => void }) {
    super();
    this.onListenImpl = options.listen.bind(this);
  }

  listen(): this {
    this.onListenImpl();
    return this;
  }

  close(callback?: (error?: Error | null) => void): this {
    this.listening = false;
    callback?.(null);
    return this;
  }

  emitError(error: Error & { code?: string }): void {
    this.emit('error', error);
  }

  asServer(): Server {
    return this as unknown as Server;
  }
}
