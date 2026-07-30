import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import {
  isGitReviewFileResult,
  isGitReviewReleaseResult,
  isGitReviewSummaryResult,
} from '@geulbat/protocol/git-review';

import {
  authHeaders,
  createRouteTestDaemonContext,
  withAuthenticatedDaemonServer,
  withDaemonServer,
} from '../../../test-support/http-routes.js';

const execFileAsync = promisify(execFile);

void test('Git review routes are authenticated, strict, no-store, and vertically usable', async (t) => {
  const repositoryRoot = await mkdtemp(join(tmpdir(), 'geulbat-git-route-'));
  t.after(async () => {
    await rm(repositoryRoot, { recursive: true, force: true });
  });
  await runGit(repositoryRoot, ['init', '-q', '-b', 'main']);
  await runGit(repositoryRoot, ['config', 'user.name', 'Geulbat Test']);
  await runGit(repositoryRoot, [
    'config',
    'user.email',
    'geulbat@example.invalid',
  ]);
  await writeFile(join(repositoryRoot, 'tracked.txt'), 'before\n');
  await runGit(repositoryRoot, ['add', 'tracked.txt']);
  await runGit(repositoryRoot, ['commit', '-qm', 'initial']);
  await writeFile(join(repositoryRoot, 'tracked.txt'), 'after\n');

  await withDaemonServer(
    async ({ port }) => {
      const response = await postJson(
        port,
        '/api/git-review/summary',
        { kind: 'start', workingDirectory: repositoryRoot },
        false,
      );
      assert.equal(response.status, 401);
    },
    { daemonContext: createRouteTestDaemonContext() },
  );

  const authenticatedDaemonContext = createRouteTestDaemonContext();
  authenticatedDaemonContext.computerFileScope = {
    root: repositoryRoot,
    browseShortcuts: [],
  };
  authenticatedDaemonContext.computerFileRoot = repositoryRoot;
  await withAuthenticatedDaemonServer(
    async ({ port }) => {
      const malformed = await postJson(
        port,
        '/api/git-review/summary',
        {
          kind: 'start',
          workingDirectory: repositoryRoot,
          unexpected: true,
        },
        true,
      );
      assert.equal(malformed.status, 400);
      assert.equal(malformed.headers.get('cache-control'), 'no-store');

      const summaryResponse = await postJson(
        port,
        '/api/git-review/summary',
        { kind: 'start', workingDirectory: '' },
        true,
      );
      assert.equal(summaryResponse.status, 200);
      assert.equal(summaryResponse.headers.get('cache-control'), 'no-store');
      const summary: unknown = await summaryResponse.json();
      assert.equal(isGitReviewSummaryResult(summary), true);
      if (!isGitReviewSummaryResult(summary) || summary.kind !== 'changed') {
        return;
      }
      const file = summary.files.items[0];
      assert.ok(file);

      const fileResponse = await postJson(
        port,
        '/api/git-review/file',
        {
          kind: 'start',
          observationId: summary.observationId,
          fileId: file.fileId,
        },
        true,
      );
      assert.equal(fileResponse.status, 200);
      assert.equal(fileResponse.headers.get('cache-control'), 'no-store');
      const fileResult: unknown = await fileResponse.json();
      assert.equal(isGitReviewFileResult(fileResult), true);
      if (!isGitReviewFileResult(fileResult) || fileResult.kind !== 'ready') {
        return;
      }
      assert.equal(
        fileResult.rows.items.some(
          (row) => row.kind === 'addition' && row.content === 'after',
        ),
        true,
      );

      for (const body of [
        {
          kind: 'file',
          observationId: summary.observationId,
          fileObservationId: fileResult.fileObservationId,
        },
        {
          kind: 'summary',
          observationId: summary.observationId,
        },
      ] as const) {
        const releaseResponse = await postJson(
          port,
          '/api/git-review/release',
          body,
          true,
        );
        assert.equal(releaseResponse.status, 200);
        assert.equal(releaseResponse.headers.get('cache-control'), 'no-store');
        const releaseResult: unknown = await releaseResponse.json();
        assert.equal(isGitReviewReleaseResult(releaseResult), true);
      }
    },
    { daemonContext: authenticatedDaemonContext },
  );
});

async function postJson(
  port: number,
  path: string,
  body: unknown,
  authenticated: boolean,
): Promise<Response> {
  return await fetch(`http://127.0.0.1:${String(port)}${path}`, {
    method: 'POST',
    headers: authenticated
      ? authHeaders({ 'Content-Type': 'application/json' })
      : { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function runGit(cwd: string, args: readonly string[]): Promise<void> {
  await execFileAsync('git', args, {
    cwd,
    env: {
      PATH: process.env.PATH,
      LANG: 'C',
      LC_ALL: 'C',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
      GIT_TERMINAL_PROMPT: '0',
    },
  });
}
