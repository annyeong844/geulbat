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
import { createProjectsRoutes } from './adapter/web/routes/projects.js';
import { createFilesRoutes } from './adapter/web/routes/files.js';
import { createArtifactRuntimePersistenceRoutes } from './adapter/web/routes/artifact-runtime-persistence.js';
import { createRunInputRoutes } from './adapter/web/routes/run-inputs.js';
import { createThreadsRoutes } from './adapter/web/routes/threads.js';
import { createInputRefRoutes } from './adapter/web/routes/input-refs.js';
import type {
  ProjectsRoutesContext,
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
import { bootstrapDaemonContext } from './bootstrap-daemon-context.js';

interface DaemonOptions {
  repoRoot?: string;
  daemonContext?: DaemonContext;
}

const JSON_BODY_LIMIT = '256kb';

export async function createDaemon(options: DaemonOptions = {}) {
  const daemonContext = options.daemonContext ?? createDaemonContext();
  await bootstrapDaemonContext(
    options.repoRoot
      ? {
          projectStore: daemonContext.projectStore,
          repoRoot: options.repoRoot,
        }
      : { projectStore: daemonContext.projectStore },
  );
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
      projectRegistry: daemonContext.projectRegistry,
    }),
  );
  const projectsRoutesContext = {
    activeRuns: daemonContext.activeRuns,
    projectStore: daemonContext.projectStore,
    projectRegistry: daemonContext.projectRegistry,
  } satisfies ProjectsRoutesContext;
  app.use(createProjectsRoutes({ context: projectsRoutesContext }));
  app.use(
    createFilesRoutes({
      projectRegistry: daemonContext.projectRegistry,
    }),
  );
  app.use(
    createArtifactRuntimePersistenceRoutes({
      projectRegistry: daemonContext.projectRegistry,
    }),
  );
  app.use(
    createRunInputRoutes({
      projectRegistry: daemonContext.projectRegistry,
    }),
  );
  app.use(
    createInputRefRoutes({
      projectRegistry: daemonContext.projectRegistry,
    }),
  );
  const threadsRoutesContext = {
    activeRuns: daemonContext.activeRuns,
    backgroundNotifications: daemonContext.backgroundNotifications,
    projectRegistry: daemonContext.projectRegistry,
  } satisfies ThreadsRoutesContext;
  app.use(createThreadsRoutes({ context: threadsRoutesContext }));
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
