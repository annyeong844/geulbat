import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
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

void test('runDockerClientCommand fails closed instead of starting an unrouted process', async () => {
  const result = await runDockerClientCommand({
    executable: process.execPath,
    args: ['-e', 'process.exit(0)'],
  });

  assert.deepEqual(result, {
    kind: 'crash',
    stdout: '',
    stderr: 'docker command requires the daemon host command runtime',
  });
});

void test('daemon production sources contain no direct child-process owner', async () => {
  const packageRoot = resolve(
    dirname(fileURLToPath(import.meta.url)),
    '..',
    '..',
  );
  const daemonSourceRoot = resolve(packageRoot, 'src', 'daemon');
  const entries = await readdir(daemonSourceRoot, {
    recursive: true,
    withFileTypes: true,
  });

  for (const entry of entries) {
    if (
      !entry.isFile() ||
      !entry.name.endsWith('.ts') ||
      entry.name.endsWith('.test.ts')
    ) {
      continue;
    }
    const filePath = resolve(entry.parentPath, entry.name);
    const source = await readFile(filePath, 'utf8');
    assert.doesNotMatch(
      source,
      /(?:\bfrom\s+|\bimport\s*(?:\(\s*)?)['"](?:node:)?child_process['"]/u,
      filePath,
    );
  }
});
