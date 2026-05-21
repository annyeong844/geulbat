import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createSandboxAttemptStore } from './attempt-store.js';
import { runDeterministicSandboxProbe } from './probe-runner.js';

void test('runDeterministicSandboxProbe records succeeded attempts and output summaries', async () => {
  const workspaceRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-sandbox-probe-workspace-'),
  );
  try {
    const store = createSandboxAttemptStore({
      now: () => '2026-05-17T00:00:00.000Z',
    });

    const result = await runDeterministicSandboxProbe({
      workspaceRoot,
      store,
      timeoutMs: 1_000,
      processRunner: async (args) => {
        assert.equal(args.env.GITHUB_TOKEN, undefined);
        assert.equal(args.env.OPENAI_API_KEY, undefined);
        const home = args.env.HOME;
        if (typeof home !== 'string') {
          throw new Error('expected sandbox HOME');
        }
        assert.equal(home.includes(args.cwd), true);
        await args.writeOutput('result.json', '{"ok":true}');
        return { kind: 'exit', exitCode: 0, stdout: 'ok', stderr: '' };
      },
    });

    assert.equal(result.status, 'succeeded');
    assert.equal(result.outputRef?.files[0]?.relativePath, 'result.json');
    assert.equal(store.getAttempt(result.attemptId)?.status, 'succeeded');
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

void test('runDeterministicSandboxProbe preserves successful output in daemon-owned evidence storage', async () => {
  const workspaceRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-sandbox-evidence-workspace-'),
  );
  try {
    const store = createSandboxAttemptStore({
      now: () => '2026-05-17T00:00:00.000Z',
    });
    const probeArgs = {
      store,
      workspaceRoot,
      timeoutMs: 1_000,
      processRunner: async (args: {
        writeOutput(relativePath: string, content: string): Promise<void>;
      }) => {
        await args.writeOutput('result.json', '{"ok":true}');
        return { kind: 'exit' as const, exitCode: 0, stdout: 'ok', stderr: '' };
      },
    };

    const result = await runDeterministicSandboxProbe(probeArgs);
    const outputRef = result.outputRef as
      | (NonNullable<typeof result.outputRef> & { evidenceRef?: string })
      | null;

    assert.equal(result.status, 'succeeded');
    assert.ok(outputRef);
    assert.match(outputRef.evidenceRef ?? '', /^sandbox-output:/);
    assert.match(outputRef.rootPath, /\.geulbat[\\/]+sandbox-outputs/);
    assert.equal(
      await readFile(join(outputRef.rootPath, 'result.json'), 'utf8'),
      '{"ok":true}',
    );
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

void test('runDeterministicSandboxProbe classifies timeout cancellation crash and failed exit', async () => {
  for (const [kind, expectedStatus] of [
    ['timeout', 'timed_out'],
    ['cancelled', 'cancelled'],
    ['crash', 'crashed'],
    ['exit', 'failed'],
  ] as const) {
    const store = createSandboxAttemptStore({
      now: () => '2026-05-17T00:00:00.000Z',
    });
    const workspaceRoot = await mkdtemp(
      join(tmpdir(), 'geulbat-sandbox-probe-workspace-'),
    );
    try {
      const result = await runDeterministicSandboxProbe({
        workspaceRoot,
        store,
        timeoutMs: 1_000,
        processRunner: async () =>
          kind === 'exit'
            ? { kind, exitCode: 7, stdout: '', stderr: 'bad exit' }
            : { kind, stdout: '', stderr: `${kind} happened` },
      });

      assert.equal(result.status, expectedStatus);
      assert.equal(store.getAttempt(result.attemptId)?.status, expectedStatus);
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  }
});

void test('runDeterministicSandboxProbe default process runner executes harmless local probe', async () => {
  const workspaceRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-sandbox-probe-workspace-'),
  );
  try {
    const store = createSandboxAttemptStore({
      now: () => '2026-05-17T00:00:00.000Z',
    });

    const result = await runDeterministicSandboxProbe({
      workspaceRoot,
      store,
      timeoutMs: 5_000,
    });

    assert.equal(result.status, 'succeeded');
    assert.equal(result.exitCode, 0);
    assert.equal(result.outputRef?.files[0]?.relativePath, 'result.json');
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

void test('runDeterministicSandboxProbe records failed attempts when root creation fails', async () => {
  const workspaceRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-sandbox-probe-workspace-'),
  );
  const invalidTempRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-invalid-sandbox-parent-'),
  );
  const notDirectory = join(invalidTempRoot, 'not-a-directory');
  const previousTmpdir = process.env.TMPDIR;
  try {
    await writeFile(notDirectory, 'not a directory', 'utf8');
    process.env.TMPDIR = notDirectory;

    const store = createSandboxAttemptStore({
      now: () => '2026-05-17T00:00:00.000Z',
    });

    const result = await runDeterministicSandboxProbe({
      workspaceRoot,
      store,
      timeoutMs: 1_000,
    });

    assert.equal(result.status, 'failed');
    assert.match(result.diagnostics ?? '', /sandbox_root_failed/u);
    assert.equal(store.getAttempts().records.length, 1);
    assert.equal(store.getAttempt(result.attemptId)?.status, 'failed');
  } finally {
    if (previousTmpdir === undefined) {
      delete process.env.TMPDIR;
    } else {
      process.env.TMPDIR = previousTmpdir;
    }
    await rm(workspaceRoot, { recursive: true, force: true });
    await rm(invalidTempRoot, { recursive: true, force: true });
  }
});
