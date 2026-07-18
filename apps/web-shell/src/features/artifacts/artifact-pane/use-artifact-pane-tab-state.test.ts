import test from 'node:test';
import assert from 'node:assert/strict';

import { renderHook } from '../../../test-support/hook-test.js';
import { useArtifactPaneTabState } from './use-artifact-pane-tab-state.js';

void test('useArtifactPaneTabState keeps selection until the artifact session changes', async () => {
  const hook = await renderHook(useArtifactPaneTabState, {
    artifactSessionKey: 'artifact-a',
    defaultTab: 'show',
  });

  assert.equal(hook.result.current.tab, 'show');

  await hook.run((state) => {
    state.handleSelectTab('source');
  });
  assert.equal(hook.result.current.tab, 'source');

  await hook.rerender({
    artifactSessionKey: 'artifact-a',
    defaultTab: 'show',
  });
  assert.equal(hook.result.current.tab, 'source');

  await hook.rerender({
    artifactSessionKey: 'artifact-b',
    defaultTab: 'source',
  });
  assert.equal(hook.result.current.tab, 'source');

  hook.unmount();
});
