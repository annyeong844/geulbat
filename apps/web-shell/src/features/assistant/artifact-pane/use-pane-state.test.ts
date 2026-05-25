import test from 'node:test';
import assert from 'node:assert/strict';
import type { RunRequest } from '@geulbat/protocol/run-contract';

import { renderHook } from '../../../test-support/hook-test.js';
import { createArtifactPaneViewModel } from '../../../test-support/create-artifact-pane-view-model.js';
import { useArtifactPaneState } from './use-pane-state.js';

void test('useArtifactPaneState coordinates pane tab and apply handoff', async () => {
  const startedRuns: RunRequest[] = [];
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
    onStartArtifactRun: (request) => {
      startedRuns.push(request);
    },
  });

  assert.equal(hook.result.current.tab, 'show');
  assert.equal(hook.result.current.canShowPreview, true);
  assert.equal(hook.result.current.showApply, true);
  assert.equal(hook.result.current.canApply, true);

  await hook.run((state) => {
    state.handleSelectTab('raw');
  });
  assert.equal(hook.result.current.tab, 'raw');

  await hook.run((state) => {
    state.handleApply();
  });
  assert.equal(startedRuns.length, 1);

  hook.unmount();
});
