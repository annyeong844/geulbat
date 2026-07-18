import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import express from 'express';

import { createArtifactRuntimePersistenceRoutes } from './adapter/web/routes/artifact-runtime-persistence.js';
import { readArtifactRuntimePersistenceStateInputRef } from './daemon/artifact-runtime-persistence/input-ref-store.js';
import { createRunInterjectBuffer } from './daemon/sessions/active-run-interject-buffer.js';
import type { DaemonContext } from './daemon/context.js';
import { assertThreadId as assertValidThreadId } from '@geulbat/protocol/ids';
import {
  authHeaders,
  createRouteTestDaemonContext,
  getHomeStateRootFromContext,
  withAuthenticatedDaemonServer,
} from './test-support/http-routes.js';
import { testRunId } from './test-support/run-id.js';

function createRuntimePersistenceScope(
  overrides: Record<string, unknown> = {},
) {
  return {
    threadId: '00000000-0000-4000-8000-000000000001',
    renderer: 'js',
    artifactId: 'art_route_demo_js',
    persistenceEpoch: 0,
    ...overrides,
  };
}

async function withRuntimePersistenceServer<T>(
  run: (ctx: { port: number; daemonContext: DaemonContext }) => Promise<T>,
  args?: { daemonContext?: DaemonContext },
): Promise<T> {
  const daemonContext = args?.daemonContext ?? createRouteTestDaemonContext();
  await mkdir(getHomeStateRootFromContext(daemonContext), { recursive: true });
  return withAuthenticatedDaemonServer(run, { daemonContext });
}

void test('authenticated runtime persistence routes support load/save/clear with CAS', async () => {
  await withRuntimePersistenceServer(async ({ port }) => {
    const loadRes = await fetch(
      `http://127.0.0.1:${port}/api/artifact-runtime-persistence/load`,
      {
        method: 'POST',
        headers: authHeaders({
          'Content-Type': 'application/json',
        }),
        body: JSON.stringify(createRuntimePersistenceScope()),
      },
    );

    assert.equal(loadRes.status, 200);
    assert.deepEqual(await loadRes.json(), {
      state: null,
      revision: null,
    });

    const saveRes = await fetch(
      `http://127.0.0.1:${port}/api/artifact-runtime-persistence/save`,
      {
        method: 'POST',
        headers: authHeaders({
          'Content-Type': 'application/json',
        }),
        body: JSON.stringify({
          ...createRuntimePersistenceScope(),
          state: { count: 1 },
          expectedRevision: null,
        }),
      },
    );

    assert.equal(saveRes.status, 200);
    const saveBody = (await saveRes.json()) as { revision: string };
    assert.equal(typeof saveBody.revision, 'string');
    assert.ok(saveBody.revision.length > 0);

    const staleSaveRes = await fetch(
      `http://127.0.0.1:${port}/api/artifact-runtime-persistence/save`,
      {
        method: 'POST',
        headers: authHeaders({
          'Content-Type': 'application/json',
        }),
        body: JSON.stringify({
          ...createRuntimePersistenceScope(),
          state: { count: 2 },
          expectedRevision: null,
        }),
      },
    );

    assert.equal(staleSaveRes.status, 409);
    assert.deepEqual(await staleSaveRes.json(), {
      code: 'persistence_conflict',
      message: 'runtime persistence revision does not match expectedRevision',
    });

    const clearRes = await fetch(
      `http://127.0.0.1:${port}/api/artifact-runtime-persistence/clear`,
      {
        method: 'POST',
        headers: authHeaders({
          'Content-Type': 'application/json',
        }),
        body: JSON.stringify({
          ...createRuntimePersistenceScope(),
          expectedRevision: saveBody.revision,
        }),
      },
    );

    assert.equal(clearRes.status, 200);
    assert.deepEqual(await clearRes.json(), {
      revision: null,
    });
  });
});

void test('authenticated runtime persistence save route accepts states larger than the retired per-artifact quota', async () => {
  await withRuntimePersistenceServer(async ({ port }) => {
    const largeState = {
      // Regression fixture only: larger than the retired 64 KiB per-artifact quota,
      // but below the current HTTP JSON transport body guard.
      text: 'x'.repeat(96 * 1024),
    };
    const res = await fetch(
      `http://127.0.0.1:${port}/api/artifact-runtime-persistence/save`,
      {
        method: 'POST',
        headers: authHeaders({
          'Content-Type': 'application/json',
        }),
        body: JSON.stringify({
          ...createRuntimePersistenceScope({
            artifactId: 'art_route_oversized_js',
          }),
          state: largeState,
          expectedRevision: null,
        }),
      },
    );

    assert.equal(res.status, 200);
    const body = (await res.json()) as { revision: string };
    assert.equal(typeof body.revision, 'string');
    assert.ok(body.revision.length > 0);
  });
});

