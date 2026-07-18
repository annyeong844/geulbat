import test from 'node:test';
import assert from 'node:assert/strict';
import { isValidElement } from 'react';

import type { ResolvedArtifactSourceRef } from '../../artifacts/artifact-types.js';
import type { ArtifactRuntimeFrameRenderArgs } from '../../artifacts/runtime-preview/types.js';
import { ArtifactRuntimeFrame } from '../runtime-frame/artifact-runtime-frame.js';
import { renderArtifactRuntimeFrame } from './index.js';

function createResolvedSourceRef(
  overrides: Partial<ResolvedArtifactSourceRef> = {},
): ResolvedArtifactSourceRef {
  return {
    kind: null,
    workingDirectory: '',
    threadId: null,
    runId: null,
    filePath: null,
    messageTimestamp: null,
    artifactId: null,
    artifactVersion: null,
    persistenceEpoch: null,
    ...overrides,
  };
}

void test('renderArtifactRuntimeFrame injects the concrete assistant runtime frame for committed artifact panes', () => {
  const sourceRef = createResolvedSourceRef();
  const node = renderArtifactRuntimeFrame({
    renderer: 'html5',
    title: 'Preview',
    sandbox: 'allow-scripts allow-forms allow-same-origin',
    runtimePayload: '<!doctype html><p>hello</p>',
    sourceRef,
  });

  assert.equal(isValidElement<ArtifactRuntimeFrameRenderArgs>(node), true);
  if (!isValidElement<ArtifactRuntimeFrameRenderArgs>(node)) {
    assert.fail('expected a React element');
  }
  assert.equal(node.type, ArtifactRuntimeFrame);
  assert.equal(node.props.renderer, 'html5');
  assert.equal(node.props.title, 'Preview');
  assert.equal(
    node.props.sandbox,
    'allow-scripts allow-forms allow-same-origin',
  );
  assert.equal(node.props.runtimePayload, '<!doctype html><p>hello</p>');
  assert.equal(node.props.sourceRef, sourceRef);
});
