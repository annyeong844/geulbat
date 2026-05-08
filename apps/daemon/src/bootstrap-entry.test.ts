import test from 'node:test';
import assert from 'node:assert/strict';

import { bootstrapDaemonEntry } from './bootstrap-entry.js';

void test('bootstrapDaemonEntry loads env before importing main', async () => {
  const calls: string[] = [];

  await bootstrapDaemonEntry({
    loadEnv: () => {
      calls.push('loadEnv');
    },
    importMain: async () => {
      calls.push('importMain');
    },
  });

  assert.deepEqual(calls, ['loadEnv', 'importMain']);
});

void test('bootstrapDaemonEntry does not import main when env loading fails', async () => {
  const calls: string[] = [];

  await assert.rejects(
    () =>
      bootstrapDaemonEntry({
        loadEnv: () => {
          calls.push('loadEnv');
          throw new Error('env failed');
        },
        importMain: async () => {
          calls.push('importMain');
        },
      }),
    /env failed/,
  );

  assert.deepEqual(calls, ['loadEnv']);
});

void test('bootstrapDaemonEntry validates provider runtime knobs before importing main', async () => {
  const calls: string[] = [];
  const previous = process.env['GEULBAT_CODEX_REASONING_EFFORT'];

  try {
    await assert.rejects(
      () =>
        bootstrapDaemonEntry({
          loadEnv: () => {
            calls.push('loadEnv');
            process.env['GEULBAT_CODEX_REASONING_EFFORT'] = 'mid';
          },
          importMain: async () => {
            calls.push('importMain');
          },
        }),
      /invalid GEULBAT_CODEX_REASONING_EFFORT: mid/,
    );
  } finally {
    restoreEnv('GEULBAT_CODEX_REASONING_EFFORT', previous);
  }

  assert.deepEqual(calls, ['loadEnv']);
});

void test('bootstrapDaemonEntry validates subagent runtime knobs before importing main', async () => {
  const calls: string[] = [];
  const previous = process.env['GEULBAT_SUBAGENT_BACKGROUND_CAPACITY'];

  try {
    await assert.rejects(
      () =>
        bootstrapDaemonEntry({
          loadEnv: () => {
            calls.push('loadEnv');
            process.env['GEULBAT_SUBAGENT_BACKGROUND_CAPACITY'] = 'foo';
          },
          importMain: async () => {
            calls.push('importMain');
          },
        }),
      /invalid GEULBAT_SUBAGENT_BACKGROUND_CAPACITY: foo/,
    );
  } finally {
    restoreEnv('GEULBAT_SUBAGENT_BACKGROUND_CAPACITY', previous);
  }

  assert.deepEqual(calls, ['loadEnv']);
});

void test('bootstrapDaemonEntry still loads env before surfacing main import failure', async () => {
  const calls: string[] = [];

  await assert.rejects(
    () =>
      bootstrapDaemonEntry({
        loadEnv: () => {
          calls.push('loadEnv');
        },
        importMain: async () => {
          calls.push('importMain');
          throw new Error('main failed');
        },
      }),
    /main failed/,
  );

  assert.deepEqual(calls, ['loadEnv', 'importMain']);
});

function restoreEnv(name: string, previous: string | undefined): void {
  if (previous === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = previous;
  }
}
