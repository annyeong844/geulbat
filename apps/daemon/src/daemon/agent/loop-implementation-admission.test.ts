import assert from 'node:assert/strict';
import test from 'node:test';

import {
  agentLoopKernelImplementation,
  type AgentLoopImplementation,
  type AgentLoopImplementationIdentity,
} from '@geulbat/agent-loop/kernel';
import { createToolCapabilityPolicy } from '@geulbat/tool-library/tool-capability-policy';

import {
  createAgentLoopImplementationAdmission,
  type AgentLoopImplementationAdmissionInput,
} from './loop-implementation-admission.js';

function testImplementation(
  implementationId: string,
  contractVersion = agentLoopKernelImplementation.contractVersion,
): AgentLoopImplementation {
  return {
    ...agentLoopKernelImplementation,
    implementationId,
    contractVersion,
  };
}

function admissionInput(
  requiredIdentity?: AgentLoopImplementationIdentity,
): AgentLoopImplementationAdmissionInput {
  return {
    runId: 'run-1',
    threadId: 'thread-1',
    stateRoot: '/state',
    modelConfiguration: {
      providerId: 'test-provider',
      model: 'test-model',
    },
    ...(requiredIdentity === undefined ? {} : { requiredIdentity }),
  };
}

void test('pins one implementation per admission while later admissions follow selection changes', async () => {
  const baseline = testImplementation('test.baseline');
  const candidate = testImplementation('test.candidate');
  let selectedImplementationId = baseline.implementationId;
  const admission = createAgentLoopImplementationAdmission({
    additionalImplementations: [baseline, candidate],
    selectImplementationId: () => selectedImplementationId,
  });

  const admittedBaseline = await admission.admitRun(admissionInput());
  assert.equal(admittedBaseline.ok, true);
  if (!admittedBaseline.ok) {
    return;
  }

  selectedImplementationId = candidate.implementationId;
  const admittedCandidate = await admission.admitRun(admissionInput());
  assert.equal(admittedCandidate.ok, true);
  if (!admittedCandidate.ok) {
    return;
  }

  assert.equal(admittedBaseline.implementation, baseline);
  assert.deepEqual(admittedBaseline.identity, {
    implementationId: baseline.implementationId,
    contractVersion: baseline.contractVersion,
  });
  assert.equal(admittedCandidate.implementation, candidate);

  selectedImplementationId = baseline.implementationId;
  const rolledBack = await admission.admitRun(admissionInput());
  assert.equal(rolledBack.ok && rolledBack.implementation === baseline, true);
});

void test('neutral admission does not promote a candidate tool policy', async () => {
  const admitted = await createAgentLoopImplementationAdmission().admitRun({
    ...admissionInput(),
    toolCapabilityPolicy: createToolCapabilityPolicy({
      directRegistryNames: ['list_files'],
      allowedRegistryNames: ['list_files', 'read_file'],
      callbackRegistryNames: ['read_file'],
      writeCallbackEnabled: false,
    }),
  });

  assert.equal(admitted.ok, true);
  if (admitted.ok) {
    assert.equal(admitted.toolCapabilityPolicy, undefined);
  }
});

void test('fails closed for unavailable and incompatible implementations', async () => {
  let selectedImplementationId = 'test.missing';
  const incompatible = testImplementation('test.incompatible', '2');
  const admission = createAgentLoopImplementationAdmission({
    additionalImplementations: [incompatible],
    selectImplementationId: () => selectedImplementationId,
  });

  assert.deepEqual(await admission.admitRun(admissionInput()), {
    ok: false,
    reason: 'implementation_unavailable',
    implementationId: 'test.missing',
    supportedContractVersion: '1',
    message: 'agent loop implementation is unavailable: test.missing',
  });

  selectedImplementationId = incompatible.implementationId;
  assert.deepEqual(await admission.admitRun(admissionInput()), {
    ok: false,
    reason: 'contract_incompatible',
    implementationId: incompatible.implementationId,
    contractVersion: '2',
    supportedContractVersion: '1',
    message:
      'agent loop implementation contract is incompatible: test.incompatible@2; registered 2, host requires 1',
  });

  assert.deepEqual(
    await admission.admitRun(
      admissionInput({
        implementationId: agentLoopKernelImplementation.implementationId,
        contractVersion: '0',
      }),
    ),
    {
      ok: false,
      reason: 'contract_incompatible',
      implementationId: agentLoopKernelImplementation.implementationId,
      contractVersion: '0',
      supportedContractVersion: '1',
      message:
        'agent loop implementation contract is incompatible: geulbat.agent-loop.kernel@0; registered 1, host requires 1',
    },
  );
});
