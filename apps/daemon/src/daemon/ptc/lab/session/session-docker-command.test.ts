import assert from 'node:assert/strict';
import test from 'node:test';
import {
  collectPtcStaticImportGraph,
  ptcSourceUrl,
  ptcStaticImportGraphIncludesSource,
  readPtcStaticImportSpecifiers,
} from '../../../../test-support/ptc-static-import-graph.js';
import {
  mapPtcSessionDockerNonExitCommandResult,
  runPtcSessionDockerCommand,
} from './session-docker-command.js';

void test('session-docker command owner does not own lifecycle, policy, or output redaction', async () => {
  const sourceUrl = ptcSourceUrl('lab/session/session-docker-command.ts');
  const graph = await collectPtcStaticImportGraph(sourceUrl);

  assert.deepEqual(readPtcStaticImportSpecifiers(graph, sourceUrl), [
    '../../shared/process-command.js',
    './session-docker-contract.js',
  ]);
  for (const forbiddenSource of [
    '/lab/session/session-docker.ts',
    '/lab/session/session-docker-create-args.ts',
    '/lab/session/session-docker-host-roots.ts',
    '/shared/output-redaction.ts',
  ]) {
    assert.equal(
      ptcStaticImportGraphIncludesSource(graph, forbiddenSource),
      false,
      forbiddenSource,
    );
  }
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

void test('runPtcSessionDockerCommand preserves large stdout and stderr', async () => {
  const result = await runPtcSessionDockerCommand({
    executable: process.execPath,
    args: [
      '-e',
      'process.stdout.write("o".repeat(80 * 1024)); process.stderr.write("e".repeat(80 * 1024));',
    ],
    timeoutMs: 1000,
  });

  assert.equal(result.kind, 'exit');
  assert.equal(Buffer.byteLength(result.stdout, 'utf8'), 80 * 1024);
  assert.equal(Buffer.byteLength(result.stderr, 'utf8'), 80 * 1024);
  assert.doesNotMatch(result.stdout, /\[truncated\]/u);
  assert.doesNotMatch(result.stderr, /\[truncated\]/u);
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

void test('mapPtcSessionDockerNonExitCommandResult preserves taint-needed command edges', () => {
  assert.deepEqual(
    mapPtcSessionDockerNonExitCommandResult(
      { kind: 'timeout', stdout: 'out', stderr: 'err' },
      'failed',
    ),
    {
      kind: 'timeout',
      stdout: 'out',
      stderr: 'err',
      processTerminated: false,
    },
  );
  assert.deepEqual(
    mapPtcSessionDockerNonExitCommandResult(
      { kind: 'cancelled', stdout: 'out', stderr: 'err' },
      'failed',
    ),
    {
      kind: 'cancelled',
      stdout: 'out',
      stderr: 'err',
      processTerminated: false,
    },
  );
  assert.deepEqual(
    mapPtcSessionDockerNonExitCommandResult(
      {
        kind: 'timeout',
        stdout: 'out',
        stderr: 'err',
        processTerminated: true,
      },
      'failed',
    ),
    {
      kind: 'timeout',
      stdout: 'out',
      stderr: 'err',
      processTerminated: true,
    },
  );
  assert.deepEqual(
    mapPtcSessionDockerNonExitCommandResult(
      { kind: 'crash', stdout: 'out', stderr: 'err' },
      'failed',
    ),
    { kind: 'failed', stdout: 'out', stderr: 'err' },
  );
});

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
    return;
  }
  process.env[key] = value;
}
