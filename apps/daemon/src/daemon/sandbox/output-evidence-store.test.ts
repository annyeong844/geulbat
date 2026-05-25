import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  mkdtemp,
  mkdir,
  readdir,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { createSandboxAttemptStore } from './attempt-store.js';
import { importSandboxOutputEvidence } from './output-evidence-store.js';
import { collectSandboxOutputRef } from './output-validation.js';

void test('importSandboxOutputEvidence copies validated output and writes a manifest', async () => {
  const workspaceRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-sandbox-evidence-workspace-'),
  );
  const sandboxRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-sandbox-evidence-source-'),
  );
  try {
    const outputDir = join(sandboxRoot, 'out');
    await mkdir(join(outputDir, 'nested'), { recursive: true });
    await writeFile(join(outputDir, 'result.json'), '{"ok":true}', 'utf8');
    await writeFile(join(outputDir, 'nested', 'log.txt'), 'hello', 'utf8');

    const store = createSandboxAttemptStore({
      now: () => '2026-05-18T00:00:00.000Z',
    });
    const attempt = store.createAttempt({
      jobKind: 'sandbox_probe',
      adapterKind: 'deterministic_probe',
      owner: { threadId: 'thread-1', runId: 'run-1' },
    });
    const collectedOutput = await collectSandboxOutputRef(outputDir, {
      maxFiles: 4,
      maxBytes: 64,
    });

    const outputRef = await importSandboxOutputEvidence({
      workspaceRoot,
      attempt,
      collectedOutput,
      now: () => '2026-05-18T00:00:01.000Z',
    });

    await rm(sandboxRoot, { recursive: true, force: true });

    assert.match(outputRef.evidenceRef, /^sandbox-output:/);
    assert.match(outputRef.rootPath, /\.geulbat[\\/]+sandbox-outputs/);
    assert.equal(
      await readFile(join(outputRef.rootPath, 'result.json'), 'utf8'),
      '{"ok":true}',
    );
    assert.equal(
      await readFile(join(outputRef.rootPath, 'nested', 'log.txt'), 'utf8'),
      'hello',
    );

    const manifest = JSON.parse(
      await readFile(
        join(dirname(outputRef.rootPath), 'manifest.json'),
        'utf8',
      ),
    ) as {
      evidenceRef: string;
      jobId: string;
      attemptId: string;
      createdAt: string;
      files: { relativePath: string; sha256: string }[];
    };
    assert.equal(manifest.evidenceRef, outputRef.evidenceRef);
    assert.equal(manifest.jobId, 'sandbox-job-1');
    assert.equal(manifest.attemptId, 'sandbox-attempt-1');
    assert.equal(manifest.createdAt, '2026-05-18T00:00:01.000Z');
    assert.deepEqual(
      manifest.files.map((file) => file.relativePath),
      ['nested/log.txt', 'result.json'],
    );
    assert.equal(
      manifest.files.find((file) => file.relativePath === 'result.json')
        ?.sha256,
      createHash('sha256').update('{"ok":true}').digest('hex'),
    );
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
    await rm(sandboxRoot, { recursive: true, force: true });
  }
});

void test('importSandboxOutputEvidence rejects output that changes after validation', async () => {
  const workspaceRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-sandbox-evidence-workspace-'),
  );
  const sandboxRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-sandbox-evidence-source-'),
  );
  try {
    const outputDir = join(sandboxRoot, 'out');
    await mkdir(outputDir, { recursive: true });
    await writeFile(join(outputDir, 'result.txt'), 'alpha', 'utf8');

    const store = createSandboxAttemptStore({
      now: () => '2026-05-18T00:00:00.000Z',
    });
    const attempt = store.createAttempt({
      jobKind: 'sandbox_probe',
      adapterKind: 'deterministic_probe',
    });
    const collectedOutput = await collectSandboxOutputRef(outputDir, {
      maxFiles: 4,
      maxBytes: 64,
    });
    await writeFile(join(outputDir, 'result.txt'), 'bravo', 'utf8');

    await assert.rejects(
      () =>
        importSandboxOutputEvidence({
          workspaceRoot,
          attempt,
          collectedOutput,
        }),
      /sandbox output changed before import/,
    );
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
    await rm(sandboxRoot, { recursive: true, force: true });
  }
});

void test('importSandboxOutputEvidence removes partial evidence when import fails', async () => {
  const workspaceRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-sandbox-evidence-workspace-'),
  );
  const sandboxRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-sandbox-evidence-source-'),
  );
  try {
    const outputDir = join(sandboxRoot, 'out');
    await mkdir(outputDir, { recursive: true });
    await writeFile(join(outputDir, 'first.txt'), 'first', 'utf8');
    await writeFile(join(outputDir, 'second.txt'), 'second', 'utf8');

    const store = createSandboxAttemptStore({
      now: () => '2026-05-18T00:00:00.000Z',
    });
    const attempt = store.createAttempt({
      jobKind: 'sandbox_probe',
      adapterKind: 'deterministic_probe',
    });
    const collectedOutput = await collectSandboxOutputRef(outputDir, {
      maxFiles: 4,
      maxBytes: 64,
    });
    await writeFile(join(outputDir, 'second.txt'), 'changed', 'utf8');

    await assert.rejects(
      () =>
        importSandboxOutputEvidence({
          workspaceRoot,
          attempt,
          collectedOutput,
        }),
      /sandbox output changed before import/,
    );

    const evidenceRoot = join(workspaceRoot, '.geulbat', 'sandbox-outputs');
    assert.deepEqual(await readDirOrEmpty(evidenceRoot), []);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
    await rm(sandboxRoot, { recursive: true, force: true });
  }
});

void test('importSandboxOutputEvidence uses collision-resistant evidence refs by default', async () => {
  const workspaceRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-sandbox-evidence-workspace-'),
  );
  const sandboxRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-sandbox-evidence-source-'),
  );
  try {
    const outputDir = join(sandboxRoot, 'out');
    await mkdir(outputDir, { recursive: true });
    await writeFile(join(outputDir, 'result.txt'), 'ok', 'utf8');

    const store = createSandboxAttemptStore({
      now: () => '2026-05-18T00:00:00.000Z',
    });
    const attempt = store.createAttempt({
      jobKind: 'sandbox_probe',
      adapterKind: 'deterministic_probe',
    });
    const collectedOutput = await collectSandboxOutputRef(outputDir, {
      maxFiles: 4,
      maxBytes: 64,
    });

    const outputRef = await importSandboxOutputEvidence({
      workspaceRoot,
      attempt,
      collectedOutput,
    });

    assert.match(outputRef.evidenceRef, /^sandbox-output:/);
    assert.notEqual(outputRef.evidenceRef, 'sandbox-output:sandbox-attempt-1');
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
    await rm(sandboxRoot, { recursive: true, force: true });
  }
});

async function readDirOrEmpty(path: string): Promise<string[]> {
  try {
    return await readdir(path);
  } catch (error: unknown) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return [];
    }
    throw error;
  }
}
