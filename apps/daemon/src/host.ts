import http from 'node:http';

import { createLogger } from '@geulbat/structured-logger/logger';

import { getConfiguredDevToken } from './adapter/web/auth/token.js';
import { readPublicWebConformanceFixturesEnabled } from './adapter/web/public-web-conformance.js';
import { attachPublicWebFixtureWebSocketServer } from './adapter/web/ws/public-web-fixtures.js';
import { attachRunChannelServer } from './adapter/web/ws/run-channel.js';
import { recoverDurableRunsAtDaemonStartup } from './adapter/web/ws/run-channel-start.js';
import { createDaemon } from './create-daemon.js';
import { createDaemonRuntimeOwner } from './daemon-runtime-owner.js';
import {
  closeDaemonForShutdown,
  listenDaemonHttpServer,
} from './daemon-server-lifecycle.js';
import { initProviderAuth } from './daemon/auth/init.js';
import { createDaemonContext } from './daemon/context.js';
import { acquireDaemonInstanceAdmissionLock } from './daemon/daemon-instance-admission-lock.js';
import type { AgentLoopImplementationAdmission } from './daemon/agent/loop-implementation-admission.js';
import { createDaemonRuntimeStateStore } from './daemon/runtime-state-store.js';
import { readDaemonPort } from './daemon/port.js';
import { getErrorMessage } from './daemon/utils/error.js';
import { runDetached } from './daemon/utils/run-detached.js';

const logger = createLogger('daemon');

export interface LaunchDaemonHostOptions {
  readonly agentLoopImplementationAdmission?: AgentLoopImplementationAdmission;
  readonly bundledCreatorPluginRoot?: string;
}

export async function launchDaemonHost(
  options: LaunchDaemonHostOptions = {},
): Promise<void> {
  const port = readDaemonPort(process.env['PORT']);
  const host = process.env['HOST'] ?? '127.0.0.1';
  const bootStartedAt = performance.now();
  const logBootPhase = (phase: string): void => {
    logger.info(
      `boot ${phase} +${Math.round(performance.now() - bootStartedAt)}ms`,
    );
  };

  logBootPhase('start');
  getConfiguredDevToken();
  logBootPhase('auth-token');
  const enablePublicWebConformanceFixtures =
    readPublicWebConformanceFixturesEnabled(process.env);
  if (enablePublicWebConformanceFixtures) {
    logger.info('public web conformance fixtures enabled');
  }
  const daemonContext = createDaemonContext({
    ...(options.agentLoopImplementationAdmission === undefined
      ? {}
      : {
          agentLoopImplementationAdmission:
            options.agentLoopImplementationAdmission,
        }),
    ...(options.bundledCreatorPluginRoot === undefined
      ? {}
      : { bundledCreatorPluginRoot: options.bundledCreatorPluginRoot }),
  });
  logBootPhase('context');
  const daemonRuntime = createDaemonRuntimeOwner({
    daemonContext,
    policies: {
      acquireAdmissionLock: (lockArgs) =>
        acquireDaemonInstanceAdmissionLock(lockArgs),
      openRuntimeStateStore: ({ homeStateRoot }) =>
        createDaemonRuntimeStateStore({ homeStateRoot }),
      initProviderAuth: () =>
        initProviderAuth({ runtimeStore: daemonContext.provider.authRuntime }),
      recoverDurableRunsAtStartup: async (runtimeContext) => {
        const recoveredRunCount =
          await recoverDurableRunsAtDaemonStartup(runtimeContext);
        if (recoveredRunCount > 0) {
          logger.info('daemon startup durable run recovery scheduled', {
            recoveredRunCount,
          });
        }
      },
      createApp: async () =>
        (
          await createDaemon({
            daemonContext,
            enablePublicWebConformanceFixtures,
          })
        ).app,
      createHttpServer: (app) => http.createServer(app),
      attachWebSockets: ({ server, runtimeContext }) => [
        ...(enablePublicWebConformanceFixtures
          ? [attachPublicWebFixtureWebSocketServer(server)]
          : []),
        attachRunChannelServer(server, { runtimeContext }),
      ],
      bindProviderAuthCallback: (server) => {
        daemonContext.provider.authCallbackServer.bindLifecycle(server);
      },
      listen: (listenArgs) => listenDaemonHttpServer(listenArgs),
      closeForShutdown: (closeArgs) => closeDaemonForShutdown(closeArgs),
      onBootPhase: logBootPhase,
    },
  });
  await daemonRuntime.start({
    port,
    host,
    beforeListen: () => {
      registerProcessShutdown({ shutdown: () => daemonRuntime.shutdown() });
    },
  });
  logger.info(`http://${host}:${port}`);
}

function registerProcessShutdown(args: {
  shutdown: () => Promise<void>;
}): void {
  let shuttingDown = false;

  const shutdown = (signal: NodeJS.Signals) => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    logger.info(`received ${signal}, shutting down`);

    runDetached('daemon/shutdown', async () => {
      try {
        await args.shutdown();
        process.exit(0);
      } catch (error: unknown) {
        logger.error('shutdown failed:', getErrorMessage(error));
        process.exit(1);
      }
    });
  };

  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));
}
