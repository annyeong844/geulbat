import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import express from 'express';

import { testRunId } from '../../../test-support/run-id.js';
import type { ThreadsRoutesContext } from './routes-context.js';
import { createThreadsRoutes } from './threads.js';

const THREAD_ID = '11111111-1111-4111-8111-111111111111';

interface RouteHarness {
  baseUrl: string;
  close(): Promise<void>;
}

async function startHarness(args: {
  activeRunId?: string;
  prepare: ThreadsRoutesContext['providerTransitionCompaction']['prepare'];
}): Promise<RouteHarness> {
  const root = await mkdtemp(join(tmpdir(), 'provider-transition-route-'));
  const app = express();
  app.use(express.json());
  app.use(
    createThreadsRoutes({
      context: {
        homeStateRoot: root,
        activeRuns: {
          getRunByThreadId: () =>
            args.activeRunId === undefined
              ? undefined
              : { runId: testRunId(args.activeRunId) },
        },
        backgroundNotifications: { clearThreadBackgroundResults() {} },
        providerTransitionCompaction: { prepare: args.prepare },
      },
    }),
  );
  const server: Server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('unexpected server address');
  }
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    async close() {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      await rm(root, { recursive: true, force: true });
    },
  };
}

void test('provider-transition route prepares a cross-provider snapshot before acknowledging selection', async () => {
  const seen: Array<
    Parameters<
      ThreadsRoutesContext['providerTransitionCompaction']['prepare']
    >[0]
  > = [];
  const harness = await startHarness({
    async prepare(args) {
      seen.push(args);
      return { kind: 'compacted', compactionEntryId: 'entry-transition' };
    },
  });
  try {
    const response = await fetch(
      `${harness.baseUrl}/api/threads/${THREAD_ID}/provider-transition`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sourceModelId: 'grok-4.5',
          targetModelId: 'gpt-5.6-sol',
          reasoningEffort: 'high',
        }),
      },
    );

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      ok: true,
      status: 'compacted',
      threadId: THREAD_ID,
      sourceModelId: 'grok-4.5',
      targetModelId: 'gpt-5.6-sol',
      compactionEntryId: 'entry-transition',
    });
    assert.equal(seen.length, 1);
    const prepared = seen[0];
    assert.ok(prepared);
    assert.match(prepared.workspaceRoot, /provider-transition-route-/u);
    assert.deepEqual(
      { ...prepared, workspaceRoot: '<root>' },
      {
        workspaceRoot: '<root>',
        threadId: THREAD_ID,
        source: { providerId: 'grok_oauth', model: 'grok-4.5' },
        target: {
          providerId: 'openai_codex_direct',
          model: 'gpt-5.6-sol',
        },
        reasoningEffort: 'high',
      },
    );
  } finally {
    await harness.close();
  }
});

void test('provider-transition route refuses to compact while the thread has an active run', async () => {
  let prepareCalls = 0;
  const harness = await startHarness({
    activeRunId: 'run-active',
    async prepare() {
      prepareCalls += 1;
      return { kind: 'compacted', compactionEntryId: 'must-not-commit' };
    },
  });
  try {
    const response = await fetch(
      `${harness.baseUrl}/api/threads/${THREAD_ID}/provider-transition`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sourceModelId: 'grok-4.5',
          targetModelId: 'gpt-5.6-sol',
          reasoningEffort: 'high',
        }),
      },
    );

    assert.equal(response.status, 409);
    assert.equal(prepareCalls, 0);
    assert.deepEqual(await response.json(), {
      code: 'conflict_active_run',
      message: `thread ${THREAD_ID} has an active run`,
      threadId: THREAD_ID,
      activeRunId: testRunId('run-active'),
    });
  } finally {
    await harness.close();
  }
});
