import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { sha256StableJson } from '@geulbat/content-identity/stable-json';
import type { AgentLoopImplementationAdmissionResult } from '@geulbat/daemon/loop-implementation-admission';
import { AGENT_LOOP_PROMPT_COMPONENT_IDENTITY } from '@geulbat/daemon/prompt-component-identity';
import { createToolCapabilityPolicy } from '@geulbat/tool-library/tool-capability-policy';

import {
  createProductXHarnessAdmission,
  createProductXHarnessAttemptEvidenceReader,
  createProductXHarnessAttemptReader,
} from './product-xharness-admission.js';

type AdmittedImplementation = Extract<
  AgentLoopImplementationAdmissionResult,
  { ok: true }
>['implementation'];
type TestResult = { ok: true; text: string } | { ok: false; text: string };

async function runAdmittedImplementation(
  implementation: AdmittedImplementation,
): Promise<TestResult> {
  return await implementation.run<TestResult, never, never, never>({
    ports: {
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
    },
  });
}

void test('records distinct attempts that resolve one immutable run-evidence reference', async (t) => {
  const stateRoot = await mkdtemp(join(tmpdir(), 'geulbat-product-xharness-'));
  t.after(() => rm(stateRoot, { recursive: true, force: true }));
  const admission = createProductXHarnessAdmission();
  const toolCapabilityPolicy = createToolCapabilityPolicy({
    directRegistryNames: ['list_files'],
    allowedRegistryNames: ['list_files', 'read_file'],
    callbackRegistryNames: ['read_file'],
    writeCallbackEnabled: false,
  });
  const input = {
    runId: 'run-live-1',
    threadId: '00000000-0000-4000-8000-000000000111',
    stateRoot,
    modelConfiguration: {
      providerId: 'openai_codex',
      model: 'gpt-5.6-luna',
      reasoningEffort: 'medium',
      serviceTier: 'standard',
    },
    toolCapabilityPolicy,
  };

  const foreground = await admission.admitRun(input);
  assert.equal(foreground.ok, true);
  if (!foreground.ok) {
    return;
  }
  assert.deepEqual(foreground.toolCapabilityPolicy, toolCapabilityPolicy);
  assert.deepEqual(await runAdmittedImplementation(foreground.implementation), {
    ok: true,
    text: 'done',
  });

  const recovered = await admission.admitRun({
    ...input,
    requiredIdentity: foreground.identity,
  });
  assert.equal(recovered.ok, true);
  if (!recovered.ok) {
    return;
  }
  await runAdmittedImplementation(recovered.implementation);

  const restartedReader = createProductXHarnessAttemptReader(stateRoot);
  assert.equal('admitRun' in restartedReader, false);
  const storedAdmissions = await restartedReader.listAttemptAdmissions();
  assert.equal(storedAdmissions.length, 2);
  const attemptReferences = storedAdmissions.map(
    (storedAdmission) => storedAdmission.attemptKeyHash,
  );
  assert.deepEqual(attemptReferences, [...attemptReferences].sort());

  const reopenedAttempts = await Promise.all(
    storedAdmissions.map(async (storedAdmission) => {
      const reopenedAttempt = await restartedReader.readAttemptByReference(
        storedAdmission.attemptKeyHash,
      );
      assert.ok(reopenedAttempt);
      assert.equal(reopenedAttempt.state, 'terminal');
      assert.deepEqual(reopenedAttempt.admission, storedAdmission);
      assert.ok(reopenedAttempt.trace);
      return reopenedAttempt;
    }),
  );
  const traces = reopenedAttempts.map((attempt) => {
    assert.ok(attempt.trace);
    return attempt.trace.trace;
  });
  const admissions = reopenedAttempts.map(
    (attempt) => attempt.admission.harnessSnapshot,
  );
  const evidenceReferenceIds = reopenedAttempts.map(
    (attempt) => attempt.admission.evidenceReferenceId,
  );
  const persistedSources: string[] = [];
  for (const storedAdmission of storedAdmissions) {
    const attemptRoot = join(
      stateRoot,
      '.geulbat',
      'xharness',
      'attempts',
      storedAdmission.attemptKeyHash,
    );
    const admissionSource = await readFile(
      join(attemptRoot, 'admission.json'),
      'utf8',
    );
    const traceSource = await readFile(join(attemptRoot, 'trace.json'), 'utf8');
    persistedSources.push(admissionSource, traceSource);
  }

  assert.equal(new Set(traces.map((trace) => trace.attemptId)).size, 2);
  assert.equal(
    traces.every((trace) => trace.attemptId.startsWith('run-live-1:')),
    true,
  );
  assert.equal(
    traces.every(
      (trace) => trace.taskId === '00000000-0000-4000-8000-000000000111',
    ),
    true,
  );
  assert.equal(new Set(traces.map((trace) => trace.modelConfigId)).size, 1);
  assert.equal(
    traces.every(
      (trace) =>
        trace.loopImplementation.implementationId ===
          foreground.identity.implementationId &&
        trace.loopImplementation.contractVersion ===
          foreground.identity.contractVersion,
    ),
    true,
  );
  assert.equal(
    admissions.every((snapshot) => snapshot.harnessId === 'geulbat.live-run'),
    true,
  );
  for (const admissionSnapshot of admissions) {
    assert.equal(admissionSnapshot.harnessVersion, '3');
    assert.deepEqual(
      admissionSnapshot.config.prompt,
      AGENT_LOOP_PROMPT_COMPONENT_IDENTITY,
    );
    assert.deepEqual(admissionSnapshot.config.tools, {
      componentId: 'geulbat.daemon.tool-ports',
      componentVersion: '2',
      toolCapabilityPolicy,
    });
    assert.deepEqual(admissionSnapshot.config.trace, {
      componentId: 'geulbat.agent-loop.portable-events',
      componentVersion: '2',
    });
  }
  assert.equal(new Set(evidenceReferenceIds).size, 1);
  const evidenceReferenceId = evidenceReferenceIds[0];
  assert.ok(evidenceReferenceId);
  const evidenceLocatorSource = await readFile(
    join(
      stateRoot,
      '.geulbat',
      'xharness-evidence',
      `${evidenceReferenceId.slice('sha256:'.length)}.json`,
    ),
    'utf8',
  );
  persistedSources.push(evidenceLocatorSource);
  assert.equal(evidenceLocatorSource.includes(input.threadId), true);
  assert.equal(evidenceLocatorSource.includes(input.runId), true);
  const evidenceEvents = [
    {
      seq: 0,
      event: {
        type: 'tool_call' as const,
        payload: {
          callId: 'call-search-1',
          step: 0,
          tool: 'search_files',
          args: {
            pattern: '*.ts',
            type: 'filename',
            consistency: 'eventual_index',
            maxResults: 20,
          },
        },
      },
    },
  ];
  const attemptEvidenceReader = createProductXHarnessAttemptEvidenceReader(
    stateRoot,
    {
      runEvidenceReader: {
        async readRun(args) {
          assert.deepEqual(args, {
            threadId: '00000000-0000-4000-8000-000000000111',
            runId: 'run-live-1',
          });
          return {
            schemaVersion: 1,
            threadId: '00000000-0000-4000-8000-000000000111',
            runId: 'run-live-1',
            evidenceDigest: `sha256:${'c'.repeat(64)}`,
            events: evidenceEvents,
          };
        },
      },
    },
  );
  assert.deepEqual(
    await attemptEvidenceReader.readAttemptEvidence(attemptReferences[0]!),
    {
      attemptReference: attemptReferences[0],
      taskReferenceId: `sha256:${sha256StableJson({
        schemaVersion: 1,
        taskId: '00000000-0000-4000-8000-000000000111',
      })}`,
      evidenceReferenceId,
      evidenceDigest: `sha256:${'c'.repeat(64)}`,
      appliedShippingReceiptDigest: null,
      harnessSnapshot: storedAdmissions[0]!.harnessSnapshot,
      portableTrace: traces[0],
      events: evidenceEvents,
    },
  );
  const listedEvidence = await attemptEvidenceReader.listAttemptEvidence({
    harnessSnapshotIds: [
      storedAdmissions[0]!.harnessSnapshot.harnessSnapshotId,
    ],
  });
  assert.deepEqual(
    listedEvidence.map((entry) => entry.attemptReference),
    attemptReferences,
  );
  assert.deepEqual(
    listedEvidence.map((entry) => entry.harnessSnapshot),
    storedAdmissions.map((entry) => entry.harnessSnapshot),
  );
  await assert.rejects(
    createProductXHarnessAttemptEvidenceReader(stateRoot).readAttemptEvidence(
      attemptReferences[0]!,
    ),
    /referenced product run evidence is unavailable/,
  );
  assert.equal(persistedSources.join('\n').includes(stateRoot), false);
  assert.equal(persistedSources.join('\n').includes('openai_codex'), false);
  assert.equal(persistedSources.join('\n').includes('gpt-5.6-luna'), false);
});

