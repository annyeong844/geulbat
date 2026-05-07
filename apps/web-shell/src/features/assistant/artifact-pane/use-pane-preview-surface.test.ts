import test from 'node:test';
import assert from 'node:assert/strict';

import {
  installFetchSequence,
  jsonResponse,
  renderHook,
} from '../../../test-support/hook-test.js';
import { createArtifactPaneViewModel } from '../../../test-support/create-artifact-pane-view-model.js';
import { useArtifactPanePreviewSurface } from './use-pane-preview-surface.js';

void test('useArtifactPanePreviewSurface returns inline react bundle compile failures as runtime unavailable messages', async () => {
  const fetchMock = installFetchSequence(() =>
    jsonResponse({
      ok: false,
      code: 'boot_failed',
      detail: 'react bundle inline compile failed',
    }),
  );

  try {
    const hook = await renderHook(useArtifactPanePreviewSurface, {
      viewModel: createInlineReactBundleViewModel(),
      artifactSessionKey: 'react_bundle::heart-react-demo::completed',
      canShowPreview: true,
      supportsStreamingPreview: false,
      isLiveStreamingArtifact: false,
    });

    await hook.flush();
    await hook.flush();

    assert.equal(hook.result.current.previewSurface?.kind, 'unavailable');
    assert.equal(
      hook.result.current.runtimeUnavailableMessage,
      '캔버스를 시작하지 못했습니다. react bundle inline compile failed',
    );

    hook.unmount();
  } finally {
    fetchMock.restore();
  }
});

void test('useArtifactPanePreviewSurface compiles inline react bundles once per artifact session', async () => {
  const fetchMock = installFetchSequence(() =>
    jsonResponse({
      ok: true,
      manifest: {
        entryUrl:
          'http://127.0.0.1:1455/public-generated/react-bundle-inline/hash/entry.js',
      },
    }),
  );

  try {
    const initialProps = {
      viewModel: createInlineReactBundleViewModel(),
      artifactSessionKey: 'react_bundle::heart-react-demo::completed',
      canShowPreview: true,
      supportsStreamingPreview: false,
      isLiveStreamingArtifact: false,
    } as const;
    const hook = await renderHook(useArtifactPanePreviewSurface, initialProps);

    await hook.flush();
    await hook.flush();
    await hook.rerender({
      ...initialProps,
      viewModel: createInlineReactBundleViewModel(),
    });
    await hook.flush();
    await hook.flush();

    assert.equal(fetchMock.calls.length, 1);
    assert.equal(hook.result.current.previewSurface?.kind, 'rendered');

    hook.unmount();
  } finally {
    fetchMock.restore();
  }
});

void test('useArtifactPanePreviewSurface does not compile fallback react bundles', async () => {
  const fetchMock = installFetchSequence(() =>
    jsonResponse({
      ok: true,
      manifest: {
        entryUrl:
          'http://127.0.0.1:1455/public-generated/react-bundle-inline/hash/entry.js',
      },
    }),
  );

  try {
    const hook = await renderHook(useArtifactPanePreviewSurface, {
      viewModel: createInlineReactBundleViewModel({ state: 'fallback' }),
      artifactSessionKey: 'react_bundle::heart-react-demo::fallback',
      canShowPreview: false,
      supportsStreamingPreview: false,
      isLiveStreamingArtifact: false,
    });

    await hook.flush();
    await hook.flush();

    assert.equal(fetchMock.calls.length, 0);
    assert.equal(hook.result.current.previewSurface, null);
    assert.equal(hook.result.current.runtimeUnavailableMessage, null);

    hook.unmount();
  } finally {
    fetchMock.restore();
  }
});

function createInlineReactBundleViewModel(
  overrides: Partial<{
    state: 'completed' | 'fallback';
  }> = {},
) {
  const state = overrides.state ?? 'completed';
  return createArtifactPaneViewModel({
    parsed: {
      kind: 'artifact',
      state,
      renderer: 'react_bundle',
      digest: 'heart-react-demo',
      payload: JSON.stringify({
        files: {
          'src/App.jsx': 'export default function App() { return null; }',
        },
        entry: 'src/App.jsx',
      }),
      raw: JSON.stringify({
        files: {
          'src/App.jsx': 'export default function App() { return null; }',
        },
        entry: 'src/App.jsx',
      }),
      ...(state === 'fallback'
        ? { issue: 'artifact suffix is not supported' }
        : {}),
    },
    sourceRef: {
      filePath: 'episodes/ch01.md',
      artifactId: 'art_1',
      artifactVersion: 1,
      persistenceEpoch: 0,
    },
  });
}
