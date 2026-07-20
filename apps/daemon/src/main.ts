import http from 'node:http';
import { createDaemon } from './create-daemon.js';
import { createDaemonRuntimeOwner } from './daemon-runtime-owner.js';
import {
  closeDaemonForShutdown,
  listenDaemonHttpServer,
} from './daemon-server-lifecycle.js';
import { initProviderAuth } from './daemon/auth/init.js';
import { attachPublicWebFixtureWebSocketServer } from './adapter/web/ws/public-web-fixtures.js';
import { readPublicWebConformanceFixturesEnabled } from './adapter/web/public-web-conformance.js';
import { attachRunChannelServer } from './adapter/web/ws/run-channel.js';
import { getConfiguredDevToken } from './adapter/web/auth/token.js';
import { createDaemonContext } from './daemon/context.js';
import { readDaemonPort } from './daemon/port.js';
import { getErrorMessage } from './daemon/utils/error.js';
import { createLogger } from '@geulbat/structured-logger/logger';
import { acquireDaemonInstanceAdmissionLock } from './daemon/daemon-instance-admission-lock.js';

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
  const enablePublicWebConformanceFixtures =
    readPublicWebConformanceFixturesEnabled(process.env);
  if (enablePublicWebConformanceFixtures) {
    logger.info('public web conformance fixtures enabled');
  }
  const daemonContext = createDaemonContext();
  logBootPhase('context');
  const daemonRuntime = createDaemonRuntimeOwner({
    daemonContext,
    policies: {
      acquireAdmissionLock: (lockArgs) =>
        acquireDaemonInstanceAdmissionLock(lockArgs),
      initProviderAuth: () =>
        initProviderAuth({ runtimeStore: daemonContext.providerAuthRuntime }),
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
        daemonContext.providerAuthCallbackServer.bindLifecycle(server);
      },
      listen: (listenArgs) => listenDaemonHttpServer(listenArgs),
      closeForShutdown: (closeArgs) => closeDaemonForShutdown(closeArgs),
      onBootPhase: logBootPhase,
    },
  });
  await daemonRuntime.start({
    port: PORT,
    host: HOST,
    beforeListen: () => {
      registerProcessShutdown({ shutdown: () => daemonRuntime.shutdown() });
    },
  });
  logger.info(`http://${HOST}:${PORT}`);
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

    void (async () => {
      try {
        await args.shutdown();
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
