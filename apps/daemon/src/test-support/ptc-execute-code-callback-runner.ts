import assert from 'node:assert/strict';

import { PTC_SESSION_DOCKER_SDK_CONTAINER_ROOT } from '../daemon/ptc/lab/session/session-docker-contract.js';

export function remapEncodedExecuteCodeCallbackRoot(
  command: string,
  callbackHostRoot: string,
  sdkHostRoot?: string,
): string {
  const encodedRunnerMatch = /GEULBAT_PTC_RUNNER_B64='([A-Za-z0-9+/=]+)'/u.exec(
    command,
  );
  assert.ok(encodedRunnerMatch);
  const encodedRunner = encodedRunnerMatch[1];
  assert.ok(encodedRunner);
  const runnerSource = Buffer.from(encodedRunner, 'base64').toString('utf8');
  let remappedRunnerSource = runnerSource.replaceAll(
    '/geulbat/callbacks',
    callbackHostRoot,
  );
  if (sdkHostRoot !== undefined) {
    remappedRunnerSource = remappedRunnerSource.replaceAll(
      PTC_SESSION_DOCKER_SDK_CONTAINER_ROOT,
      sdkHostRoot,
    );
  }
  assert.notEqual(remappedRunnerSource, runnerSource);
  const remappedRunner = Buffer.from(remappedRunnerSource, 'utf8').toString(
    'base64',
  );
  return command.replace(
    encodedRunnerMatch[0],
    `GEULBAT_PTC_RUNNER_B64='${remappedRunner}'`,
  );
}