void test('authenticated runtime persistence save route accepts streamed state refs beyond the JSON body guard', async () => {
  await withRuntimePersistenceServer(async ({ port }) => {
    const longText = 'x'.repeat(300 * 1024);
    const uploadRes = await fetch(
      `http://127.0.0.1:${port}/api/artifact-runtime-persistence/state-inputs`,
      {
        method: 'POST',
        headers: authHeaders({
          'Content-Type': 'application/octet-stream',
        }),
        body: JSON.stringify({ text: longText }),
      },
    );

    assert.equal(uploadRes.status, 201);
    const uploadBody = (await uploadRes.json()) as {
      ok: true;
      stateRef: string;
      byteLength: number;
    };
    assert.equal(uploadBody.ok, true);
    assert.match(uploadBody.stateRef, /^artifact-runtime-state-input:/u);
    assert.ok(uploadBody.byteLength > longText.length);

    const saveRes = await fetch(
      `http://127.0.0.1:${port}/api/artifact-runtime-persistence/save`,
      {
        method: 'POST',
        headers: authHeaders({
          'Content-Type': 'application/json',
        }),
        body: JSON.stringify({
          ...createRuntimePersistenceScope({
            artifactId: 'art_route_state_ref_js',
          }),
          stateRef: uploadBody.stateRef,
          expectedRevision: null,
        }),
      },
    );

    assert.equal(saveRes.status, 200);
    const saveBody = (await saveRes.json()) as { revision: string };
    assert.equal(typeof saveBody.revision, 'string');
    assert.ok(saveBody.revision.length > 0);

    const loadRes = await fetch(
      `http://127.0.0.1:${port}/api/artifact-runtime-persistence/load`,
      {
        method: 'POST',
        headers: authHeaders({
          'Content-Type': 'application/json',
        }),
        body: JSON.stringify(
          createRuntimePersistenceScope({
            artifactId: 'art_route_state_ref_js',
          }),
        ),
      },
    );

    assert.equal(loadRes.status, 200);
    const loadBody = (await loadRes.json()) as {
      state: { text: string };
      revision: string;
    };
    assert.equal(loadBody.revision, saveBody.revision);
    assert.equal(loadBody.state.text.length, longText.length);
    assert.equal(loadBody.state.text, longText);
  });
});

void test('authenticated runtime persistence save route deletes consumed state refs after conflicts', async () => {
  const daemonContext = createRouteTestDaemonContext();
  const stateRoot = getHomeStateRootFromContext(daemonContext);
  await withRuntimePersistenceServer(
    async ({ port }) => {
      const scope = createRuntimePersistenceScope({
        artifactId: 'art_route_state_ref_conflict_js',
      });
      const initialSaveRes = await fetch(
        `http://127.0.0.1:${port}/api/artifact-runtime-persistence/save`,
        {
          method: 'POST',
          headers: authHeaders({
            'Content-Type': 'application/json',
          }),
          body: JSON.stringify({
            ...scope,
            state: { count: 1 },
            expectedRevision: null,
          }),
        },
      );
      assert.equal(initialSaveRes.status, 200);

      const uploadRes = await fetch(
        `http://127.0.0.1:${port}/api/artifact-runtime-persistence/state-inputs`,
        {
          method: 'POST',
          headers: authHeaders({
            'Content-Type': 'application/octet-stream',
          }),
          body: JSON.stringify({ count: 2 }),
        },
      );
      assert.equal(uploadRes.status, 201);
      const uploadBody = (await uploadRes.json()) as {
        stateRef: string;
      };

      const conflictSaveRes = await fetch(
        `http://127.0.0.1:${port}/api/artifact-runtime-persistence/save`,
        {
          method: 'POST',
          headers: authHeaders({
            'Content-Type': 'application/json',
          }),
          body: JSON.stringify({
            ...scope,
            stateRef: uploadBody.stateRef,
            expectedRevision: null,
          }),
        },
      );

      assert.equal(conflictSaveRes.status, 409);
      const resolved = await readArtifactRuntimePersistenceStateInputRef({
        workspaceRoot: stateRoot,
        stateRef: uploadBody.stateRef,
      });
      assert.deepEqual(resolved, {
        ok: false,
        code: 'not_found',
        message: 'stateRef was not found.',
      });
    },
    { daemonContext },
  );
});

