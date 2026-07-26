import assert from 'node:assert/strict';
import test from 'node:test';

import { assertRunId, assertThreadId } from '@geulbat/protocol/ids';
import type { CallModelInput, LLMChunk } from '../llm/provider/client.js';
import {
  aggregateGoalVerificationVotes,
  verifyGoalCompletion,
} from './goal-completion-verifier.js';

void test('Goal completion verification starts all three independent provider calls before collecting quorum', async () => {
  const outputs = [
    '{"verdict":"achieved"}',
    '{"verdict":"not_achieved","unmetRequirements":["missing check"]}',
    '{"verdict":"achieved"}',
  ];
  let startedCalls = 0;
  let releasePanel!: () => void;
  const panelReady = new Promise<void>((resolve) => {
    releasePanel = resolve;
  });

  async function* callModelImpl(
    _input: CallModelInput,
  ): AsyncGenerator<LLMChunk> {
    const index = startedCalls;
    startedCalls += 1;
    if (startedCalls === 3) {
      releasePanel();
    }
    await panelReady;
    yield {
      type: 'done',
      finalText: outputs[index] ?? '',
    };
  }

  const result = await verifyGoalCompletion({
    goal: {
      goalId: 'goal-panel',
      threadId: assertThreadId('123e4567-e89b-42d3-a456-426614174081'),
      objective: 'Verify with a three-member panel',
      state: 'verifying',
      createdAt: '2026-07-26T00:00:00.000Z',
      updatedAt: '2026-07-26T00:01:00.000Z',
    },
    history: [{ kind: 'user', text: 'Evidence is in the history.' }],
    runId: assertRunId('run-goal-panel'),
    providerAuthRuntime: {} as CallModelInput['providerAuthRuntime'],
    providerWebSocketSessions:
      {} as CallModelInput['providerWebSocketSessions'],
    providerRequestOptions: {} as CallModelInput['providerRequestOptions'],
    callModelImpl,
  });

  assert.equal(startedCalls, 3);
  assert.deepEqual(result.outcome, { kind: 'achieved' });
  assert.equal(result.votes.length, 3);
});

void test('Goal completion quorum continues on two matching failures and fails closed without two matching votes', () => {
  assert.deepEqual(
    aggregateGoalVerificationVotes([
      {
        verdict: 'not_achieved',
        unmetRequirements: ['Run tests'],
      },
      {
        verdict: 'not_achieved',
        unmetRequirements: ['Run tests', 'Update docs'],
      },
      { verdict: 'achieved' },
    ]).outcome,
    {
      kind: 'incomplete',
      unmetRequirements: ['Run tests', 'Update docs'],
    },
  );

  assert.equal(
    aggregateGoalVerificationVotes([
      { verdict: 'achieved' },
      {
        verdict: 'not_achieved',
        unmetRequirements: ['Run tests'],
      },
      { verdict: 'unavailable', reason: 'provider_error' },
    ]).outcome.kind,
    'unavailable',
  );
});
