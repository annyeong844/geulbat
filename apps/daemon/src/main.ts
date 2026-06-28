import http from 'node:http';
import type { WebSocketServer } from 'ws';
import { createDaemon } from './create-daemon.js';
import {
  closeDaemonRuntimeSessions,
  closeDaemonServers,
  listenDaemonHttpServer,
} from './daemon-server-lifecycle.js';
import { initProviderAuth } from './daemon/auth/init.js';
import { attachPublicWebFixtureWebSocketServer } from './adapter/web/ws/public-web-fixtures.js';
import { attachRunChannelServer } from './adapter/web/ws/run-channel.js';
import type { RunChannelRuntimeContext } from './adapter/web/ws/run-channel-runtime-context.js';
import { getConfiguredDevToken } from './adapter/web/auth/token.js';
import { createDaemonContext } from './daemon/context.js';
import { readDaemonPort } from './daemon/port.js';
import { readDefaultRepoRoot } from './repo-root.js';
import { getErrorMessage } from './daemon/utils/error.js';
import { createLogger } from '@geulbat/shared-utils/logger';
import {
  acquireWorkspaceAdmissionLock,
  type WorkspaceAdmissionLock,
} from './daemon/workspace-admission-lock.js';

const PORT = readDaemonPort(process.env['PORT']);
const HOST = process.env['HOST'] ?? '127.0.0.1';
const REPO_ROOT = readDefaultRepoRoot();
const logger = createLogger('daemon');

async function main() {
  getConfiguredDevToken();
  const admissionLock = await acquireWorkspaceAdmissionLock({
    workspaceRoot: REPO_ROOT,
  });
  const daemonContext = createDaemonContext();
  try {
    await initProviderAuth({
      runtimeStore: daemonContext.providerAuthRuntime,
    });
    const { app } = await createDaemon({
      repoRoot: REPO_ROOT,
      daemonContext,
    });
    const server = http.createServer(app);
    const runChannelRuntimeContext = {
      activeRuns: daemonContext.activeRuns,
      approvalGrants: daemonContext.approvalGrants,
      approvalGate: daemonContext.approvalGate,
      backgroundNotifications: daemonContext.backgroundNotifications,
      childRuns: daemonContext.childRuns,
      fileStateCache: daemonContext.fileStateCache,
      agentWorkflowRunner: daemonContext.agentWorkflowRunner,
      agentWavePlanner: daemonContext.agentWavePlanner,
      memoryIndex: daemonContext.memoryIndex,
      providerAuthRuntime: daemonContext.providerAuthRuntime,
      providerRequestOptions: daemonContext.providerRequestOptions,
      providerWebSocketSessions: daemonContext.providerWebSocketSessions,
      reactBundleStructuredOutputIngressPolicy:
        daemonContext.reactBundleStructuredOutputIngressPolicy,
      resourceBudgetProvider: daemonContext.resourceBudgetProvider,
      projectRegistry: daemonContext.projectRegistry,
      ptcBrowserPageLoadEvidence: daemonContext.ptcBrowserPageLoadEvidence,
      ptcBrowserTextEvidence: daemonContext.ptcBrowserTextEvidence,
      ptcBrowserNavigate: daemonContext.ptcBrowserNavigate,
      ptcExecuteCode: daemonContext.ptcExecuteCode,
      ptcFixedProbe: daemonContext.ptcFixedProbe,
      sandboxAttempts: daemonContext.sandboxAttempts,
      subagentAdmission: daemonContext.subagentAdmission,
      subagentRuns: daemonContext.subagentRuns,
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
    logger.info(`http://${HOST}:${PORT}`);
  } catch (error: unknown) {
    await admissionLock.release();
    throw error;
  }
}

function registerProcessShutdown(args: {
  admissionLock: WorkspaceAdmissionLock;
  runtimeSessions: Parameters<
    typeof closeDaemonRuntimeSessions
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
        await closeDaemonServers({
          server: args.server,
          webSocketServers: args.webSocketServers,
        });
        await closeDaemonRuntimeSessions({
          runtimeSessions: args.runtimeSessions,
        });
        await args.admissionLock.release();
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
