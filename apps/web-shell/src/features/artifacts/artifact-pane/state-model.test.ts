import test from 'node:test';
import assert from 'node:assert/strict';

import { createArtifactPaneViewModel } from '../../../test-support/create-artifact-pane-view-model.js';
import { buildArtifactPaneStateModel } from './state-model.js';

void test('buildArtifactPaneStateModel defaults committed previews to the show tab', () => {
  const model = buildArtifactPaneStateModel({
    viewModel: createArtifactPaneViewModel(),
    isRunning: false,
    hasStartArtifactRunHandler: true,
  });

  assert.equal(model.defaultTab, 'show');
  assert.equal(model.showApply, true);
  assert.equal(model.canApply, true);
  assert.equal(
    model.applyDraft?.displayPrompt,
    'Apply artifact to notes/demo.md',
  );
});

void test('buildArtifactPaneStateModel disables apply while its runtime contract is unavailable', () => {
  const model = buildArtifactPaneStateModel({
    viewModel: createArtifactPaneViewModel({
      sourceRef: {
        filePath: null,
      },
    }),
    isRunning: true,
    hasStartArtifactRunHandler: false,
  });

  assert.equal(model.showApply, true);
  assert.equal(model.canApply, false);
  assert.equal(model.applyDraft, null);
});