void test('authenticated runtime persistence state input uploads reject JSON requests', async () => {
  await withRuntimePersistenceServer(async ({ port }) => {
    const res = await fetch(
      `http://127.0.0.1:${port}/api/artifact-runtime-persistence/state-inputs`,
      {
        method: 'POST',
        headers: authHeaders({
          'Content-Type': 'application/json',
        }),
        body: JSON.stringify({ count: 1 }),
      },
    );

    assert.equal(res.status, 400);
    assert.deepEqual(await res.json(), {
      code: 'bad_request',
      message:
        'runtime persistence state input upload must use a streaming content type',
    });
  });
});

void test('authenticated runtime persistence state input route deletes refs without parsing payloads', async () => {
  const daemonContext = createRouteTestDaemonContext();
  const stateRoot = getHomeStateRootFromContext(daemonContext);

  await withRuntimePersistenceServer(
    async ({ port }) => {
      const uploadRes = await fetch(
        `http://127.0.0.1:${port}/api/artifact-runtime-persistence/state-inputs`,
        {
          method: 'POST',
          headers: authHeaders({
            'Content-Type': 'application/octet-stream',
          }),
          body: 'not-json',
        },
      );
      assert.equal(uploadRes.status, 201);
      const uploadBody = (await uploadRes.json()) as { stateRef: string };

      const deleteRes = await fetch(
        `http://127.0.0.1:${port}/api/artifact-runtime-persistence/state-inputs?stateRef=${encodeURIComponent(
          uploadBody.stateRef,
        )}`,
        {
          method: 'DELETE',
          headers: authHeaders(),
        },
      );

      assert.equal(deleteRes.status, 200);
      assert.deepEqual(await deleteRes.json(), { ok: true });
      assert.deepEqual(
        await readArtifactRuntimePersistenceStateInputRef({
          workspaceRoot: stateRoot,
          stateRef: uploadBody.stateRef,
        }),
        {
          ok: false,
          code: 'not_found',
          message: 'stateRef was not found.',
        },
      );
    },
    { daemonContext },
  );
});

void test('authenticated runtime persistence save route rejects invalid state refs', async () => {
  await withRuntimePersistenceServer(async ({ port }) => {
    const res = await fetch(
      `http://127.0.0.1:${port}/api/artifact-runtime-persistence/save`,
      {
        method: 'POST',
        headers: authHeaders({
          'Content-Type': 'application/json',
        }),
        body: JSON.stringify({
          ...createRuntimePersistenceScope({
            artifactId: 'art_route_invalid_state_ref_js',
          }),
          stateRef: 'not-a-runtime-state-ref',
          expectedRevision: null,
        }),
      },
    );

    assert.equal(res.status, 400);
    assert.deepEqual(await res.json(), {
      code: 'bad_request',
      message: 'stateRef must be an artifact-runtime-state-input reference.',
    });
  });
});

void test('authenticated runtime persistence routes reject retired project scope before persistence access', async () => {
  await withRuntimePersistenceServer(async ({ port }) => {
    const res = await fetch(
      `http://127.0.0.1:${port}/api/artifact-runtime-persistence/load`,
      {
        method: 'POST',
        headers: authHeaders({
          'Content-Type': 'application/json',
        }),
        body: JSON.stringify(
          createRuntimePersistenceScope({ projectId: '../workspace' }),
        ),
      },
    );

    assert.equal(res.status, 400);
    assert.deepEqual(await res.json(), {
      code: 'bad_request',
      message: 'projectId is not supported',
    });
  });
});

