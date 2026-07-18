import express from 'express';
import type { RequestHandler } from 'express';
import { requireAuth } from './adapter/web/auth/require-auth.js';
import { createHealthRoutes } from './adapter/web/routes/health.js';
import { createArtifactRuntimeHostRoutes } from './adapter/web/routes/artifact-runtime-host.js';
import { createPublicWebFixtureRoutes } from './adapter/web/routes/public-web-fixtures.js';
import { createProviderAuthRoutes } from './adapter/web/routes/provider-auth.js';
import {
  createPublicReactBundleInlineGeneratedAssetRoutes,
  createReactBundleInlineCompileRoutes,
} from './adapter/web/routes/react-bundle-inline-compile.js';
import { createFilesRoutes } from './adapter/web/routes/files.js';
import { createArtifactRuntimePersistenceRoutes } from './adapter/web/routes/artifact-runtime-persistence.js';
import { createRunInputRoutes } from './adapter/web/routes/run-inputs.js';
import { createThreadsRoutes } from './adapter/web/routes/threads.js';
import { createMcpRoutes } from './adapter/web/routes/mcp.js';
import { createPluginRoutes } from './adapter/web/routes/plugins.js';
import { createInputRefRoutes } from './adapter/web/routes/input-refs.js';
import type {
  ProviderAuthRoutesContext,
  ThreadsRoutesContext,
} from './adapter/web/routes/routes-context.js';
import { SHELL_AUTH_ALLOWED_HEADERS } from './adapter/web/auth/shell-auth.js';
import {
  createUnexpectedApiErrorMiddleware,
  sendApiError,
} from './adapter/web/response/send-api-error.js';
import {
  isAllowedBrowserOrigin,
  readConfiguredAllowedOrigins,
} from './adapter/web/origin-policy.js';
import { createDaemonContext, type DaemonContext } from './daemon/context.js';
import { prepareProviderTransitionCompaction } from './daemon/agent/memory/compaction-loop.js';

interface DaemonOptions {
  daemonContext?: DaemonContext;
}

const JSON_BODY_LIMIT = '256kb';

export async function createDaemon(options: DaemonOptions = {}) {
  const daemonContext = options.daemonContext ?? createDaemonContext();
  const homeStateRoot = daemonContext.homeStateRoot;
  const ptcRestartCleanup =
    await daemonContext.ptcExecuteCode.reapRestartResidue?.({
      stateRoot: homeStateRoot,
    });
  if (ptcRestartCleanup !== undefined && !ptcRestartCleanup.ok) {
    throw new Error('PTC restart residue cleanup failed during daemon startup');
  }
  await daemonContext.plugins.initialize();
  await daemonContext.pluginMarketplaces.initialize();
  const app = express();
  const configuredAllowedOrigins = readConfiguredAllowedOrigins();

  app.use(createSecurityHeadersMiddleware(configuredAllowedOrigins));
  app.use(express.json({ limit: JSON_BODY_LIMIT }));

  // Artifact runtime host is public and embeds inside the web-shell iframe.
  app.use(
    createArtifactRuntimeHostRoutes({
      configuredAllowedOrigins,
    }),
  );
  app.use(createPublicWebFixtureRoutes());
  app.use(createPublicReactBundleInlineGeneratedAssetRoutes());

  // Health check — before auth guard, for diagnostics
  app.use(createHealthRoutes());

  // Provider auth callback is public; protected provider-auth endpoints re-apply requireAuth internally.
  const providerAuthRoutesContext = {
    providerAuthBootstrap: daemonContext.providerAuthBootstrap,
    providerAuthCallbackServer: daemonContext.providerAuthCallbackServer,
    providerAuthRuntime: daemonContext.providerAuthRuntime,
  } satisfies ProviderAuthRoutesContext;
  app.use(createProviderAuthRoutes({ context: providerAuthRoutesContext }));

  // Auth guard on all /api/* (except health above)
  app.use('/api', requireAuth);

  // Mount route groups
  app.use(
    createReactBundleInlineCompileRoutes({
      homeStateRoot,
    }),
  );
  app.use(
    createFilesRoutes({
      computerDirectoryPicker: daemonContext.computerDirectoryPicker,
      ...(daemonContext.computerFileScope === undefined
        ? {}
        : { computerFileScope: daemonContext.computerFileScope }),
    }),
  );
  app.use(
    createArtifactRuntimePersistenceRoutes({
      homeStateRoot,
    }),
  );
  app.use(
    createRunInputRoutes({
      homeStateRoot,
    }),
  );
  app.use(
    createInputRefRoutes({
      homeStateRoot,
      ...(daemonContext.computerFileScope === undefined
        ? {}
        : { computerFileScope: daemonContext.computerFileScope }),
    }),
  );
  const threadsRoutesContext = {
    homeStateRoot,
    activeRuns: daemonContext.activeRuns,
    backgroundNotifications: daemonContext.backgroundNotifications,
    providerTransitionCompaction: {
      async prepare(args) {
        return await prepareProviderTransitionCompaction({
          ...args,
          providerAuthRuntime: daemonContext.providerAuthRuntime,
          providerWebSocketSessions: daemonContext.providerWebSocketSessions,
          providerRequestOptions: daemonContext.providerRequestOptions,
        });
      },
    },
  } satisfies ThreadsRoutesContext;
  app.use(createThreadsRoutes({ context: threadsRoutesContext }));
  app.use(createMcpRoutes({ globalMcp: daemonContext.globalMcp }));
  app.use(
    createPluginRoutes({
      plugins: daemonContext.plugins,
      pluginSkills: daemonContext.pluginSkills,
      marketplaces: daemonContext.pluginMarketplaces,
      ...(daemonContext.computerFileScope === undefined
        ? {}
        : { computerFileScope: daemonContext.computerFileScope }),
    }),
  );
  app.use(createUnexpectedApiErrorMiddleware());

  return { app, daemonContext };
}

const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "base-uri 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
].join('; ');

function createSecurityHeadersMiddleware(
  configuredAllowedOrigins: ReadonlySet<string>,
): RequestHandler {
  return (req, res, next) => {
    res.setHeader('Content-Security-Policy', CONTENT_SECURITY_POLICY);
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');

    const origin =
      typeof req.headers.origin === 'string' ? req.headers.origin : undefined;
    const originAllowed = isAllowedBrowserOrigin(
      origin,
      configuredAllowedOrigins,
    );
    const isApiRequest = req.path.startsWith('/api/');

    if (origin && !originAllowed && isApiRequest) {
      sendApiError(res, 'access_denied', 'origin not allowed');
      return;
    }

    if (origin && originAllowed) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Headers', SHELL_AUTH_ALLOWED_HEADERS);
      res.setHeader('Access-Control-Allow-Credentials', 'true');
      res.setHeader(
        'Access-Control-Allow-Methods',
        'GET,POST,PATCH,DELETE,OPTIONS',
      );
    }

    if (req.method === 'OPTIONS') {
      if (!origin || !originAllowed) {
        sendApiError(res, 'access_denied', 'origin not allowed');
        return;
      }
      res.status(204).end();
      return;
    }

    next();
  };
}
