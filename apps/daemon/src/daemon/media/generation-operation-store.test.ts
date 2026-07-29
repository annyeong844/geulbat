import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { testThreadId } from '../../test-support/thread-id.js';
import { createMediaGenerationRecoveryIdentity } from './contract.js';
import {
  markMediaGenerationEffectStarted,
  prepareMediaGenerationOperation,
  readMediaGenerationOperation,
  recordMediaGenerationCandidate,
  recordMediaGenerationProviderHandle,
  recordMediaGenerationProviderRequestDigest,
} from './generation-operation-store.js';

void test('media generation operation survives replacement with one provider handle and candidate', async () => {
  const stateRoot = await mkdtemp(join(tmpdir(), 'geulbat-media-operation-'));
  const threadId = testThreadId(970);
  const identity = createMediaGenerationRecoveryIdentity({
    kind: 'video',
    threadId,
    runId: 'run-media-operation',
    callId: 'call-media-operation',
    toolArgs: { prompt: 'one moon', durationSeconds: 5 },
  });
  try {
    await prepareMediaGenerationOperation({
      stateRoot,
      threadId,
      runId: 'run-media-operation',
      callId: 'call-media-operation',
      identity,
    });
    await markMediaGenerationEffectStarted({ stateRoot, threadId, identity });
    await recordMediaGenerationProviderHandle({
      stateRoot,
      threadId,
      identity,
      providerHandle: 'request-1',
    });
    await recordMediaGenerationCandidate({
      stateRoot,
      threadId,
      identity,
      candidate: { mediaRef: 'abc.mp4', byteLength: 3 },
    });

    assert.deepEqual(
      await readMediaGenerationOperation({ stateRoot, threadId, identity }),
      {
        effectStarted: true,
        providerHandle: 'request-1',
        candidate: { mediaRef: 'abc.mp4', byteLength: 3 },
      },
    );
    await recordMediaGenerationProviderHandle({
      stateRoot,
      threadId,
      identity,
      providerHandle: 'request-1',
    });
    await assert.rejects(
      recordMediaGenerationProviderHandle({
        stateRoot,
        threadId,
        identity,
        providerHandle: 'request-2',
      }),
      /stage conflicts/u,
    );
  } finally {
    await rm(stateRoot, { recursive: true, force: true });
  }
});

void test('media generation operation rejects a different argument identity before reading stages', async () => {
  const stateRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-media-operation-conflict-'),
  );
  const threadId = testThreadId(971);
  const original = createMediaGenerationRecoveryIdentity({
    kind: 'image',
    threadId,
    runId: 'run-media-operation-conflict',
    callId: 'call-media-operation-conflict',
    toolArgs: { prompt: 'one moon' },
  });
  const conflicting = createMediaGenerationRecoveryIdentity({
    kind: 'image',
    threadId,
    runId: 'run-media-operation-conflict',
    callId: 'call-media-operation-conflict',
    toolArgs: { prompt: 'two moons' },
  });
  try {
    await prepareMediaGenerationOperation({
      stateRoot,
      threadId,
      runId: 'run-media-operation-conflict',
      callId: 'call-media-operation-conflict',
      identity: original,
    });
    await assert.rejects(
      readMediaGenerationOperation({
        stateRoot,
        threadId,
        identity: conflicting,
      }),
      /identity conflicts/u,
    );
  } finally {
    await rm(stateRoot, { recursive: true, force: true });
  }
});

void test('media generation operation pins each provider request attempt before dispatch', async () => {
  const stateRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-media-provider-request-'),
  );
  const threadId = testThreadId(972);
  const identity = createMediaGenerationRecoveryIdentity({
    kind: 'video',
    threadId,
    runId: 'run-media-provider-request',
    callId: 'call-media-provider-request',
    toolArgs: { prompt: 'one moon' },
  });
  try {
    await prepareMediaGenerationOperation({
      stateRoot,
      threadId,
      runId: 'run-media-provider-request',
      callId: 'call-media-provider-request',
      identity,
    });
    await recordMediaGenerationProviderRequestDigest({
      stateRoot,
      threadId,
      identity,
      requestAttempt: 0,
      requestDigest: 'first-request',
    });
    await recordMediaGenerationProviderRequestDigest({
      stateRoot,
      threadId,
      identity,
      requestAttempt: 0,
      requestDigest: 'first-request',
    });
    await recordMediaGenerationProviderRequestDigest({
      stateRoot,
      threadId,
      identity,
      requestAttempt: 1,
      requestDigest: 'refreshed-auth-request',
    });

    await assert.rejects(
      recordMediaGenerationProviderRequestDigest({
        stateRoot,
        threadId,
        identity,
        requestAttempt: 0,
        requestDigest: 'changed-request',
      }),
      /provider-request-attempt-0\.json/u,
    );
  } finally {
    await rm(stateRoot, { recursive: true, force: true });
  }
});
