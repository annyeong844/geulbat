import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  agentLoopKernelImplementation,
  type AgentLoopKernelEvent,
  type AgentLoopKernelPorts,
} from '@geulbat/agent-loop/kernel';
import {
  sha256StableJson,
  stableStringify,
} from '@geulbat/content-identity/stable-json';

import {
  createXHarnessFileRunStore,
  type XHarnessRunStoreAdmissionInput,
} from './harness-run-store.js';
import { createHarnessConfigSnapshot } from './harness-snapshot.js';

interface TestResult {
  ok: boolean;
  text: string;
}

type TestPorts = AgentLoopKernelPorts<TestResult, never, never, string>;

function createAdmissionInput(
  attemptId = 'attempt-1',
  evidenceReferenceId?: string,
): XHarnessRunStoreAdmissionInput {
  return {
    harnessSnapshot: createHarnessConfigSnapshot({
      harnessId: 'durable-store-test',
      harnessVersion: 'v1',
      config: {
        loopImplementationId: agentLoopKernelImplementation.implementationId,
        promptVersion: 'v1',
      },
    }),
    traceIdentity: {
      taskId: 'task-1',
      attemptId,
      modelConfigId: 'model-config-1',
    },
    ...(evidenceReferenceId === undefined ? {} : { evidenceReferenceId }),
    implementation: agentLoopKernelImplementation,
  };
}

function createSingleRoundPorts(overrides: Partial<TestPorts> = {}): TestPorts {
  return {
    getHistoryItemCount: () => 0,
    async runModelRound() {
      return {
        ok: true,
        value: {
          assistantText: 'done',
          terminalResult: { ok: true, text: 'done' },
          functionCalls: [],
        },
      };
    },
    async processStructuredOutputs() {
      return { ok: true, handled: false };
    },
    appendAssistantText() {},
    appendHistoryItems() {},
    appendFunctionCalls() {},
    async processFunctionCalls() {
      return { ok: true, value: undefined };
    },
    createTerminalFailure(failure) {
      return { ok: false, text: failure.message };
    },
    settleTerminal() {},
    ...overrides,
  };
}

void test('requires an absolute filesystem root', () => {
  assert.throws(
    () => createXHarnessFileRunStore('relative-store'),
    /root must be an absolute path/,
  );
});

void test('binds one content-addressed evidence reference while retaining schema-v1 admissions', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'geulbat-xharness-store-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const evidenceReferenceId = `sha256:${'a'.repeat(64)}`;
  const store = createXHarnessFileRunStore(root);
  await store.admitRun(
    'evidence-bound-attempt',
    createAdmissionInput('attempt-evidence', evidenceReferenceId),
  );
  const stored = await store.readAdmission('evidence-bound-attempt');
  assert.ok(stored);
  assert.equal(stored.schemaVersion, 2);
  assert.equal(stored.evidenceReferenceId, evidenceReferenceId);

  await assert.rejects(
    store.admitRun(
      'invalid-evidence-attempt',
      createAdmissionInput('attempt-invalid-evidence', 'not-a-reference'),
    ),
    /must be a sha256 content reference/,
  );

  const legacyAttemptKey = 'legacy-admission-attempt';
  const legacyAttemptKeyHash = sha256StableJson({
    schemaVersion: 1,
    attemptKey: legacyAttemptKey,
  });
  const legacyInput = createAdmissionInput('attempt-legacy');
  const legacyPayload = {
    schemaVersion: 1 as const,
    attemptKeyHash: legacyAttemptKeyHash,
    harnessSnapshot: legacyInput.harnessSnapshot,
    traceIdentity: legacyInput.traceIdentity,
    loopImplementation: {
      implementationId: legacyInput.implementation.implementationId,
      contractVersion: legacyInput.implementation.contractVersion,
    },
  };
  await mkdir(join(root, 'attempts', legacyAttemptKeyHash), {
    recursive: true,
  });
  await writeFile(
    join(root, 'attempts', legacyAttemptKeyHash, 'admission.json'),
    `${stableStringify({
      ...legacyPayload,
      admissionDigest: sha256StableJson(legacyPayload),
    })}\n`,
    'utf8',
  );

  const legacy =
    await createXHarnessFileRunStore(root).readAdmission(legacyAttemptKey);
  assert.ok(legacy);
  assert.equal(legacy.schemaVersion, 1);
  assert.equal(legacy.evidenceReferenceId, null);
});

