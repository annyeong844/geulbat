import test from 'node:test';
import assert from 'node:assert/strict';

import {
  describeAgentResultForTextSurface,
  hasVisibleAgentOutput,
} from './agent-result.js';

void test('hasVisibleAgentOutput treats artifact-only results as visible output', () => {
  assert.equal(
    hasVisibleAgentOutput({
      ok: false,
      artifactCandidate: {
        renderer: 'markdown',
        payload: '# Chapter 1',
        digest: 'sha256:abc123',
      },
    }),
    true,
  );
});

void test('hasVisibleAgentOutput tolerates missing finalProse without crashing', () => {
  assert.equal(
    hasVisibleAgentOutput({
      ok: false,
    }),
    false,
  );
});

void test('describeAgentResultForTextSurface prefers artifact summary over raw transport', () => {
  assert.equal(
    describeAgentResultForTextSurface({
      finalProse: '',
      artifactCandidate: {
        renderer: 'markdown',
        payload: '# Chapter 1',
        digest: 'sha256:abc123',
      },
    }),
    '[artifact:markdown] sha256:abc123',
  );
});
