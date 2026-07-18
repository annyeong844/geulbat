import http from 'node:http';
import type { WebSocketServer } from 'ws';
import { createDaemon } from './create-daemon.js';
import {
  closeDaemonForShutdown,
  listenDaemonHttpServer,
} from './daemon-server-lifecycle.js';
import { initProviderAuth } from './daemon/auth/init.js';
import { attachPublicWebFixtureWebSocketServer } from './adapter/web/ws/public-web-fixtures.js';
import { attachRunChannelServer } from './adapter/web/ws/run-channel.js';
import type { RunChannelRuntimeContext } from './adapter/web/ws/run-channel-runtime-context.js';
import { getConfiguredDevToken } from './adapter/web/auth/token.js';
import { createDaemonContext } from './daemon/context.js';
import { readDaemonPort } from './daemon/port.js';
import { getErrorMessage } from './daemon/utils/error.js';
import { createLogger } from '@geulbat/shared-utils/logger';
import {
  acquireDaemonInstanceAdmissionLock,
  type DaemonInstanceAdmissionLock,
} from './daemon/daemon-instance-admission-lock.js';

const PORT = readDaemonPort(process.env['PORT']);
const HOST = process.env['HOST'] ?? '127.0.0.1';
const logger = createLogger('daemon');
const bootStartedAt = performance.now();

function logBootPhase(phase: string): void {
  logger.info(
    `boot ${phase} +${Math.round(performance.now() - bootStartedAt)}ms`,
  );
}

async function main() {
  logBootPhase('start');
  getConfiguredDevToken();
  logBootPhase('auth-token');
  const daemonContext = createDaemonContext();
  logBootPhase('context');
  const admissionLock = await acquireDaemonInstanceAdmissionLock({
    stateRoot: daemonContext.homeStateRoot,
  });
  logBootPhase('admission-lock');
  try {
    await initProviderAuth({
      runtimeStore: daemonContext.providerAuthRuntime,
    });
    logBootPhase('provider-auth');
    const { app } = await createDaemon({ daemonContext });
    logBootPhase('create-daemon');
    const server = http.createServer(app);
    const runChannelRuntimeContext = {
      activeRuns: daemonContext.activeRuns,
      approvalGrants: daemonContext.approvalGrants,
      approvalGate: daemonContext.approvalGate,
      artifactFrameToolDispatch: daemonContext.artifactFrameToolDispatch,
      backgroundNotifications: daemonContext.backgroundNotifications,
      ...(daemonContext.computerFileScope !== undefined
        ? { computerFileScope: daemonContext.computerFileScope }
        : {}),
      ...(daemonContext.computerFileRoot !== undefined
        ? { computerFileRoot: daemonContext.computerFileRoot }
        : {}),
      homeStateRoot: daemonContext.homeStateRoot,
      childRuns: daemonContext.childRuns,
      fileStateCache: daemonContext.fileStateCache,
      agentWorkflowRunner: daemonContext.agentWorkflowRunner,
      agentWavePlanner: daemonContext.agentWavePlanner,
      imageGeneration: daemonContext.imageGeneration,
      videoGeneration: daemonContext.videoGeneration,
      memoryIndex: daemonContext.memoryIndex,
      providerAuthRuntime: daemonContext.providerAuthRuntime,
      providerRequestOptions: daemonContext.providerRequestOptions,
      providerWebSocketSessions: daemonContext.providerWebSocketSessions,
      reactBundleStructuredOutputIngressPolicy:
        daemonContext.reactBundleStructuredOutputIngressPolicy,
      resourceBudgetProvider: daemonContext.resourceBudgetProvider,
      ptcBrowserPageLoadEvidence: daemonContext.ptcBrowserPageLoadEvidence,
      ptcBrowserTextEvidence: daemonContext.ptcBrowserTextEvidence,
      ptcBrowserNavigate: daemonContext.ptcBrowserNavigate,
      ptcExecuteCode: daemonContext.ptcExecuteCode,
      ptcPackageInstall: daemonContext.ptcPackageInstall,
      ptcFixedProbe: daemonContext.ptcFixedProbe,
      pluginSkills: daemonContext.pluginSkills,
      sandboxAttempts: daemonContext.sandboxAttempts,
      subagentAdmission: daemonContext.subagentAdmission,
      subagentRuns: daemonContext.subagentRuns,
      toolLibraryProjection: daemonContext.toolLibraryProjection,
      toolRegistry: daemonContext.toolRegistry,
    } satisfies RunChannelRuntimeContext;
    const publicWebSockets = attachPublicWebFixtureWebSocketServer(server);
    const runChannelSockets = attachRunChannelServer(server, {
      runtimeContext: runChannelRuntimeContext,
    });
    daemonContext.providerAuthCallbackServer.bindLifecycle(server);
    registerProcessShutdown({
      admissionLock,
      runtimeSessions: {
        globalMcp: daemonContext.globalMcp,
        ptcBrowserPageLoadEvidence: daemonContext.ptcBrowserPageLoadEvidence,
        ptcBrowserTextEvidence: daemonContext.ptcBrowserTextEvidence,
        ptcBrowserNavigate: daemonContext.ptcBrowserNavigate,
        ptcExecuteCode: daemonContext.ptcExecuteCode,
      },
      server,
      webSocketServers: [publicWebSockets, runChannelSockets],
    });

    await listenDaemonHttpServer({
      server,
      port: PORT,
      host: HOST,
    });
    logBootPhase('listen');
    logger.info(`http://${HOST}:${PORT}`);
  } catch (error: unknown) {
    await admissionLock.release();
    throw error;
  }
}

function registerProcessShutdown(args: {
  admissionLock: DaemonInstanceAdmissionLock;
  runtimeSessions: Parameters<
    typeof closeDaemonForShutdown
  >[0]['runtimeSessions'];
  server: http.Server;
  webSocketServers: readonly WebSocketServer[];
}): void {
  let shuttingDown = false;

  const shutdown = (signal: NodeJS.Signals) => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    logger.info(`received ${signal}, shutting down`);

    void (async () => {
      try {
        await closeDaemonForShutdown({
          admissionLock: args.admissionLock,
          runtimeSessions: args.runtimeSessions,
          server: args.server,
          webSocketServers: args.webSocketServers,
        });
        process.exit(0);
      } catch (error: unknown) {
        logger.error('shutdown failed:', getErrorMessage(error));
        process.exit(1);
      }
    })();
  };

  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err: unknown) => {
  logger.error('startup failed:', getErrorMessage(err));
  process.exit(1);
});
