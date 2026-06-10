import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import type { RunRequest } from '@geulbat/protocol/run-contract';

import { renderHook } from '../../../test-support/hook-test.js';
import { createArtifactPaneViewModel } from '../../../test-support/create-artifact-pane-view-model.js';
import type { ArtifactRuntimeFrameRenderArgs } from '../runtime-preview/types.js';
import { useArtifactPaneController } from './use-artifact-pane-controller.js';

function createRuntimeFrameRecorder() {
  const calls: ArtifactRuntimeFrameRenderArgs[] = [];
  return {
    calls,
    renderRuntimeFrame(args: ArtifactRuntimeFrameRenderArgs) {
      calls.push(args);
      return createElement('iframe', {
        sandbox: args.sandbox,
        src: `http://127.0.0.1:3456/artifact-runtime/host?renderer=${args.renderer}&rev=fixture`,
      });
    },
  };
}

void test('useArtifactPaneController owns pane/export coordination', async () => {
  const startedRuns: RunRequest[] = [];
  const runtimeFrame = createRuntimeFrameRecorder();
  const hook = await renderHook(useArtifactPaneController, {
    label: 'Artifact',
    viewModel: createArtifactPaneViewModel(),
    isRunning: false,
    isLiveStreamingArtifact: false,
    renderRuntimeFrame: runtimeFrame.renderRuntimeFrame,
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
  assert.deepEqual(runtimeFrame.calls, []);

  hook.unmount();
});

void test('useArtifactPaneController forwards runtime previews through the injected frame renderer', async () => {
  const runtimeFrame = createRuntimeFrameRecorder();
  const hook = await renderHook(useArtifactPaneController, {
    label: 'Artifact',
    viewModel: createArtifactPaneViewModel({
      parsed: {
        kind: 'artifact',
        state: 'completed',
        renderer: 'js',
        digest: 'controller-js-demo',
        payload: 'document.body.textContent = "controller";',
        raw: 'document.body.textContent = "controller";',
      },
    }),
    isRunning: false,
    isLiveStreamingArtifact: false,
    renderRuntimeFrame: runtimeFrame.renderRuntimeFrame,
  });

  assert.equal(hook.result.current.bodyProps.previewSurface?.kind, 'rendered');
  assert.ok(runtimeFrame.calls.length > 0);
  for (const call of runtimeFrame.calls) {
    assert.equal(call.renderer, 'js');
    assert.equal(
      call.runtimePayload,
      'document.body.textContent = "controller";',
    );
  }

  hook.unmount();
});
