import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import express from 'express';

import { testThreadId } from '../../../test-support/thread-id.js';
import { commitThreadArtifactVersion } from '../../../daemon/sessions/artifact-store.js';
import { createThreadsRoutes } from './threads.js';

const THREAD_ID = testThreadId(701);

interface RouteHarness {
  baseUrl: string;
  root: string;
  close(): Promise<void>;
}

async function startHarness(): Promise<RouteHarness> {
  const root = await mkdtemp(join(tmpdir(), 'artifact-version-route-'));
  const app = express();
  app.use(express.json({ limit: '4mb' }));
  app.use(
    createThreadsRoutes({
      context: {
        homeStateRoot: root,
        activeRuns: { getRunByThreadId: () => undefined },
        backgroundNotifications: { clearThreadBackgroundResults() {} },
        providerTransitionCompaction: {
          prepare: async () => {
            throw new Error('not used in this test');
          },
        },
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
    root,
    async close() {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      await rm(root, { recursive: true, force: true });
    },
  };
}

async function commitSeedArtifact(root: string): Promise<string> {
  const created = await commitThreadArtifactVersion({
    workspaceRoot: root,
    threadId: THREAD_ID,
    runId: 'run-seed',
    renderer: 'markdown',
    payload: '# v1',
    digest: null,
    title: '초안',
    sourceRef: null,
    timestamp: '2026-07-17T00:00:00.000Z',
  });
  return created.artifact.artifactId;
}

void test('artifact draft version route commits the next version and returns the thread artifact', async () => {
  const harness = await startHarness();
  try {
    const artifactId = await commitSeedArtifact(harness.root);
    const response = await fetch(
      `${harness.baseUrl}/api/threads/${THREAD_ID}/artifacts/${artifactId}/versions`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ baseVersion: 1, payload: '# v2 draft' }),
      },
    );

    assert.equal(response.status, 200);
    const body: unknown = await response.json();
    assert.ok(body !== null && typeof body === 'object');
    const typed = body as {
      ok: boolean;
      artifact: {
        artifactId: string;
        version: number;
        parentVersion: number | null;
        payload: string;
        title: string | null;
      };
      ref: { artifactId: string; version: number };
    };
    assert.equal(typed.ok, true);
    assert.equal(typed.artifact.artifactId, artifactId);
    assert.equal(typed.artifact.version, 2);
    assert.equal(typed.artifact.parentVersion, 1);
    assert.equal(typed.artifact.payload, '# v2 draft');
    assert.equal(typed.artifact.title, '초안');
    assert.deepEqual(typed.ref, { artifactId, version: 2 });
  } finally {
    await harness.close();
  }
});

void test('artifact draft version route maps conflicts, missing artifacts, and bad bodies', async () => {
  const harness = await startHarness();
  try {
    const artifactId = await commitSeedArtifact(harness.root);

    // 잘못된 body — baseVersion/payload 형태 위반
    const badBody = await fetch(
      `${harness.baseUrl}/api/threads/${THREAD_ID}/artifacts/${artifactId}/versions`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ baseVersion: 0, payload: '' }),
      },
    );
    assert.equal(badBody.status, 400);

    // 없는 아티팩트 — 404
    const missing = await fetch(
      `${harness.baseUrl}/api/threads/${THREAD_ID}/artifacts/art_missing/versions`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ baseVersion: 1, payload: '# x' }),
      },
    );
    assert.equal(missing.status, 404);

    // 스테일 baseVersion — 409 + latestVersion 회신
    const first = await fetch(
      `${harness.baseUrl}/api/threads/${THREAD_ID}/artifacts/${artifactId}/versions`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ baseVersion: 1, payload: '# v2' }),
      },
    );
    assert.equal(first.status, 200);
    const stale = await fetch(
      `${harness.baseUrl}/api/threads/${THREAD_ID}/artifacts/${artifactId}/versions`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ baseVersion: 1, payload: '# stale' }),
      },
    );
    assert.equal(stale.status, 409);
    const staleBody: unknown = await stale.json();
    assert.ok(staleBody !== null && typeof staleBody === 'object');
    assert.equal((staleBody as { latestVersion?: number }).latestVersion, 2);
  } finally {
    await harness.close();
  }
});
