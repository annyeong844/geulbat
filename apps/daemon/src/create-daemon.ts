import express from 'express';

import { createLogger } from '@geulbat/structured-logger/logger';

import { getErrorMessage } from './daemon/utils/error.js';
import type { RequestHandler } from 'express';
import { requireAuth } from './adapter/web/auth/require-auth.js';
import { createShellAssetRoutes } from './adapter/web/shell-assets.js';
import { createHealthRoutes } from './adapter/web/routes/health.js';
import { createArtifactRuntimeHostRoutes } from './adapter/web/routes/artifact-runtime-host.js';
import { createPublicWebFixtureRoutes } from './adapter/web/routes/public-web-fixtures.js';
import { createProviderAuthRoutes } from './adapter/web/routes/provider-auth.js';
import { createPtcCallbackTransportRoutes } from './adapter/web/routes/ptc-callback-transport.js';
import { createPtcCallbackTransportSettingsPort } from './daemon/ptc-callback-transport-settings.js';
import { createPtcArtifactExportRoutes } from './adapter/web/routes/ptc-artifact-export.js';
import { createPtcArtifactExportService } from './daemon/ptc-artifact-export-service.js';
import { createQwenTokenPlanRoutes } from './adapter/web/routes/qwen-token-plan.js';
import {
  createPublicReactBundleInlineGeneratedAssetRoutes,
  createReactBundleInlineCompileRoutes,
} from './adapter/web/routes/react-bundle-inline-compile.js';
import { createFilesRoutes } from './adapter/web/routes/files.js';
import { createArtifactRuntimePersistenceRoutes } from './adapter/web/routes/artifact-runtime-persistence.js';
import { createRunInputRoutes } from './adapter/web/routes/run-inputs.js';
import { createThreadsRoutes } from './adapter/web/routes/threads.js';
import { threadProjectionPinDeletionPort } from './daemon/tools/tool-library-projection-store.js';
import { createMcpRoutes } from './adapter/web/routes/mcp.js';
import { createProviderUsageRoutes } from './adapter/web/routes/provider-usage.js';
import { createDirectoryPreferencesRoutes } from './adapter/web/routes/directory-preferences.js';
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
  readRequestSelfOrigin,
} from './adapter/web/origin-policy.js';
import { createDaemonContext, type DaemonContext } from './daemon/context.js';
import { loadCurrentProviderCredential } from './daemon/auth/status.js';
import { prepareProviderTransitionCompaction } from './daemon/agent/memory/provider-transition-compaction.js';
import { createThreadArchiveTransferService } from './daemon/sessions/thread-portable-transfer.js';
import {
  deleteQwenTokenPlanCredential,
  getQwenTokenPlanConnectionStatus,
  writeQwenTokenPlanCredential,
} from './daemon/llm/provider/qwen/index.js';

interface DaemonOptions {
  daemonContext?: DaemonContext;
  enablePublicWebConformanceFixtures?: boolean;
  /**
   * 빌드된 web-shell 산출물의 루트. 주어지면 데몬이 같은 origin에서 shell을
   * 서빙한다. 없으면 API만 서빙한다 — 화면 없이 데몬만 필요한 호출자(테스트
   * 하네스, 진단 도구)가 있고, 산출물 위치를 찾는 것은 제품 진입점의 일이다.
   */
  shellAssetRoot?: string;
}

const JSON_BODY_LIMIT = '256kb';

const logger = createLogger('create-daemon');

/**
 * supporting 확장 표면의 초기화 실패를 부팅에서 가둔다. 실패는 삼키지 않고
 * 진단으로 남기며, 그 표면은 초기화되지 않은 상태로 남아 자기 라우트에서
 * 계속 실패를 보고한다.
 */
async function initializeExtensionSurface(
  surface: string,
  initialize: () => Promise<void>,
): Promise<void> {
  try {
    await initialize();
  } catch (error: unknown) {
    logger.error('extension surface failed to initialize:', {
      surface,
      message: getErrorMessage(error),
    });
  }
}

