import test from 'node:test';
import assert from 'node:assert/strict';

import { renderHook } from '../../../test-support/hook-test.js';
import { createArtifactPaneViewModel } from '../../../test-support/create-artifact-pane-view-model.js';
import { useArtifactPaneController } from './use-pane-controller.js';
import type { RunRequest } from '@geulbat/protocol/run-contract';

void test('useArtifactPaneController owns pane/export coordination', async () => {
  const startedRuns: RunRequest[] = [];
  const hook = await renderHook(useArtifactPaneController, {
    label: 'Artifact',
    viewModel: createArtifactPaneViewModel(),
    isRunning: false,
    isLiveStreamingArtifact: false,
    onStartArtifactRun: (request) => {
      startedRuns.push(request);
    },
  });

  assert.equal(hook.result.current.headerProps.showExport, true);

  await hook.run((controller) => {
    void controller.headerProps.onToggleExport();
  });

  const openedExportPanel = hook.result.current.exportPanelProps;
  if (openedExportPanel === null) {
    assert.fail('expected export panel to open');
  }
  assert.equal(openedExportPanel.placeholder, 'exports/demo.md');

  await hook.run((controller) => {
    controller.exportPanelProps?.onChangeValue('exports/demo.md');
  });

  const changedExportPanel = hook.result.current.exportPanelProps;
  if (changedExportPanel === null) {
    assert.fail('expected export panel to remain open');
  }
  assert.equal(changedExportPanel.value, 'exports/demo.md');

  await hook.run(async (controller) => {
    await controller.exportPanelProps?.onSubmit();
  });

  assert.equal(startedRuns.length, 1);
  assert.equal(hook.result.current.exportPanelProps, null);

  hook.unmount();
});
