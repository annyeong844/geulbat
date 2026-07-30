import assert from 'node:assert/strict';
import { threadProjectionPinDeletionPort } from '../../../daemon/tools/tool-library-projection-store.js';
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
          getRunByOwnerThread: () => undefined,
        },
        backgroundNotifications: {
          clearThreadBackgroundResults() {},
          readThreadBackgroundResultHistory: () => [],
        },
        threadProjectionPins: threadProjectionPinDeletionPort,
        threadArchiveTransfer: {
          async exportArchive() {
            throw new Error('thread archive is outside this harness');
          },
          async importArchive() {
            throw new Error('thread archive is outside this harness');
          },
        },
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

void test('provider-transition route prepares a portable snapshot for a same-provider model change', async () => {
  const seen: Array<
    Parameters<
      ThreadsRoutesContext['providerTransitionCompaction']['prepare']
    >[0]
  > = [];
  const harness = await startHarness({
    async prepare(args) {
      seen.push(args);
      return { kind: 'compacted', compactionEntryId: 'entry-model-change' };
    },
  });
  try {
    const response = await fetch(
      `${harness.baseUrl}/api/threads/${THREAD_ID}/provider-transition`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sourceModelId: 'gpt-5.6-sol',
          targetModelId: 'gpt-5.6-luna',
          reasoningEffort: 'high',
        }),
      },
    );

    assert.equal(response.status, 200);
    assert.equal(seen.length, 1);
    assert.deepEqual(seen[0]?.source, {
      providerId: 'openai_codex_direct',
      model: 'gpt-5.6-sol',
    });
    assert.deepEqual(seen[0]?.target, {
      providerId: 'openai_codex_direct',
      model: 'gpt-5.6-luna',
    });
  } finally {
    await harness.close();
  }
});

void test('provider-transition route rejects invalid admissions and skips same-model preparation', async () => {
  let prepareCalls = 0;
  const harness = await startHarness({
    async prepare() {
      prepareCalls += 1;
      return { kind: 'compacted', compactionEntryId: 'must-not-commit' };
    },
  });
  try {
    const invalidThread = await fetch(
      `${harness.baseUrl}/api/threads/not-a-thread/provider-transition`,
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
    assert.equal(invalidThread.status, 400);
    assert.deepEqual(await invalidThread.json(), {
      code: 'bad_request',
      message: 'invalid threadId',
    });

    const invalidBody = await fetch(
      `${harness.baseUrl}/api/threads/${THREAD_ID}/provider-transition`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      },
    );
    assert.equal(invalidBody.status, 400);
    assert.deepEqual(await invalidBody.json(), {
      code: 'invalid_args',
      message: 'invalid provider transition request',
    });

    const unsupportedEffort = await fetch(
      `${harness.baseUrl}/api/threads/${THREAD_ID}/provider-transition`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sourceModelId: 'grok-4.5',
          targetModelId: 'gpt-5.6-sol',
          reasoningEffort: 'xhigh',
        }),
      },
    );
    assert.equal(unsupportedEffort.status, 400);
    assert.deepEqual(await unsupportedEffort.json(), {
      code: 'invalid_args',
      message: 'reasoning effort is unavailable for the source model',
    });

    const sameModel = await fetch(
      `${harness.baseUrl}/api/threads/${THREAD_ID}/provider-transition`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sourceModelId: 'grok-4.5',
          targetModelId: 'grok-4.5',
          reasoningEffort: 'high',
        }),
      },
    );
    assert.equal(sameModel.status, 200);
    assert.deepEqual(await sameModel.json(), {
      ok: true,
      status: 'not_needed',
      threadId: THREAD_ID,
      sourceModelId: 'grok-4.5',
      targetModelId: 'grok-4.5',
    });
    assert.equal(prepareCalls, 0);
  } finally {
    await harness.close();
  }
});

void test('provider-transition route reports when preparation finds no transcript to compact', async () => {
  const harness = await startHarness({
    async prepare() {
      return { kind: 'not_needed', reason: 'transcript_empty' };
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
      status: 'not_needed',
      threadId: THREAD_ID,
      sourceModelId: 'grok-4.5',
      targetModelId: 'gpt-5.6-sol',
    });
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

void test('provider-transition route returns a typed actionable preparation failure', async () => {
  const harness = await startHarness({
    async prepare() {
      return {
        kind: 'failed',
        reason: 'provider_compaction_failed',
        message: 'provider transition context preparation failed',
      };
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

    assert.equal(response.status, 422);
    assert.deepEqual(await response.json(), {
      code: 'provider_transition_preparation_failed',
      message:
        'provider transition context preparation failed; retry, or continue with the selected model in a new thread',
      reason: 'provider_compaction_failed',
    });
  } finally {
    await harness.close();
  }
});
