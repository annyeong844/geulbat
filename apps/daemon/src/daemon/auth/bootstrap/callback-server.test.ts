import test from 'node:test';
import assert from 'node:assert/strict';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { EventEmitter } from 'node:events';

import { completeProviderAuthCallback } from './callback.js';
import {
  createProviderAuthCallbackRequestHandler,
  createProviderAuthCallbackServerController,
} from './callback-server.js';
import { GROK_OAUTH_CALLBACK_LISTENER } from './config.js';
import { createProviderAuthRuntimeStore } from '../runtime-state.js';
import { createProviderAuthTestStores } from '../../../test-support/provider-auth.js';

interface ServerResponseProbe {
  readonly response: ServerResponse;
  readonly headers: Map<string, string>;
  readBody(): string;
}

function createServerResponseProbe(): ServerResponseProbe {
  const headers = new Map<string, string>();
  let body = '';
  const response = {
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

  return {
    response,
    headers,
    readBody() {
      return body;
    },
  };
}

void test('callback request handler resolves against injected bootstrap/runtime stores', async () => {
  const { bootstrapStore, runtimeStore } = createProviderAuthTestStores();
  const untouchedRuntimeStore = createProviderAuthRuntimeStore();
  bootstrapStore.setPendingProviderAuthSession({
    authSessionId: 'auth-local',
    providerId: 'openai_codex_direct',
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

  const res = createServerResponseProbe();

  await handler(req, res.response);

  assert.equal(res.response.statusCode, 200);
  assert.match(res.headers.get('content-type') ?? '', /text\/html/);
  assert.match(res.readBody(), /Provider connected/i);
  assert.equal(
    runtimeStore.getCachedProviderCredential()?.accessToken,
    'handler-local-access-token',
  );
  assert.equal(bootstrapStore.getProviderAuthSessionSnapshot(), null);
  assert.equal(untouchedRuntimeStore.getCachedProviderCredential(), null);
});

void test('callback request handler accepts the Grok OAuth loopback callback path', async () => {
  const { bootstrapStore, runtimeStore } = createProviderAuthTestStores();
  bootstrapStore.setPendingProviderAuthSession({
    authSessionId: 'auth-grok-local',
    providerId: 'grok_oauth',
    state: 'state-grok-local',
    codeVerifier: 'verifier-grok-local',
    redirectUri: GROK_OAUTH_CALLBACK_LISTENER.redirectUri,
    createdAt: Date.now(),
    expiresAt: Date.now() + 60_000,
    status: 'pending',
  });

  const handler = createProviderAuthCallbackRequestHandler({
    bootstrapStore,
    runtimeStore,
    callbackPaths: new Set([GROK_OAUTH_CALLBACK_LISTENER.path]),
    redirectHost: GROK_OAUTH_CALLBACK_LISTENER.redirectHost,
    port: GROK_OAUTH_CALLBACK_LISTENER.port,
    completeCallback: (query, options) =>
      completeProviderAuthCallback(query, {
        ...options,
        exchangeCode: async () => ({
          access_token: 'handler-grok-access-token',
          refresh_token: 'handler-grok-refresh-token',
          expires_in: 60,
          accountId: 'handler-grok-account-id',
        }),
      }),
  });

  const req = {
    method: 'GET',
    url: '/callback?code=code-grok-local&state=state-grok-local',
  } as IncomingMessage;

  const res = createServerResponseProbe();

  await handler(req, res.response);

  assert.equal(res.response.statusCode, 200);
  assert.match(res.readBody(), /Provider connected/i);
  assert.equal(
    runtimeStore.getCachedProviderCredential('grok_oauth')?.accessToken,
    'handler-grok-access-token',
  );
  assert.equal(bootstrapStore.getProviderAuthSessionSnapshot(), null);
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

  const res = createServerResponseProbe();

  await handler(req, res.response);

  assert.equal(res.response.statusCode, 500);
  assert.equal(res.headers.get('content-type'), 'text/plain; charset=utf-8');
  assert.equal(res.readBody(), 'Internal provider auth callback error');
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

  const res = createServerResponseProbe();

  await handler(req, res.response);

  assert.equal(res.response.statusCode, 405);
  assert.equal(res.headers.get('allow'), 'GET');
  assert.equal(res.readBody(), 'Method Not Allowed');
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

  const res = createServerResponseProbe();

  await handler(req, res.response);

  assert.equal(res.response.statusCode, 404);
  assert.equal(res.headers.size, 0);
  assert.equal(res.readBody(), 'Not Found');
  assert.equal(completeCalled, false);
});

void test('callback server controller surfaces bind failures with loopback listener context', async () => {
  const { bootstrapStore, runtimeStore } = createProviderAuthTestStores();
  let createServerCalls = 0;
  const fakeServers: FakeCallbackServer[] = [];
  const controller = createProviderAuthCallbackServerController({
    bootstrapStore,
    runtimeStore,
    createHttpServer: () => {
      createServerCalls += 1;
      const fakeServer = new FakeCallbackServer({
        listen() {
          queueMicrotask(() => {
            this.emitError(
              Object.assign(new Error('bind failed'), { code: 'EADDRINUSE' }),
            );
          });
        },
      });
      fakeServers.push(fakeServer);
      return fakeServer.asServer();
    },
  });

  await assert.rejects(
    () => controller.ensureListening(GROK_OAUTH_CALLBACK_LISTENER),
    /Failed to bind provider auth callback listener .*EADDRINUSE/,
  );
  assert.equal(createServerCalls, 1);
  assert.equal(fakeServers[0]?.listenPort, GROK_OAUTH_CALLBACK_LISTENER.port);
  assert.equal(
    fakeServers[0]?.listenHost,
    GROK_OAUTH_CALLBACK_LISTENER.bindHost,
  );
});

class FakeCallbackServer extends EventEmitter {
  listening = false;
  listenHost: string | undefined;
  listenPort: number | undefined;
  private readonly onListenImpl: () => void;

  constructor(options: { listen: (this: FakeCallbackServer) => void }) {
    super();
    this.onListenImpl = options.listen.bind(this);
  }

  listen(port?: number, host?: string): this {
    this.listenPort = port;
    this.listenHost = host;
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
