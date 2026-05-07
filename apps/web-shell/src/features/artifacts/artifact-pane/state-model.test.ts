import test from 'node:test';
import assert from 'node:assert/strict';

import { createArtifactPaneViewModel } from '../../../test-support/create-artifact-pane-view-model.js';
import { buildArtifactPaneStateModel } from './state-model.js';

void test('buildArtifactPaneStateModel defaults completed previews to the show tab', () => {
  const model = buildArtifactPaneStateModel({
    viewModel: createArtifactPaneViewModel(),
    isRunning: false,
    hasStartArtifactRunHandler: true,
  });

  assert.equal(model.defaultTab, 'show');
  assert.equal(model.canShowPreview, true);
  assert.equal(model.supportsStreamingPreview, false);
  assert.equal(model.showOpenSource, true);
  assert.equal(model.showApply, true);
  assert.equal(model.canApply, true);
  assert.equal(model.surfaceStateBadge, null);
  assert.equal(
    model.applyDraft?.displayPrompt,
    'Apply artifact to notes/demo.md',
  );
});

void test('buildArtifactPaneStateModel exposes streaming previews when renderer support is known', () => {
  const model = buildArtifactPaneStateModel({
    viewModel: createArtifactPaneViewModel({
      parsed: {
        kind: 'artifact',
        state: 'streaming',
        renderer: 'html5',
        digest: 'fixture',
        payload: '<main>loading</main>',
        raw: '<main>loading</main>',
      },
    }),
    isRunning: false,
    hasStartArtifactRunHandler: true,
  });

  assert.equal(model.defaultTab, 'show');
  assert.equal(model.canShowPreview, true);
  assert.equal(model.supportsStreamingPreview, true);
  assert.deepEqual(model.surfaceStateBadge, {
    label: '생성 중',
    tone: 'info',
  });
  assert.equal(model.canApply, false);
  assert.equal(model.applyDraft, null);
});

void test('buildArtifactPaneStateModel keeps unsupported streaming previews on the write tab', () => {
  const model = buildArtifactPaneStateModel({
    viewModel: createArtifactPaneViewModel({
      parsed: {
        kind: 'artifact',
        state: 'streaming',
        renderer: 'unknown',
        digest: 'fixture',
        payload: 'loading',
        raw: 'loading',
      },
    }),
    isRunning: false,
    hasStartArtifactRunHandler: true,
  });

  assert.equal(model.defaultTab, 'write');
  assert.equal(model.canShowPreview, false);
  assert.equal(model.supportsStreamingPreview, false);
  assert.deepEqual(model.surfaceStateBadge, {
    label: '생성 중',
    tone: 'info',
  });
});

void test('buildArtifactPaneStateModel sends fallback artifacts to raw with a warning badge', () => {
  const model = buildArtifactPaneStateModel({
    viewModel: createArtifactPaneViewModel({
      parsed: {
        kind: 'artifact',
        state: 'fallback',
        renderer: null,
        digest: null,
        payload: 'unsupported',
        raw: 'unsupported',
        issue: 'artifact suffix is not supported',
      },
    }),
    isRunning: false,
    hasStartArtifactRunHandler: true,
  });

  assert.equal(model.defaultTab, 'raw');
  assert.equal(model.canShowPreview, false);
  assert.deepEqual(model.surfaceStateBadge, {
    label: '미리보기 제한',
    tone: 'warn',
  });
});

void test('buildArtifactPaneStateModel disables source and apply actions when contracts are missing', () => {
  const model = buildArtifactPaneStateModel({
    viewModel: createArtifactPaneViewModel({
      sourceRef: {
        filePath: null,
      },
    }),
    isRunning: true,
    hasStartArtifactRunHandler: false,
  });

  assert.equal(model.showOpenSource, false);
  assert.equal(model.showApply, true);
  assert.equal(model.canApply, false);
  assert.equal(model.applyDraft, null);
});
