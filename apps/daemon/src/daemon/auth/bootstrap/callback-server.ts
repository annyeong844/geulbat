import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';

import {
  PROVIDER_AUTH_CALLBACK_LISTENER,
  type ProviderAuthCallbackListenerConfig,
} from './config.js';
import {
  completeProviderAuthCallback,
  normalizeProviderAuthCallbackQueryParam,
  type ProviderAuthCallbackQuery,
  type ProviderAuthCallbackResult,
} from './callback.js';
import type { ProviderAuthBootstrapStore } from './session-store.js';
import type { ProviderAuthRuntimeStore } from '../runtime-state.js';
import { createLogger } from '@geulbat/structured-logger/logger';

const logger = createLogger('provider-auth');

type ProviderAuthCallbackCompleter = (
  query: ProviderAuthCallbackQuery,
  options: {
    bootstrapStore: ProviderAuthBootstrapStore;
    runtimeStore: ProviderAuthRuntimeStore;
  },
) => Promise<ProviderAuthCallbackResult>;

export interface ProviderAuthCallbackServerController {
  ensureListening(
    callbackListener?: ProviderAuthCallbackListenerConfig,
  ): Promise<void>;
  close(): Promise<void>;
  bindLifecycle(server: Pick<Server, 'once'>): void;
}

interface ProviderAuthCallbackServerState {
  callbackPaths: Set<string>;
  listener: Pick<
    ProviderAuthCallbackListenerConfig,
    'bindHost' | 'redirectHost' | 'port'
  >;
  server: Server | null;
  listenPromise: Promise<void> | null;
}

export function createProviderAuthCallbackServerController(options: {
  bootstrapStore: ProviderAuthBootstrapStore;
  runtimeStore: ProviderAuthRuntimeStore;
  completeCallback?: ProviderAuthCallbackCompleter;
  createHttpServer?: typeof createServer;
}): ProviderAuthCallbackServerController {
  const createHttpServer = options.createHttpServer ?? createServer;
  const serverStates = new Map<string, ProviderAuthCallbackServerState>();

  return {
    async ensureListening(callbackListener = PROVIDER_AUTH_CALLBACK_LISTENER) {
      const state = getOrCreateCallbackServerState({
        callbackListener,
        createHttpServer,
        options,
        serverStates,
      });
      state.callbackPaths.add(callbackListener.path);

      if (state.server?.listening) {
        return;
      }

      if (state.listenPromise) {
        await state.listenPromise;
        return;
      }

      state.listenPromise = new Promise<void>((resolve, reject) => {
        const requestHandler = stateRequestHandler(state, options);
        const server = createHttpServer((req, res) => {
          void requestHandler(req, res);
        });

        const onError = (err: Error & { code?: string }) => {
          server.removeListener('listening', onListening);
          state.server = null;
          reject(
            new Error(
              `Failed to bind provider auth callback listener on ` +
                `http://${state.listener.bindHost}:${state.listener.port}` +
                (err.code ? ` (${err.code})` : ''),
            ),
          );
        };

        const onListening = () => {
          server.removeListener('error', onError);
          state.server = server;
          resolve();
        };

        server.once('error', onError);
        server.once('listening', onListening);
        server.listen(state.listener.port, state.listener.bindHost);
      });

      try {
        await state.listenPromise;
      } finally {
        state.listenPromise = null;
      }
    },

    async close() {
      const states = [...serverStates.values()];
      serverStates.clear();

      for (const state of states) {
        if (!state.server) {
          continue;
        }

        const server = state.server;
        state.server = null;

        await new Promise<void>((resolve, reject) => {
          server.close((err) => {
            if (err) {
              reject(err);
              return;
            }
            resolve();
          });
        });
      }
    },

    bindLifecycle(server) {
      server.once('close', () => {
        void this.close().catch((error: unknown) => {
          logger.warn('callback server cleanup failed:', error);
        });
      });
    },
  };
}