void test('journals a real kernel attempt through terminal publication and restart', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'geulbat-xharness-store-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const attemptKey = 'real-kernel-attempt';
  const store = createXHarnessFileRunStore(root);
  const admission = await store.admitRun(attemptKey, createAdmissionInput());
  const observedEvents: AgentLoopKernelEvent[] = [];

  const result = await admission.implementation.run({
    ports: createSingleRoundPorts({
      observe(event) {
        observedEvents.push(event);
      },
    }),
  });

  assert.deepEqual(result, { ok: true, text: 'done' });
  const storedAdmission = await store.readAdmission(attemptKey);
  assert.ok(storedAdmission);
  assert.equal(
    storedAdmission.harnessSnapshot.harnessSnapshotId,
    admission.harnessSnapshot.harnessSnapshotId,
  );
  assert.deepEqual(await store.readJournal(attemptKey), observedEvents);

  const restartedStore = createXHarnessFileRunStore(root);
  assert.deepEqual(await restartedStore.listAttemptAdmissions(), [
    storedAdmission,
  ]);
  const reopenedAttempt = await restartedStore.readAttemptByReference(
    storedAdmission.attemptKeyHash,
  );
  assert.ok(reopenedAttempt);
  assert.equal(reopenedAttempt.state, 'terminal');
  assert.deepEqual(reopenedAttempt.events, observedEvents);
  const storedTrace = await restartedStore.readTrace(attemptKey);
  assert.deepEqual(reopenedAttempt.trace, storedTrace);
  assert.deepEqual(storedTrace?.trace.events, observedEvents);
  assert.deepEqual(storedTrace?.trace.outcome, {
    ok: true,
    terminalSource: 'natural',
  });
  assert.equal(storedTrace?.trace.taskId, 'task-1');
  assert.equal(storedTrace?.trace.attemptId, 'attempt-1');
});

void test('claims one execution before model work and does not consume the claim when a caller checkpoint is present', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'geulbat-xharness-store-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = createXHarnessFileRunStore(root);
  let modelCallCount = 0;
  const ports = createSingleRoundPorts({
    async runModelRound() {
      modelCallCount += 1;
      return {
        ok: true,
        value: {
          assistantText: 'done',
          terminalResult: { ok: true, text: 'done' },
          functionCalls: [],
        },
      };
    },
  });
  const first = await store.admitRun(
    'single-owner-attempt',
    createAdmissionInput(),
  );
  await first.implementation.run({ ports });
  const restartedAdmission = await createXHarnessFileRunStore(root).admitRun(
    'single-owner-attempt',
    createAdmissionInput(),
  );
  await assert.rejects(
    restartedAdmission.implementation.run({ ports }),
    /execution is already claimed/,
  );
  assert.equal(modelCallCount, 1);

  const callerOwnedCheckpoint = await store.admitRun(
    'caller-checkpoint-attempt',
    createAdmissionInput('attempt-2'),
  );
  await assert.rejects(
    callerOwnedCheckpoint.implementation.run({
      ports: createSingleRoundPorts({
        async checkpointEvent() {},
        async runModelRound() {
          modelCallCount += 1;
          return {
            ok: true,
            value: {
              assistantText: 'unexpected',
              terminalResult: { ok: true, text: 'unexpected' },
              functionCalls: [],
            },
          };
        },
      }),
    }),
    /cannot replace an existing checkpointEvent/,
  );
  await callerOwnedCheckpoint.implementation.run({ ports });
  assert.equal(modelCallCount, 2);
});

