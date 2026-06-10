import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { runPtcSessionDockerCommand } from './session-docker-command.js';

void test('session-docker command owner does not own lifecycle, policy, or output redaction', async () => {
  const source = await readFile(
    new URL(
      '../../../src/daemon/ptc/session-docker-command.ts',
      import.meta.url,
    ),
    'utf8',
  );

  assert.doesNotMatch(source, /normalizePtcSessionDockerReuseKey/u);
  assert.doesNotMatch(source, /buildPtcSessionDockerCreateArgs/u);
  assert.doesNotMatch(source, /createPtcSessionDockerManager/u);
  assert.doesNotMatch(source, /PtcSessionDockerPolicy/u);
  assert.doesNotMatch(source, /sanitizePtcPrivateMarkers|sanitizePtcOutput/u);
  assert.doesNotMatch(source, /session-docker-host-roots/u);
  assert.doesNotMatch(source, /node:child_process/u);
  assert.match(source, /@geulbat\/shared-utils\/process-command/u);
});

void test('runPtcSessionDockerCommand executes argv without shell interpolation', async () => {
  const result = await runPtcSessionDockerCommand({
    executable: process.execPath,
    args: [
      '-e',
      'console.log(process.argv.slice(1).join("|"))',
      'a b',
      'semi;colon',
    ],
    timeoutMs: 1000,
  });

  assert.equal(result.kind, 'exit');
  assert.equal(result.kind === 'exit' ? result.exitCode : -1, 0);
  assert.match(result.stdout, /a b\|semi;colon/u);
});

void test('runPtcSessionDockerCommand caps stdout and stderr capture', async () => {
  const result = await runPtcSessionDockerCommand({
    executable: process.execPath,
    args: [
      '-e',
      'process.stdout.write("o".repeat(80 * 1024)); process.stderr.write("e".repeat(80 * 1024));',
    ],
    timeoutMs: 1000,
  });

  assert.equal(result.kind, 'exit');
  assert.equal(Buffer.byteLength(result.stdout, 'utf8') <= 66 * 1024, true);
  assert.equal(Buffer.byteLength(result.stderr, 'utf8') <= 66 * 1024, true);
  assert.match(result.stdout, /\[truncated\]/u);
  assert.match(result.stderr, /\[truncated\]/u);
});

void test('runPtcSessionDockerCommand passes only Docker client environment keys', async () => {
  const previous = {
    DOCKER_HOST: process.env.DOCKER_HOST,
    NPM_TOKEN: process.env.NPM_TOKEN,
    PROVIDER_SECRET: process.env.PROVIDER_SECRET,
    SSH_AUTH_SOCK: process.env.SSH_AUTH_SOCK,
  };
  process.env.DOCKER_HOST = 'unix:///tmp/geulbat-test-docker.sock';
  process.env.NPM_TOKEN = 'secret-npm-token';
  process.env.PROVIDER_SECRET = 'secret-provider-token';
  process.env.SSH_AUTH_SOCK = '/tmp/geulbat-test-ssh-agent.sock';
  try {
    const result = await runPtcSessionDockerCommand({
      executable: process.execPath,
      args: [
        '-e',
        [
          'const keys = ["DOCKER_HOST", "NPM_TOKEN", "PROVIDER_SECRET", "SSH_AUTH_SOCK", "PATH"];',
          'const values = Object.fromEntries(keys.map((key) => [key, process.env[key] ?? null]));',
          'process.stdout.write(JSON.stringify(values));',
        ].join(''),
      ],
      timeoutMs: 1000,
    });

    assert.equal(result.kind, 'exit');
    assert.equal(result.kind === 'exit' ? result.exitCode : -1, 0);
    const childEnv = JSON.parse(result.stdout) as Record<string, unknown>;
    assert.equal(childEnv.DOCKER_HOST, 'unix:///tmp/geulbat-test-docker.sock');
    assert.equal(childEnv.NPM_TOKEN, null);
    assert.equal(childEnv.PROVIDER_SECRET, null);
    assert.equal(childEnv.SSH_AUTH_SOCK, null);
    assert.equal(typeof childEnv.PATH, 'string');
  } finally {
    restoreEnv('DOCKER_HOST', previous.DOCKER_HOST);
    restoreEnv('NPM_TOKEN', previous.NPM_TOKEN);
    restoreEnv('PROVIDER_SECRET', previous.PROVIDER_SECRET);
    restoreEnv('SSH_AUTH_SOCK', previous.SSH_AUTH_SOCK);
  }
});

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
    return;
  }
  process.env[key] = value;
}