function getOrCreateCallbackServerState(args: {
  callbackListener: ProviderAuthCallbackListenerConfig;
  createHttpServer: typeof createServer;
  options: Parameters<typeof createProviderAuthCallbackServerController>[0];
  serverStates: Map<string, ProviderAuthCallbackServerState>;
}): ProviderAuthCallbackServerState {
  const { callbackListener, serverStates } = args;
  const key = `${callbackListener.bindHost}:${callbackListener.port}`;
  const existing = serverStates.get(key);
  if (existing) {
    return existing;
  }

  const state: ProviderAuthCallbackServerState = {
    callbackPaths: new Set(),
    listener: {
      bindHost: callbackListener.bindHost,
      redirectHost: callbackListener.redirectHost,
      port: callbackListener.port,
    },
    server: null,
    listenPromise: null,
  };
  serverStates.set(key, state);
  return state;
}

function stateRequestHandler(
  state: ProviderAuthCallbackServerState,
  options: Parameters<typeof createProviderAuthCallbackServerController>[0],
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  return createProviderAuthCallbackRequestHandler({
    ...options,
    callbackPaths: state.callbackPaths,
    redirectHost: state.listener.redirectHost,
    port: state.listener.port,
  });
}

export function createProviderAuthCallbackRequestHandler(options: {
  bootstrapStore: ProviderAuthBootstrapStore;
  runtimeStore: ProviderAuthRuntimeStore;
  completeCallback?: ProviderAuthCallbackCompleter;
  callbackPaths?: ReadonlySet<string>;
  redirectHost?: string;
  port?: number;
}): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  const { bootstrapStore, runtimeStore } = options;
  const completeCallback =
    options.completeCallback ?? completeProviderAuthCallback;
  const callbackPaths =
    options.callbackPaths ?? new Set([PROVIDER_AUTH_CALLBACK_LISTENER.path]);
  const redirectHost =
    options.redirectHost ?? PROVIDER_AUTH_CALLBACK_LISTENER.redirectHost;
  const port = options.port ?? PROVIDER_AUTH_CALLBACK_LISTENER.port;

  return async (req, res) =>
    handleProviderAuthCallbackRequest(req, res, {
      bootstrapStore,
      runtimeStore,
      completeCallback,
      callbackPaths,
      redirectHost,
      port,
    });
}

async function handleProviderAuthCallbackRequest(
  req: IncomingMessage,
  res: ServerResponse,
  options: {
    bootstrapStore: ProviderAuthBootstrapStore;
    runtimeStore: ProviderAuthRuntimeStore;
    completeCallback: ProviderAuthCallbackCompleter;
    callbackPaths: ReadonlySet<string>;
    redirectHost: string;
    port: number;
  },
): Promise<void> {
  if (req.method !== 'GET') {
    res.statusCode = 405;
    res.setHeader('Allow', 'GET');
    res.end('Method Not Allowed');
    return;
  }

  try {
    const url = new URL(
      req.url ?? '/',
      `http://${options.redirectHost}:${options.port}`,
    );

    if (!options.callbackPaths.has(url.pathname)) {
      res.statusCode = 404;
      res.end('Not Found');
      return;
    }

    const code = normalizeProviderAuthCallbackQueryParam(
      url.searchParams.get('code'),
    );
    const state = normalizeProviderAuthCallbackQueryParam(
      url.searchParams.get('state'),
    );
    const error = normalizeProviderAuthCallbackQueryParam(
      url.searchParams.get('error'),
    );
    const errorDescription = normalizeProviderAuthCallbackQueryParam(
      url.searchParams.get('error_description'),
    );
    const result = await options.completeCallback(
      {
        ...(code !== undefined ? { code } : {}),
        ...(state !== undefined ? { state } : {}),
        ...(error !== undefined ? { error } : {}),
        ...(errorDescription !== undefined ? { errorDescription } : {}),
      },
      {
        bootstrapStore: options.bootstrapStore,
        runtimeStore: options.runtimeStore,
      },
    );

    res.statusCode = result.statusCode;
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end(result.html);
  } catch (error: unknown) {
    logger.warn('callback request handling failed:', error);
    res.statusCode = 500;
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.end('Internal provider auth callback error');
  }
}
