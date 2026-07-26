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
    '../../../docker-client-command.js',
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

void test('runPtcSessionDockerCommand fails closed without an injected host runner', async () => {
  const result = await runPtcSessionDockerCommand({
    executable: process.execPath,
    args: ['-e', 'process.stdout.write("must-not-run")'],
  });

  assert.deepEqual(result, {
    kind: 'crash',
    stdout: '',
    stderr: 'docker command requires the daemon host command runtime',
  });
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