void test('applies a shipped policy only to new admissions and preserves the checkpointed recovery policy', async (t) => {
  const stateRoot = await mkdtemp(join(tmpdir(), 'geulbat-product-xharness-'));
  t.after(() => rm(stateRoot, { recursive: true, force: true }));
  const baselineToolCapabilityPolicy = createToolCapabilityPolicy({
    directRegistryNames: ['read_file'],
    allowedRegistryNames: ['read_file'],
    callbackRegistryNames: ['read_file'],
    writeCallbackEnabled: false,
  });
  const shippedToolCapabilityPolicy = createToolCapabilityPolicy({
    directRegistryNames: ['read_file', 'search_files'],
    allowedRegistryNames: ['read_file', 'search_files'],
    callbackRegistryNames: ['read_file', 'search_files'],
    writeCallbackEnabled: false,
  });
  let resolutionCount = 0;
  const admission = createProductXHarnessAdmission({
    async resolveToolCapabilityPolicyAdmission(input) {
      resolutionCount += 1;
      assert.equal(input.stateRoot, stateRoot);
      assert.deepEqual(
        input.requestedToolCapabilityPolicy,
        baselineToolCapabilityPolicy,
      );
      return {
        toolCapabilityPolicy: shippedToolCapabilityPolicy,
        appliedShippingReceiptDigest: `sha256:${'f'.repeat(64)}`,
      };
    },
  });
  const input = {
    runId: 'run-shipped-policy',
    threadId: '00000000-0000-4000-8000-000000000222',
    stateRoot,
    modelConfiguration: {
      providerId: 'openai_codex',
      model: 'gpt-5.6-luna',
    },
    toolCapabilityPolicy: baselineToolCapabilityPolicy,
  };

  const foreground = await admission.admitRun(input);
  assert.equal(foreground.ok, true);
  if (!foreground.ok) {
    return;
  }
  assert.deepEqual(
    foreground.toolCapabilityPolicy,
    shippedToolCapabilityPolicy,
  );
  assert.equal(resolutionCount, 1);

  const recovered = await admission.admitRun({
    ...input,
    toolCapabilityPolicy: shippedToolCapabilityPolicy,
    requiredIdentity: foreground.identity,
  });
  assert.equal(recovered.ok, true);
  if (!recovered.ok) {
    return;
  }
  assert.deepEqual(recovered.toolCapabilityPolicy, shippedToolCapabilityPolicy);
  assert.equal(resolutionCount, 1);
  const locatorValues = await Promise.all(
    (
      await createProductXHarnessAttemptReader(
        stateRoot,
      ).listAttemptAdmissions()
    ).map(async (storedAdmission) => {
      assert.ok(storedAdmission.evidenceReferenceId);
      const value: unknown = JSON.parse(
        await readFile(
          join(
            stateRoot,
            '.geulbat',
            'xharness-evidence',
            `${storedAdmission.evidenceReferenceId.slice('sha256:'.length)}.json`,
          ),
          'utf8',
        ),
      );
      if (typeof value !== 'object' || value === null) {
        throw new Error('expected persisted xHarness evidence locator object');
      }
      return Reflect.get(value, 'appliedShippingReceiptDigest');
    }),
  );
  assert.deepEqual(
    locatorValues.sort((left, right) =>
      String(left).localeCompare(String(right)),
    ),
    [null, `sha256:${'f'.repeat(64)}`].sort((left, right) =>
      String(left).localeCompare(String(right)),
    ),
  );
});

