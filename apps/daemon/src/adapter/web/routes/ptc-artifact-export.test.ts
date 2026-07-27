import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import express from 'express';

import { createPtcArtifactExportRoutes } from './ptc-artifact-export.js';
import { createPtcArtifactExportService } from '../../../daemon/ptc-artifact-export-service.js';
import { createSandboxAttemptStore } from '../../../daemon/sandbox/attempt-store.js';
import { importSandboxOutputEvidence } from '../../../daemon/sandbox/output-evidence-store.js';
import { collectSandboxOutputRef } from '../../../daemon/sandbox/output-validation.js';

interface ArtifactRouteHarness {
  baseUrl: string;
  root: string;
  sourceRoot: string;
  close(): Promise<void>;
}

async function startHarness(): Promise<ArtifactRouteHarness> {
  const root = await mkdtemp(join(tmpdir(), 'ptc-artifact-route-state-'));
  const sourceRoot = await mkdtemp(
    join(tmpdir(), 'ptc-artifact-route-source-'),
  );
  const app = express();
  app.use(
    createPtcArtifactExportRoutes({
      service: createPtcArtifactExportService({
        homeStateRoot: root,
      }),
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
    sourceRoot,
    close: async () => {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      await Promise.all([
        rm(root, { recursive: true, force: true }),
        rm(sourceRoot, { recursive: true, force: true }),
      ]);
    },
  };
}

void test('artifact route serves an exported evidence file inline or as a download', async () => {
  const harness = await startHarness();
  try {
    const relativePath = 'reports/summary.txt';
    const contents = 'artifact result\n';
    await mkdir(join(harness.sourceRoot, 'reports'), { recursive: true });
    await writeFile(join(harness.sourceRoot, relativePath), contents, 'utf8');

    const attemptStore = createSandboxAttemptStore();
    const attempt = attemptStore.createAttempt({
      jobKind: 'ptc_execute_code_artifact_export',
      adapterKind: 'ptc_lab_artifact_workspace',
      owner: { threadId: 'thread-artifact', runId: 'run-artifact' },
    });
    const collectedOutput = await collectSandboxOutputRef(harness.sourceRoot, {
      maxFiles: 1,
      maxBytes: Buffer.byteLength(contents),
    });
    const evidence = await importSandboxOutputEvidence({
      workspaceRoot: harness.root,
      attempt,
      collectedOutput,
    });
    const query = new URLSearchParams({
      evidenceRef: evidence.evidenceRef,
      relativePath,
    });

    const inline = await fetch(
      `${harness.baseUrl}/api/ptc-artifacts/file?${query}`,
    );
    assert.equal(inline.status, 200);
    assert.equal(await inline.text(), contents);
    assert.equal(inline.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(
      inline.headers.get('content-security-policy'),
      "sandbox; default-src 'none'; style-src 'unsafe-inline'",
    );
    assert.equal(
      inline.headers.get('content-disposition'),
      "inline; filename*=UTF-8''summary.txt",
    );
    assert.equal(
      inline.headers.get('etag'),
      `"sha256-${createHash('sha256').update(contents).digest('hex')}"`,
    );

    query.set('download', '1');
    const download = await fetch(
      `${harness.baseUrl}/api/ptc-artifacts/file?${query}`,
    );
    assert.equal(download.status, 200);
    assert.equal(await download.text(), contents);
    assert.equal(
      download.headers.get('content-disposition'),
      "attachment; filename*=UTF-8''summary.txt",
    );
  } finally {
    await harness.close();
  }
});

void test('artifact route maps invalid and missing evidence without exposing the sandbox store', async () => {
  const harness = await startHarness();
  try {
    const invalidRef = new URLSearchParams({
      evidenceRef: 'not-an-evidence-ref',
      relativePath: 'reports/summary.txt',
    });
    const invalidResponse = await fetch(
      `${harness.baseUrl}/api/ptc-artifacts/file?${invalidRef}`,
    );
    assert.equal(invalidResponse.status, 400);

    const missingRef = new URLSearchParams({
      evidenceRef: 'sandbox-output:missing-evidence',
      relativePath: 'reports/summary.txt',
    });
    const missingResponse = await fetch(
      `${harness.baseUrl}/api/ptc-artifacts/file?${missingRef}`,
    );
    assert.equal(missingResponse.status, 404);
  } finally {
    await harness.close();
  }
});
