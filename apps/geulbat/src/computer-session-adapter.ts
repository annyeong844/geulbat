import { randomUUID } from 'node:crypto';

import {
  createDaemonLifecycleClient,
  type DaemonLifecycleClient,
} from '@geulbat/daemon-lifecycle/client';
import type {
  DaemonLifecycleEvent,
  DaemonShutdownSignal,
} from '@geulbat/daemon-lifecycle/protocol';

const COMPUTER_SESSION_ID_ENV = 'GEULBAT_COMPUTER_SESSION_ID';

interface ProductComputerSessionAdapter extends DaemonLifecycleClient {
  readonly computerSessionId: string;
}

interface ProductComputerSessionAdapterOptions {
  readonly daemonChildArgument: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly createComputerSessionId?: () => string;
  readonly createLifecycleClient?: typeof createDaemonLifecycleClient;
  readonly onEvent?: (event: DaemonLifecycleEvent) => void;
}

export function createProductComputerSessionAdapter(
  options: ProductComputerSessionAdapterOptions,
): ProductComputerSessionAdapter {
  const computerSessionId = (
    options.createComputerSessionId ?? randomUUID
  )().trim();
  if (computerSessionId.length === 0) {
    throw new Error('computer session adapter issued a blank identity');
  }
  const createLifecycleClient =
    options.createLifecycleClient ?? createDaemonLifecycleClient;
  const lifecycle = createLifecycleClient({
    arguments: [options.daemonChildArgument],
    env: {
      ...(options.env ?? process.env),
      [COMPUTER_SESSION_ID_ENV]: computerSessionId,
    },
    ...(options.onEvent === undefined ? {} : { onEvent: options.onEvent }),
  });

  return {
    computerSessionId,
    run: () => lifecycle.run(),
    shutdown: (signal: DaemonShutdownSignal) => lifecycle.shutdown(signal),
  };
}

export function readProductComputerSessionId(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const computerSessionId = env[COMPUTER_SESSION_ID_ENV]?.trim();
  if (computerSessionId === undefined || computerSessionId.length === 0) {
    throw new Error(
      'daemon child requires a computer session issued by the product host',
    );
  }
  return computerSessionId;
}
