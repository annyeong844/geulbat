import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildDockerClientProcessEnv,
  runDockerClientCommand,
} from './docker-client-command.js';

void test('buildDockerClientProcessEnv keeps only Docker client env keys', () => {
  assert.deepEqual(
    buildDockerClientProcessEnv({
      PATH: '/bin',
      DOCKER_API_VERSION: '1.45',
      DOCKER_HOST: 'unix:///tmp/docker.sock',
      DOCKER_CONTEXT: 'remote-context',
      DOCKER_BUILDKIT: '1',
      NPM_TOKEN: 'do-not-copy',
      SSH_AUTH_SOCK: '/tmp/ssh.sock',
    }),
    {
      PATH: '/bin',
      DOCKER_API_VERSION: '1.45',
      DOCKER_HOST: 'unix:///tmp/docker.sock',
      DOCKER_CONTEXT: 'remote-context',
      DOCKER_BUILDKIT: '1',
    },
  );
});

void test('runDockerClientCommand uses Docker cancellation stderr for pre-aborted signals', async () => {
  const controller = new AbortController();
  controller.abort();

  const result = await runDockerClientCommand({
    executable: process.execPath,
    args: ['-e', 'process.exit(0)'],
    timeoutMs: 50,
    signal: controller.signal,
  });

  assert.equal(result.kind, 'cancelled');
  assert.equal(result.stderr, 'docker command cancelled');
});