void test('preserves an interrupted journal prefix without inventing a terminal trace', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'geulbat-xharness-store-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const attemptKey = 'interrupted-attempt';
  const store = createXHarnessFileRunStore(root);
  const admission = await store.admitRun(attemptKey, createAdmissionInput());
  const [storedAdmission] = await store.listAttemptAdmissions();
  assert.ok(storedAdmission);
  const admittedAttempt = await store.readAttemptByReference(
    storedAdmission.attemptKeyHash,
  );
  assert.ok(admittedAttempt);
  assert.equal(admittedAttempt.state, 'admitted');
  assert.deepEqual(admittedAttempt.events, []);
  assert.equal(admittedAttempt.trace, undefined);

  await assert.rejects(
    admission.implementation.run({
      ports: createSingleRoundPorts({
        async runModelRound() {
          throw new Error('provider disconnected');
        },
      }),
    }),
    /provider disconnected/,
  );

  const restartedStore = createXHarnessFileRunStore(root);
  const interruptedAttempt = await restartedStore.readAttemptByReference(
    storedAdmission.attemptKeyHash,
  );
  assert.ok(interruptedAttempt);
  assert.equal(interruptedAttempt.state, 'execution_claimed');
  assert.equal(interruptedAttempt.trace, undefined);
  assert.deepEqual(await restartedStore.readJournal(attemptKey), [
    {
      kind: 'round_started',
      round: 0,
      historyItemCount: 0,
      sawFirstModelRequest: false,
    },
    { kind: 'model_call_started', round: 0 },
  ]);
  assert.equal(await restartedStore.readTrace(attemptKey), undefined);
  await assert.rejects(
    admission.implementation.run({ ports: createSingleRoundPorts() }),
    /execution is already claimed/,
  );
});

void test('fails closed when a persisted journal event is modified', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'geulbat-xharness-store-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const attemptKey = 'corrupted-attempt';
  const store = createXHarnessFileRunStore(root);
  const admission = await store.admitRun(attemptKey, createAdmissionInput());
  await admission.implementation.run({ ports: createSingleRoundPorts() });
  const storedAdmission = await store.readAdmission(attemptKey);
  assert.ok(storedAdmission);
  const firstEventPath = join(
    root,
    'attempts',
    storedAdmission.attemptKeyHash,
    'events',
    '0.json',
  );
  const firstEvent = JSON.parse(await readFile(firstEventPath, 'utf8')) as {
    event: { round: number };
  };
  firstEvent.event.round = 9;
  await writeFile(firstEventPath, JSON.stringify(firstEvent), 'utf8');

  await assert.rejects(
    createXHarnessFileRunStore(root).readJournal(attemptKey),
    /journal digest does not match its body/,
  );
  await assert.rejects(
    createXHarnessFileRunStore(root).readAttemptByReference(
      storedAdmission.attemptKeyHash,
    ),
    /journal digest does not match its body/,
  );
});

void test('keeps unpublished pending directories out of discovery and rejects malformed entries', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'geulbat-xharness-store-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = createXHarnessFileRunStore(root);
  const unpublishedReference = '0'.repeat(64);
  await mkdir(join(root, 'attempts', unpublishedReference, '.pending'), {
    recursive: true,
  });

  assert.deepEqual(await store.listAttemptAdmissions(), []);
  assert.equal(
    await store.readAttemptByReference(unpublishedReference),
    undefined,
  );
  await assert.rejects(
    store.readAttemptByReference('not-a-digest'),
    /must be a sha256 hex digest/,
  );

  await writeFile(
    join(root, 'attempts', 'unexpected-entry'),
    'invalid',
    'utf8',
  );
  await assert.rejects(
    store.listAttemptAdmissions(),
    /attempts root contains a non-directory entry/,
  );
});
