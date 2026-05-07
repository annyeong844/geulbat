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