void test('authenticated runtime persistence routes remain available during active runs', async () => {
  const daemonContext = createRouteTestDaemonContext();
  const threadId = assertValidThreadId(randomUUID());
  const runId = testRunId('runtime-persistence-active');
  const abortController = new AbortController();

  assert.deepEqual(
    daemonContext.activeRuns.tryStartRun(threadId, {
      runId,
      threadId,
      stateRoot: daemonContext.homeStateRoot,
      workingDirectory: 'stories',
      ownerThreadId: threadId,
      abortController,
      interject: createRunInterjectBuffer(),
      startedAt: '2026-03-29T00:00:00.000Z',
    }),
    { ok: true },
  );

  try {
    await withRuntimePersistenceServer(
      async ({ port }) => {
        const saveRes = await fetch(
          `http://127.0.0.1:${port}/api/artifact-runtime-persistence/save`,
          {
            method: 'POST',
            headers: authHeaders({
              'Content-Type': 'application/json',
            }),
            body: JSON.stringify({
              ...createRuntimePersistenceScope({
                threadId,
                artifactId: 'art_route_active_run_js',
              }),
              state: { count: 1 },
              expectedRevision: null,
            }),
          },
        );

        assert.equal(saveRes.status, 200);
        const saveBody = (await saveRes.json()) as { revision: string };
        assert.equal(typeof saveBody.revision, 'string');
        assert.ok(saveBody.revision.length > 0);

        const loadRes = await fetch(
          `http://127.0.0.1:${port}/api/artifact-runtime-persistence/load`,
          {
            method: 'POST',
            headers: authHeaders({
              'Content-Type': 'application/json',
            }),
            body: JSON.stringify(
              createRuntimePersistenceScope({
                threadId,
                artifactId: 'art_route_active_run_js',
              }),
            ),
          },
        );

        assert.equal(loadRes.status, 200);
        assert.deepEqual(await loadRes.json(), {
          state: { count: 1 },
          revision: saveBody.revision,
        });
      },
      { daemonContext },
    );
  } finally {
    daemonContext.activeRuns.finishRun(threadId, runId);
  }
});

void test('authenticated runtime persistence save route rejects invalid expectedRevision types', async () => {
  await withRuntimePersistenceServer(async ({ port }) => {
    const res = await fetch(
      `http://127.0.0.1:${port}/api/artifact-runtime-persistence/save`,
      {
        method: 'POST',
        headers: authHeaders({
          'Content-Type': 'application/json',
        }),
        body: JSON.stringify({
          ...createRuntimePersistenceScope({
            artifactId: 'art_route_invalid_revision_js',
          }),
          state: { count: 1 },
          expectedRevision: {},
        }),
      },
    );

    assert.equal(res.status, 400);
    assert.deepEqual(await res.json(), {
      code: 'bad_request',
      message: 'expectedRevision must be a string or null',
    });
  });
});

void test('authenticated runtime persistence save route requires state', async () => {
  await withRuntimePersistenceServer(async ({ port }) => {
    const res = await fetch(
      `http://127.0.0.1:${port}/api/artifact-runtime-persistence/save`,
      {
        method: 'POST',
        headers: authHeaders({
          'Content-Type': 'application/json',
        }),
        body: JSON.stringify({
          ...createRuntimePersistenceScope({
            artifactId: 'art_route_missing_state_js',
          }),
          expectedRevision: null,
        }),
      },
    );

    assert.equal(res.status, 400);
    assert.deepEqual(await res.json(), {
      code: 'bad_request',
      message: 'state or stateRef is required',
    });
  });
});

void test('runtime persistence save route blocks non-JSON-serializable state before store access', async () => {
  const daemonContext = createRouteTestDaemonContext();
  const app = express();
  app.use((_req, _res, next) => {
    const req = _req as typeof _req & {
      body?: Record<string, unknown>;
    };
    req.body = {
      ...createRuntimePersistenceScope({
        artifactId: 'art_route_non_json_js',
      }),
      state: new Map([['count', 1]]),
      expectedRevision: null,
    };
    next();
  });
  app.use(
    createArtifactRuntimePersistenceRoutes({
      homeStateRoot: daemonContext.homeStateRoot,
    }),
  );

  const server = app.listen(0);

  try {
    const address = server.address();
    if (!address || typeof address === 'string') {
      throw new Error('runtime persistence test server did not bind a port');
    }

    const res = await fetch(
      `http://127.0.0.1:${address.port}/api/artifact-runtime-persistence/save`,
      {
        method: 'POST',
      },
    );

    assert.equal(res.status, 403);
    assert.deepEqual(await res.json(), {
      code: 'persistence_blocked',
      message: 'state must be JSON-serializable',
    });
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  }
});
