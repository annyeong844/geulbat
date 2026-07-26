import { fileURLToPath } from 'node:url';

import { createLogger } from '@geulbat/structured-logger/logger';
import { launchDaemonHost } from '@geulbat/daemon/host';

import { createProductXHarnessAdmission } from './product-xharness-admission.js';
import {
  createDaemonSupervisor,
  GEULBAT_DAEMON_CHILD_ARGUMENT,
  notifyDaemonSupervisorReady,
  type DaemonShutdownSignal,
} from './daemon-supervisor.js';

const logger = createLogger('geulbat');
const bundledCreatorPluginRoot = fileURLToPath(
  new URL('../../daemon/creator-plugin', import.meta.url),
);

async function runProduct(): Promise<void> {
  if (process.argv.includes(GEULBAT_DAEMON_CHILD_ARGUMENT)) {
    if (process.send === undefined) {
      throw new Error(
        'daemon child requires the product supervisor IPC channel',
      );
    }
    await launchDaemonHost({
      agentLoopImplementationAdmission: createProductXHarnessAdmission(),
      bundledCreatorPluginRoot,
    });
    await notifyDaemonSupervisorReady();
    return;
  }

  const supervisor = createDaemonSupervisor({
    entrypoint: fileURLToPath(new URL('./index.js', import.meta.url)),
    onUnexpectedExit: ({ code, signal }) => {
      logger.warn('daemon exited unexpectedly; restarting', { code, signal });
    },
  });
  const forwardSignal = (signal: DaemonShutdownSignal): void => {
    supervisor.shutdown(signal);
  };
  const onSigint = (): void => forwardSignal('SIGINT');
  const onSigterm = (): void => forwardSignal('SIGTERM');
  process.once('SIGINT', onSigint);
  process.once('SIGTERM', onSigterm);
  try {
    await supervisor.run();
  } finally {
    process.off('SIGINT', onSigint);
    process.off('SIGTERM', onSigterm);
  }
}

runProduct().catch((error: unknown) => {
  logger.error('startup failed:', {
    message: error instanceof Error ? error.message : 'unknown startup failure',
  });
  process.exit(1);
});
