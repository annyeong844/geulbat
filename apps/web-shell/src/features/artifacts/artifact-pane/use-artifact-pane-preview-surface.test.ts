import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';

import { createArtifactPaneViewModel } from '../../../test-support/create-artifact-pane-view-model.js';
import { renderHook } from '../../../test-support/hook-test.js';
import type { ArtifactRuntimeFrameRenderArgs } from '../runtime-preview/types.js';
import { useArtifactPanePreviewSurface } from './use-artifact-pane-preview-surface.js';

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

void test('useArtifactPanePreviewSurface resolves runtime previews with the injected frame renderer', async () => {
  const runtimeFrame = createRuntimeFrameRecorder();
  const hook = await renderHook(useArtifactPanePreviewSurface, {
    viewModel: createArtifactPaneViewModel({
      artifact: {
        renderer: 'js',
        digest: 'fixture',
        payload: 'document.body.textContent = "hello";',
      },
    }),
    artifactSessionKey: 'js::hello',
    renderRuntimeFrame: runtimeFrame.renderRuntimeFrame,
  });

  assert.equal(hook.result.current.previewSurface?.kind, 'rendered');
  assert.equal(hook.result.current.runtimeUnavailableMessage, null);
  assert.ok(runtimeFrame.calls.length > 0);
  for (const call of runtimeFrame.calls) {
    assert.equal(call.renderer, 'js');
    assert.equal(call.runtimePayload, 'document.body.textContent = "hello";');
  }
  hook.unmount();
});
