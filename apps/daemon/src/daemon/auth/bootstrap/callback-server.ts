import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';

import {
  PROVIDER_AUTH_LOOPBACK_BIND_HOST,
  PROVIDER_AUTH_REDIRECT_HOST,
  PROVIDER_AUTH_REDIRECT_PATH,
  PROVIDER_AUTH_REDIRECT_PORT,
} from './config.js';
import {
  completeProviderAuthCallback,
  normalizeProviderAuthCallbackQueryParam,
  type ProviderAuthCallbackQuery,
  type ProviderAuthCallbackResult,
} from './callback.js';
import { type ProviderAuthBootstrapStore } from './session-store.js';
import { type ProviderAuthRuntimeStore } from '../runtime-state.js';
import { createLogger } from '@geulbat/shared-utils/logger';

const logger = createLogger('provider-auth');

type ProviderAuthCallbackCompleter = (
  query: ProviderAuthCallbackQuery,
  options: {
    bootstrapStore: ProviderAuthBootstrapStore;
    runtimeStore: ProviderAuthRuntimeStore;
  },
) => Promise<ProviderAuthCallbackResult>;

export interface ProviderAuthCallbackServerController {
  ensureListening(): Promise<void>;
  close(): Promise<void>;
  bindLifecycle(server: Pick<Server, 'once'>): void;
}

export function createProviderAuthCallbackServerController(options: {
  bootstrapStore: ProviderAuthBootstrapStore;
  runtimeStore: ProviderAuthRuntimeStore;
  completeCallback?: ProviderAuthCallbackCompleter;
  createHttpServer?: typeof createServer;
}): ProviderAuthCallbackServerController {
  const requestHandler = createProviderAuthCallbackRequestHandler(options);
  const createHttpServer = options.createHttpServer ?? createServer;
  let callbackServer: Server | null = null;
  let listenPromise: Promise<void> | null = null;

  return {
    async ensureListening() {
      if (callbackServer?.listening) {
        return;
      }

      if (listenPromise) {
        await listenPromise;
        return;
      }

      listenPromise = new Promise<void>((resolve, reject) => {
        const server = createHttpServer((req, res) => {
          void requestHandler(req, res);
        });

        const onError = (err: Error & { code?: string }) => {
          server.removeListener('listening', onListening);
          callbackServer = null;
          reject(
            new Error(
              `Failed to bind provider auth callback listener on ` +
                `http://${PROVIDER_AUTH_LOOPBACK_BIND_HOST}:${PROVIDER_AUTH_REDIRECT_PORT}${PROVIDER_AUTH_REDIRECT_PATH}` +
                (err.code ? ` (${err.code})` : ''),
            ),
          );
        };

        const onListening = () => {
          server.removeListener('error', onError);
          callbackServer = server;
          resolve();
        };

        server.once('error', onError);
        server.once('listening', onListening);
        server.listen(
          PROVIDER_AUTH_REDIRECT_PORT,
          PROVIDER_AUTH_LOOPBACK_BIND_HOST,
        );
      });

      try {
        await listenPromise;
      } finally {
        listenPromise = null;
      }
    },

    async close() {
      if (!callbackServer) {
        return;
      }

      const server = callbackServer;
      callbackServer = null;

      await new Promise<void>((resolve, reject) => {
        server.close((err) => {
          if (err) {
            reject(err);
            return;
          }
          resolve();
        });
      });
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

export function createProviderAuthCallbackRequestHandler(options: {
  bootstrapStore: ProviderAuthBootstrapStore;
  runtimeStore: ProviderAuthRuntimeStore;
  completeCallback?: ProviderAuthCallbackCompleter;
}): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  const { bootstrapStore, runtimeStore } = options;
  const completeCallback =
    options.completeCallback ?? completeProviderAuthCallback;

  return async (req, res) =>
    handleProviderAuthCallbackRequest(req, res, {
      bootstrapStore,
      runtimeStore,
      completeCallback,
    });
}

async function handleProviderAuthCallbackRequest(
  req: IncomingMessage,
  res: ServerResponse,
  options: {
    bootstrapStore: ProviderAuthBootstrapStore;
    runtimeStore: ProviderAuthRuntimeStore;
    completeCallback: ProviderAuthCallbackCompleter;
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
      `http://${PROVIDER_AUTH_REDIRECT_HOST}:${PROVIDER_AUTH_REDIRECT_PORT}`,
    );

    if (url.pathname !== PROVIDER_AUTH_REDIRECT_PATH) {
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
