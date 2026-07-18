import test from 'node:test';
import assert from 'node:assert/strict';
import {
  getArtifactBackchannelWindowCountForTests,
  resetArtifactBackchannelRateLimitForTests,
  tryConsumeArtifactBackchannelBudget,
} from './artifact-backchannel-rate-limit.js';

void test('prompt lane allows 3 per window per scopeHandle and then rejects', () => {
  resetArtifactBackchannelRateLimitForTests();
  const now = 1_000_000;

  assert.equal(
    tryConsumeArtifactBackchannelBudget('scope-a', 'prompt', now),
    true,
  );
  assert.equal(
    tryConsumeArtifactBackchannelBudget('scope-a', 'prompt', now),
    true,
  );
  assert.equal(
    tryConsumeArtifactBackchannelBudget('scope-a', 'prompt', now),
    true,
  );
  assert.equal(
    tryConsumeArtifactBackchannelBudget('scope-a', 'prompt', now),
    false,
  );
  // 다른 프레임(scopeHandle)의 예산은 독립이다
  assert.equal(
    tryConsumeArtifactBackchannelBudget('scope-b', 'prompt', now),
    true,
  );
});

void test('tool lane has its own larger budget, independent from the prompt lane', () => {
  resetArtifactBackchannelRateLimitForTests();
  const now = 1_000_000;

  for (let index = 0; index < 3; index += 1) {
    tryConsumeArtifactBackchannelBudget('scope-a', 'prompt', now);
  }
  // prompt 레인이 고갈돼도 tool 레인은 소모되지 않았다
  for (let index = 0; index < 10; index += 1) {
    assert.equal(
      tryConsumeArtifactBackchannelBudget('scope-a', 'tool', now),
      true,
      `tool consume #${index + 1}`,
    );
  }
  assert.equal(
    tryConsumeArtifactBackchannelBudget('scope-a', 'tool', now),
    false,
  );
});

void test('budget refills after the window elapses', () => {
  resetArtifactBackchannelRateLimitForTests();
  const now = 1_000_000;

  for (let index = 0; index < 3; index += 1) {
    tryConsumeArtifactBackchannelBudget('scope-a', 'prompt', now);
  }
  assert.equal(
    tryConsumeArtifactBackchannelBudget('scope-a', 'prompt', now + 9_999),
    false,
  );
  assert.equal(
    tryConsumeArtifactBackchannelBudget('scope-a', 'prompt', now + 10_000),
    true,
  );
});

void test('expired windows are pruned on the next consume', () => {
  resetArtifactBackchannelRateLimitForTests();
  const now = 1_000_000;

  tryConsumeArtifactBackchannelBudget('scope-a', 'prompt', now);
  tryConsumeArtifactBackchannelBudget('scope-b', 'tool', now);
  assert.equal(getArtifactBackchannelWindowCountForTests(), 2);

  tryConsumeArtifactBackchannelBudget('scope-c', 'prompt', now + 60_000);
  assert.equal(getArtifactBackchannelWindowCountForTests(), 1);
});
