import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import express from 'express';

import { createArtifactRuntimePersistenceRoutes } from './adapter/web/routes/artifact-runtime-persistence.js';
import type { DaemonContext } from './daemon/context.js';
import { DEFAULT_PROJECT_ID } from './daemon/files/project-registry-state.js';
import { MAX_RUNTIME_PERSISTENCE_FILE_BYTES } from './daemon/artifact-runtime-persistence/quota.js';
import { assertThreadId as assertValidThreadId } from '@geulbat/protocol/ids';
import {
  authHeaders,
  createRouteTestDaemonContext,
  getWorkspaceRootFromContext,
  withAuthenticatedDaemonServer,
} from './test-support/http-routes.js';
import { testRunId } from './test-support/run-id.js';

function createRuntimePersistenceScope(
  overrides: Record<string, unknown> = {},
) {
  return {
    projectId: DEFAULT_PROJECT_ID,
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
  await mkdir(getWorkspaceRootFromContext(daemonContext), { recursive: true });
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

void test('authenticated runtime persistence save route returns 413 on quota exceed', async () => {
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
            artifactId: 'art_route_oversized_js',
          }),
          state: {
            text: 'x'.repeat(MAX_RUNTIME_PERSISTENCE_FILE_BYTES),
          },
          expectedRevision: null,
        }),
      },
    );

    assert.equal(res.status, 413);
    const body = (await res.json()) as { code: string; message: string };
    assert.equal(body.code, 'persistence_quota_exceeded');
    assert.match(body.message, /per-artifact quota/);
  });
});

void test('authenticated runtime persistence routes reject invalid project ids before persistence access', async () => {
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
      message: 'invalid projectId: ../workspace',
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
      projectId: DEFAULT_PROJECT_ID,
      workspaceRoot: getWorkspaceRootFromContext(daemonContext),
      ownerThreadId: threadId,
      abortController,
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
      message: 'state is required',
    });
  });
});

void test('authenticated runtime persistence routes preserve unknown project failure shape', async () => {
  await withRuntimePersistenceServer(async ({ port }) => {
    const res = await fetch(
      `http://127.0.0.1:${port}/api/artifact-runtime-persistence/load`,
      {
        method: 'POST',
        headers: authHeaders({
          'Content-Type': 'application/json',
        }),
        body: JSON.stringify(
          createRuntimePersistenceScope({
            projectId: 'missing-project',
            artifactId: 'art_route_missing_project_js',
          }),
        ),
      },
    );

    assert.equal(res.status, 404);
    assert.deepEqual(await res.json(), {
      code: 'not_found',
      message: 'unknown projectId: missing-project',
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
      projectRegistry: daemonContext.projectRegistry,
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
