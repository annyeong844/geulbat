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
    state.handleSelectTab('raw');
  });
  assert.equal(hook.result.current.tab, 'raw');

  await hook.rerender({
    artifactSessionKey: 'artifact-a',
    defaultTab: 'show',
  });
  assert.equal(hook.result.current.tab, 'raw');

  await hook.rerender({
    artifactSessionKey: 'artifact-b',
    defaultTab: 'write',
  });
  assert.equal(hook.result.current.tab, 'write');

  hook.unmount();
});
