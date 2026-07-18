import test from 'node:test';
import assert from 'node:assert/strict';
import { PTC_LAB_DOCKER_BRIDGE_OPEN_NETWORK_NAME } from '../network/lab-network-policy.js';
import type { PtcSessionDockerCommandResult } from './session-docker-contract.js';
import {
  ensurePtcOpenNetworkBridge,
  PTC_SESSION_DOCKER_OPEN_NETWORK_BRIDGE_MANAGED_LABEL,
} from './session-docker-open-network-bridge.js';

function exit(
  exitCode: number,
  stdout = '',
  stderr = '',
): PtcSessionDockerCommandResult {
  return { kind: 'exit', exitCode, stdout, stderr };
}

interface RecordedCall {
  args: string[];
}

function fakeRunDocker(
  handlers: Array<
    (call: RecordedCall) => PtcSessionDockerCommandResult | undefined
  >,
): {
  runDocker: (dockerArgs: string[]) => Promise<PtcSessionDockerCommandResult>;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  return {
    calls,
    async runDocker(dockerArgs: string[]) {
      const call = { args: dockerArgs };
      calls.push(call);
      for (const handler of handlers) {
        const result = handler(call);
        if (result !== undefined) {
          return result;
        }
      }
      throw new Error(`unexpected docker call: ${dockerArgs.join(' ')}`);
    },
  };
}

void test('ensure adopts an existing bridge without creating a new one', async () => {
  const { runDocker, calls } = fakeRunDocker([
    (call) =>
      call.args[1] === 'inspect'
        ? exit(0, '[{"Name":"geulbat-ptc-lab-open-v1"}]')
        : undefined,
  ]);

  const result = await ensurePtcOpenNetworkBridge({
    networkName: PTC_LAB_DOCKER_BRIDGE_OPEN_NETWORK_NAME,
    runDocker,
  });

  assert.deepEqual(result, { ok: true, outcome: 'adopted' });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0]?.args, [
    'network',
    'inspect',
    PTC_LAB_DOCKER_BRIDGE_OPEN_NETWORK_NAME,
  ]);
});

void test('ensure creates a labeled bridge when it is absent', async () => {
  const { runDocker, calls } = fakeRunDocker([
    (call) =>
      call.args[1] === 'inspect'
        ? exit(1, '', 'Error: No such network: geulbat-ptc-lab-open-v1')
        : undefined,
    (call) => (call.args[1] === 'create' ? exit(0, 'network-id\n') : undefined),
  ]);

  const result = await ensurePtcOpenNetworkBridge({
    networkName: PTC_LAB_DOCKER_BRIDGE_OPEN_NETWORK_NAME,
    runDocker,
  });

  assert.deepEqual(result, { ok: true, outcome: 'created' });
  const createCall = calls.find((call) => call.args[1] === 'create');
  assert.ok(createCall);
  assert.ok(
    createCall.args.includes(
      PTC_SESSION_DOCKER_OPEN_NETWORK_BRIDGE_MANAGED_LABEL,
    ),
  );
  assert.equal(createCall.args.at(-1), PTC_LAB_DOCKER_BRIDGE_OPEN_NETWORK_NAME);
});

void test('ensure adopts when a concurrent launch already created the bridge (race)', async () => {
  let inspectCalls = 0;
  const { runDocker } = fakeRunDocker([
    (call) => {
      if (call.args[1] !== 'inspect') {
        return undefined;
      }
      inspectCalls += 1;
      // First inspect: absent. Second inspect (after losing the create race):
      // present.
      return inspectCalls === 1
        ? exit(1, '', 'Error: No such network')
        : exit(0, '[{"Name":"geulbat-ptc-lab-open-v1"}]');
    },
    (call) =>
      call.args[1] === 'create'
        ? exit(
            1,
            '',
            'Error response from daemon: network with name geulbat-ptc-lab-open-v1 already exists',
          )
        : undefined,
  ]);

  const result = await ensurePtcOpenNetworkBridge({
    networkName: PTC_LAB_DOCKER_BRIDGE_OPEN_NETWORK_NAME,
    runDocker,
  });

  assert.deepEqual(result, { ok: true, outcome: 'adopted' });
  assert.equal(inspectCalls, 2);
});

void test('ensure fails closed as network_backend_unavailable on a real create failure', async () => {
  const { runDocker } = fakeRunDocker([
    (call) =>
      call.args[1] === 'inspect'
        ? exit(1, '', 'Error: No such network')
        : undefined,
    (call) =>
      call.args[1] === 'create'
        ? exit(1, '', 'Error response from daemon: permission denied')
        : undefined,
  ]);

  const result = await ensurePtcOpenNetworkBridge({
    networkName: PTC_LAB_DOCKER_BRIDGE_OPEN_NETWORK_NAME,
    runDocker,
  });

  assert.equal(result.ok, false);
  if (result.ok) {
    return;
  }
  assert.equal(result.reasonCode, 'network_backend_unavailable');
  assert.equal(
    result.diagnostics.networkName,
    PTC_LAB_DOCKER_BRIDGE_OPEN_NETWORK_NAME,
  );
});
