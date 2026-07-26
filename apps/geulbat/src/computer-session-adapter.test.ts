import assert from 'node:assert/strict';
import test from 'node:test';

import type { DaemonLifecycleClient } from '@geulbat/daemon-lifecycle/client';
import type { DaemonShutdownSignal } from '@geulbat/daemon-lifecycle/protocol';

import {
  createProductComputerSessionAdapter,
  readProductComputerSessionId,
} from './computer-session-adapter.js';

void test('product computer session adapter issues one identity around the lifecycle client', async () => {
  let capturedArguments: readonly string[] = [];
  let capturedEnv: NodeJS.ProcessEnv | undefined;
  let runCount = 0;
  const shutdownSignals: DaemonShutdownSignal[] = [];
  const lifecycle: DaemonLifecycleClient = {
    async run() {
      runCount += 1;
    },
    shutdown(signal) {
      shutdownSignals.push(signal);
    },
  };
  const adapter = createProductComputerSessionAdapter({
    daemonChildArgument: '--daemon-child',
    env: { EXISTING_HOST_VALUE: 'preserved' },
    createComputerSessionId: () => ' computer-session-host-issued ',
    createLifecycleClient: (options) => {
      capturedArguments = options.arguments;
      capturedEnv = options.env;
      return lifecycle;
    },
  });

  assert.equal(adapter.computerSessionId, 'computer-session-host-issued');
  assert.deepEqual(capturedArguments, ['--daemon-child']);
  assert.equal(capturedEnv?.['EXISTING_HOST_VALUE'], 'preserved');
  assert.equal(
    capturedEnv?.['GEULBAT_COMPUTER_SESSION_ID'],
    'computer-session-host-issued',
  );
  assert.equal(
    readProductComputerSessionId(capturedEnv),
    'computer-session-host-issued',
  );

  await adapter.run();
  adapter.shutdown('SIGTERM');

  assert.equal(runCount, 1);
  assert.deepEqual(shutdownSignals, ['SIGTERM']);
});

void test('computer session adapter refuses missing or blank host identities', () => {
  assert.throws(
    () =>
      createProductComputerSessionAdapter({
        daemonChildArgument: '--daemon-child',
        createComputerSessionId: () => ' ',
      }),
    /blank identity/u,
  );
  assert.throws(
    () => readProductComputerSessionId({}),
    /requires a computer session issued by the product host/u,
  );
});
