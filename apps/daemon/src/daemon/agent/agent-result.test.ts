import test from 'node:test';
import assert from 'node:assert/strict';

import {
  composeAgentResult,
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

void test('composeAgentResult keeps artifact-only results prose-empty', () => {
  const artifactCandidate = {
    renderer: 'react_bundle' as const,
    payload: '{"entryUrl":"https://fixtures.geulbat.local/app.js"}',
    digest: 'sha256:fixture',
  };

  const result = composeAgentResult({
    ok: true,
    finalProse: 'this prose must not be persisted beside the artifact',
    artifactCandidate,
  });

  assert.equal(result.ok, true);
  assert.equal(result.finalProse, '');
  assert.equal(result.artifactCandidate, artifactCandidate);
});
