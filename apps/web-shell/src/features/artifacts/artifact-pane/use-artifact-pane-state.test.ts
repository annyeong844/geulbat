import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import type { RunRequest } from '@geulbat/protocol/run-contract';

import { renderHook } from '../../../test-support/hook-test.js';
import { createArtifactPaneViewModel } from '../../../test-support/create-artifact-pane-view-model.js';
import type { ArtifactRuntimeFrameRenderArgs } from '../runtime-preview/types.js';
import { useArtifactPaneState } from './use-artifact-pane-state.js';

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

void test('useArtifactPaneState coordinates pane tab and apply handoff', async () => {
  const startedRuns: RunRequest[] = [];
  const runtimeFrame = createRuntimeFrameRecorder();
  const hook = await renderHook(useArtifactPaneState, {
    viewModel: createArtifactPaneViewModel({
      parsed: {
        kind: 'artifact',
        state: 'completed',
        renderer: 'markdown',
        digest: 'markdown-demo',
        payload: 'hello artifact',
        raw: 'hello artifact',
      },
    }),
    isRunning: false,
    isLiveStreamingArtifact: false,
    renderRuntimeFrame: runtimeFrame.renderRuntimeFrame,
    onStartArtifactRun: (request) => {
      startedRuns.push(request);
    },
  });

  assert.equal(hook.result.current.tab, 'show');
  assert.equal(hook.result.current.canShowPreview, true);
  assert.equal(hook.result.current.showApply, true);
  assert.equal(hook.result.current.canApply, true);

  await hook.run((state) => {
    state.handleSelectTab('source');
  });
  assert.equal(hook.result.current.tab, 'source');

  await hook.run((state) => {
    state.handleApply();
  });
  assert.equal(startedRuns.length, 1);
  assert.deepEqual(runtimeFrame.calls, []);

  hook.unmount();
});

void test('useArtifactPaneState forwards runtime previews through the injected frame renderer', async () => {
  const runtimeFrame = createRuntimeFrameRecorder();
  const hook = await renderHook(useArtifactPaneState, {
    viewModel: createArtifactPaneViewModel({
      parsed: {
        kind: 'artifact',
        state: 'completed',
        renderer: 'js',
        digest: 'js-demo',
        payload: 'document.body.textContent = "state";',
        raw: 'document.body.textContent = "state";',
      },
    }),
    isRunning: false,
    isLiveStreamingArtifact: false,
    renderRuntimeFrame: runtimeFrame.renderRuntimeFrame,
  });

  assert.equal(hook.result.current.previewSurface?.kind, 'rendered');
  assert.ok(runtimeFrame.calls.length > 0);
  for (const call of runtimeFrame.calls) {
    assert.equal(call.renderer, 'js');
    assert.equal(call.runtimePayload, 'document.body.textContent = "state";');
  }

  hook.unmount();
});