void test('fails closed with a diagnostic before publishing when shipped policy state is invalid', async (t) => {
  const stateRoot = await mkdtemp(join(tmpdir(), 'geulbat-product-xharness-'));
  t.after(() => rm(stateRoot, { recursive: true, force: true }));
  const result = await createProductXHarnessAdmission({
    async resolveToolCapabilityPolicyAdmission() {
      throw new Error('shipping receipt chain is discontinuous');
    },
  }).admitRun({
    runId: 'run-invalid-shipping-state',
    threadId: 'thread-invalid-shipping-state',
    stateRoot,
    modelConfiguration: {
      providerId: 'openai_codex',
      model: 'gpt-5.6-luna',
    },
    toolCapabilityPolicy: createToolCapabilityPolicy({
      directRegistryNames: ['read_file'],
      allowedRegistryNames: ['read_file'],
      callbackRegistryNames: ['read_file'],
      writeCallbackEnabled: false,
    }),
  });

  assert.equal(result.ok, false);
  if (result.ok) {
    return;
  }
  assert.equal(result.reason, 'tool_capability_policy_unavailable');
  assert.match(result.message, /shipping receipt chain is discontinuous/u);
  assert.deepEqual(
    await createProductXHarnessAttemptReader(stateRoot).listAttemptAdmissions(),
    [],
  );
});

void test('fails closed before publishing an attempt when the product policy is absent', async (t) => {
  const stateRoot = await mkdtemp(join(tmpdir(), 'geulbat-product-xharness-'));
  t.after(() => rm(stateRoot, { recursive: true, force: true }));
  const result = await createProductXHarnessAdmission().admitRun({
    runId: 'run-without-policy',
    threadId: 'thread-without-policy',
    stateRoot,
    modelConfiguration: {
      providerId: 'openai_codex',
      model: 'gpt-5.6-luna',
    },
  });

  assert.equal(result.ok, false);
  if (result.ok) {
    return;
  }
  assert.equal(result.reason, 'tool_capability_policy_unavailable');
  assert.deepEqual(
    await createProductXHarnessAttemptReader(stateRoot).listAttemptAdmissions(),
    [],
  );
});
