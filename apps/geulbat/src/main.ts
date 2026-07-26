import { fileURLToPath } from 'node:url';

import { launchDaemonHost } from '@geulbat/daemon/host';
import { notifyDaemonLifecycleReady } from '@geulbat/daemon-lifecycle/daemon-child';
import type { DaemonShutdownSignal } from '@geulbat/daemon-lifecycle/protocol';
import { createLogger } from '@geulbat/structured-logger/logger';

import {
  createProductComputerSessionAdapter,
  readProductComputerSessionId,
} from './computer-session-adapter.js';
import { createProductXHarnessAdmission } from './product-xharness-admission.js';

const GEULBAT_DAEMON_CHILD_ARGUMENT = '--geulbat-daemon-child';
const logger = createLogger('geulbat');
const bundledCreatorPluginRoot = fileURLToPath(
  new URL('../../daemon/creator-plugin', import.meta.url),
);

async function runProduct(): Promise<void> {
  if (process.argv.includes(GEULBAT_DAEMON_CHILD_ARGUMENT)) {
    if (process.send === undefined) {
      throw new Error('daemon child requires the lifecycle worker IPC channel');
    }
    await launchDaemonHost({
      agentLoopImplementationAdmission: createProductXHarnessAdmission(),
      bundledCreatorPluginRoot,
      computerSessionId: readProductComputerSessionId(),
    });
    await notifyDaemonLifecycleReady();
    return;
  }

  const lifecycle = createProductComputerSessionAdapter({
    daemonChildArgument: GEULBAT_DAEMON_CHILD_ARGUMENT,
    onEvent: (event) => {
      if (event.state !== 'restarting') {
        return;
      }
      const { code, signal } = event;
      logger.warn('daemon exited unexpectedly; restarting', { code, signal });
    },
  });
  const forwardSignal = (signal: DaemonShutdownSignal): void => {
    lifecycle.shutdown(signal);
  };
  const onSigint = (): void => forwardSignal('SIGINT');
  const onSigterm = (): void => forwardSignal('SIGTERM');
  process.once('SIGINT', onSigint);
  process.once('SIGTERM', onSigterm);
  try {
    await lifecycle.run();
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
