import assert from 'node:assert/strict';
import test from 'node:test';

import {
  AGENT_NO_PROGRESS_ACTION_ENV,
  AGENT_NO_PROGRESS_REPEAT_THRESHOLD_ENV,
  resolveAgentNoProgressPolicyFromEnv,
  shouldStopForNoProgress,
} from './no-progress-policy.js';

void test('an unset no-progress policy leaves the completion policy observation-only', () => {
  assert.equal(resolveAgentNoProgressPolicyFromEnv({}), undefined);
  assert.equal(
    shouldStopForNoProgress({
      policy: undefined,
      repeatCount: 99,
      sameGapAndEvidenceAsPrevious: true,
    }),
    false,
  );
});

void test('a configured stop policy is resolved from both operator values', () => {
  const policy = resolveAgentNoProgressPolicyFromEnv({
    [AGENT_NO_PROGRESS_REPEAT_THRESHOLD_ENV]: '3',
    [AGENT_NO_PROGRESS_ACTION_ENV]: 'stop',
  });

  assert.deepEqual(policy, { repeatThreshold: 3, action: 'stop' });
});

void test('a partially configured policy fails instead of inventing the missing half', () => {
  assert.throws(
    () =>
      resolveAgentNoProgressPolicyFromEnv({
        [AGENT_NO_PROGRESS_REPEAT_THRESHOLD_ENV]: '3',
      }),
    new RegExp(`${AGENT_NO_PROGRESS_ACTION_ENV} is required`, 'u'),
  );
  assert.throws(
    () =>
      resolveAgentNoProgressPolicyFromEnv({
        [AGENT_NO_PROGRESS_ACTION_ENV]: 'stop',
      }),
    new RegExp(`${AGENT_NO_PROGRESS_REPEAT_THRESHOLD_ENV} is required`, 'u'),
  );
});

void test('a threshold of one is rejected because a first observation is not a repeat', () => {
  assert.throws(
    () =>
      resolveAgentNoProgressPolicyFromEnv({
        [AGENT_NO_PROGRESS_REPEAT_THRESHOLD_ENV]: '1',
        [AGENT_NO_PROGRESS_ACTION_ENV]: 'stop',
      }),
    /must be 2 or greater/u,
  );
});

void test('a non-integer threshold or unknown action is rejected', () => {
  assert.throws(
    () =>
      resolveAgentNoProgressPolicyFromEnv({
        [AGENT_NO_PROGRESS_REPEAT_THRESHOLD_ENV]: '2.5',
        [AGENT_NO_PROGRESS_ACTION_ENV]: 'stop',
      }),
    new RegExp(`invalid ${AGENT_NO_PROGRESS_REPEAT_THRESHOLD_ENV}`, 'u'),
  );
  assert.throws(
    () =>
      resolveAgentNoProgressPolicyFromEnv({
        [AGENT_NO_PROGRESS_REPEAT_THRESHOLD_ENV]: '2',
        [AGENT_NO_PROGRESS_ACTION_ENV]: 'pause',
      }),
    new RegExp(`invalid ${AGENT_NO_PROGRESS_ACTION_ENV}`, 'u'),
  );
});

void test('an observe policy records repeats without stopping the run', () => {
  const policy = resolveAgentNoProgressPolicyFromEnv({
    [AGENT_NO_PROGRESS_REPEAT_THRESHOLD_ENV]: '2',
    [AGENT_NO_PROGRESS_ACTION_ENV]: 'observe',
  });

  assert.equal(
    shouldStopForNoProgress({
      policy,
      repeatCount: 5,
      sameGapAndEvidenceAsPrevious: true,
    }),
    false,
  );
});

void test('a stop policy fires only at the threshold and only when evidence is unchanged', () => {
  const policy = resolveAgentNoProgressPolicyFromEnv({
    [AGENT_NO_PROGRESS_REPEAT_THRESHOLD_ENV]: '3',
    [AGENT_NO_PROGRESS_ACTION_ENV]: 'stop',
  });

  assert.equal(
    shouldStopForNoProgress({
      policy,
      repeatCount: 2,
      sameGapAndEvidenceAsPrevious: true,
    }),
    false,
  );
  assert.equal(
    shouldStopForNoProgress({
      policy,
      repeatCount: 3,
      sameGapAndEvidenceAsPrevious: true,
    }),
    true,
  );
  // Evidence moved, so the count reached the threshold on a different gap state
  // and the run is still making progress.
  assert.equal(
    shouldStopForNoProgress({
      policy,
      repeatCount: 3,
      sameGapAndEvidenceAsPrevious: false,
    }),
    false,
  );
});