export async function createDaemon(options: DaemonOptions = {}) {
  const daemonContext = options.daemonContext ?? createDaemonContext();
  const homeStateRoot = daemonContext.homeStateRoot;
  const ptcRestartCleanup =
    await daemonContext.ptc.executeCode.reapRestartResidue?.({
      stateRoot: homeStateRoot,
    });
  if (ptcRestartCleanup !== undefined && !ptcRestartCleanup.ok) {
    // 실패 이유를 버리면 부팅이 막힌 사용자가 손쓸 곳을 알 수 없다 — reasonCode와
    // diagnostics를 메시지에 실어 보낸다.
    throw new Error(
      `PTC restart residue cleanup failed during daemon startup: ${
        ptcRestartCleanup.reasonCode
      } ${ptcRestartCleanup.message ?? ''} ${JSON.stringify(
        ptcRestartCleanup.diagnostics ?? {},
      )}`.trim(),
    );
  }
  // 플러그인·MCP·마켓플레이스는 README가 분류한 supporting capability다. 이들의
  // 영속 파일이 손상되면 그 내용을 조용히 받아들이지 않는 것(fail-closed)은
  // 옳지만, 그 거부를 부팅 실패로 승격시키면 core 워크플로(파일·런·승인·도구)
  // 전체가 서지 못한다. 재시작해도 같은 파일을 다시 읽으므로 감시자와 함께
  // 재시작 루프가 되고, 사용자는 설정 파일 하나 때문에 앱을 열 수 없다.
  //
  // 그래서 실패를 여기서 가둔다. 조용한 폴백이 아니다: 이유를 진단으로 남기고,
  // 해당 확장 표면은 초기화되지 않은 상태로 남아 그 라우트가 계속 실패를
  // 보고한다. 같은 상황을 provider auth는 이미 이렇게 다룬다 —
  // `initProviderAuth`가 로드 실패를 상태로 캐시하고 부팅은 계속된다.
  //
  // 위의 PTC 잔여 정리와 대비된다: 그쪽은 남은 런타임이 새 데몬을 잘못된 상태로
  // 돌게 하므로 부팅을 막는 것이 맞다.
  await initializeExtensionSurface('plugins', () =>
    daemonContext.plugins.initialize(),
  );
  await initializeExtensionSurface('pluginMarketplaces', () =>
    daemonContext.pluginMarketplaces.initialize(),
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
  if (options.enablePublicWebConformanceFixtures === true) {
    app.use(createPublicWebFixtureRoutes());
  }
  app.use(createPublicReactBundleInlineGeneratedAssetRoutes());

  // Health check — before auth guard, for diagnostics
  app.use(createHealthRoutes());

  // provider auth 콜백은 공개다. 프로바이더는 우리 dev 토큰을 갖고 있지 않으므로
  // 인증 밖에 있어야 하고, 보호가 필요한 provider-auth 엔드포인트는 내부에서
  // requireAuth를 다시 적용한다.
  //
  // 콜백 수신 지점이 둘인 이유: 기본 흐름은 별도 loopback 리스너가 받는다
  // (Codex `PROVIDER_AUTH_REDIRECT_*` 기본 1455, Grok `GROK_OAUTH_REDIRECT_*`
  // 기본 56121). 이 라우트는 그 리다이렉트를 데몬 본체로 향하게 한 구성의
  // 수신 지점이다 — `PROVIDER_AUTH_REDIRECT_HOST/PORT/PATH`는 `.env.example`과
  // provider-auth 설정 계약 스펙에 있는 지원 형태이므로, 1455를 쓸 수 없는
  // 환경에서 리다이렉트를 이 서버로 돌릴 수 있다.
  //
  // 두 경로는 같은 `state` 검증과 소비 마킹을 지난다(`callback.ts`). 즉 공개인
  // 것은 입구뿐이고 경계는 동일하다.
  const providerAuthRoutesContext = {
    provider: daemonContext.provider,
  } satisfies ProviderAuthRoutesContext;
  app.use(createProviderAuthRoutes({ context: providerAuthRoutesContext }));

  // Auth guard on all /api/* (except health above)
  app.use('/api', requireAuth);

  // Mount route groups
  app.use(
    createQwenTokenPlanRoutes({
      getStatus: getQwenTokenPlanConnectionStatus,
      writeCredential: (credential) =>
        writeQwenTokenPlanCredential(credential, {
          hardenPermissions:
            daemonContext.provider.credentialFilePermissionHardener,
        }),
      deleteCredential: deleteQwenTokenPlanCredential,
    }),
  );
  // PTC transition spec v7 §3 (2026-07-27) — 콜백 전송 한도는 운영자가 확정한다.
  // 환경이 관리 중이면 여기서 바꾸거나 지울 수 없고, 상태가 그 사실을 알려 준다.
  app.use(
    createPtcCallbackTransportRoutes({
      ...createPtcCallbackTransportSettingsPort({ homeStateRoot }),
    }),
  );
  app.use(
    createPtcArtifactExportRoutes({
      service: createPtcArtifactExportService({ homeStateRoot }),
    }),
  );
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
    createDirectoryPreferencesRoutes({
      homeStateRoot,
      // 기본 경로는 선택기가 이미 자기 항목으로 보여준다 — 최근 목록에서 뺀다.
      listDefaultPaths: () => {
        const scope = daemonContext.computerFileScope;
        if (scope === undefined) {
          return [];
        }
        return [
          scope.browseStartPath ?? '',
          ...scope.browseShortcuts.map((shortcut) => shortcut.path),
        ].filter((path) => path !== '');
      },
    }),
  );
  app.use(
    createProviderUsageRoutes({
      async loadCredential(providerId) {
        const credential = await loadCurrentProviderCredential({
          runtimeStore: daemonContext.provider.authRuntime,
          providerId,
        });
        return credential === null
          ? null
          : {
              accessToken: credential.accessToken,
              accountId: credential.accountId,
            };
      },
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
    threadArchiveTransfer: createThreadArchiveTransferService({
      stateRoot: homeStateRoot,
      projectionTransfer: daemonContext.toolLibraryProjectionTransfer,
      async readProjectionIdentity(threadId) {
        const checkpoint =
          await daemonContext.runCheckpoints.readThread(threadId);
        return checkpoint?.request.toolLibraryProjectionIdentity ?? null;
      },
    }),
    threadProjectionPins: threadProjectionPinDeletionPort,
    providerTransitionCompaction: {
      async prepare(args) {
        return await prepareProviderTransitionCompaction({
          ...args,
          providerAuthRuntime: daemonContext.provider.authRuntime,
          providerWebSocketSessions: daemonContext.provider.webSocketSessions,
          providerRequestOptions: daemonContext.provider.requestOptions,
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

  // shell 정적 서빙은 모든 `/api` 라우트 뒤에 온다. 앞에 두면 SPA fallback이
  // 인증 실패와 없는 API 라우트를 문서 200으로 덮는다.
  if (options.shellAssetRoot !== undefined) {
    app.use(createShellAssetRoutes({ shellAssetRoot: options.shellAssetRoot }));
  }

  return { app, daemonContext };
}

const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self' data:",
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
      readRequestSelfOrigin(req.headers.host),
    );
    const isApiRequest = req.path.startsWith('/api/');

    if (origin && !originAllowed && isApiRequest) {
      sendApiError(res, 'access_denied', 'origin not allowed');
      return;
    }

    if (origin && originAllowed && isApiRequest) {
      // CORS 허용은 `/api`에만 준다. 정적 자산과 진입 문서는 shell이 same-origin
      // 으로 읽으므로 필요하지 않고, 진입 문서는 접속 토큰을 싣기 때문에 다른
      // origin이 읽을 수 있게 되면 그 토큰이 새어 나간다.
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
