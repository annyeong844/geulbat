import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';

import {
  installFetchSequence,
  jsonResponse,
  renderHook,
} from '../../../../test-support/hook-test.js';
import {
  brandProjectId,
  brandThreadId,
} from '../../../../lib/id-brand-helpers.js';
import type { ResolvedArtifactSourceRef } from '../../artifact-types.js';
import type { ArtifactRuntimeFrameRenderArgs } from '../types.js';
import { useReactBundleInlineCompilePreviewSurface } from './use-inline-compile-preview-surface.js';

function createSourceRef(): ResolvedArtifactSourceRef {
  return {
    kind: null,
    projectId: brandProjectId('workspace'),
    threadId: brandThreadId('00000000-0000-4000-8000-000000000001'),
    runId: null,
    filePath: 'episodes/ch01.md',
    messageTimestamp: null,
    artifactId: 'art_1',
    artifactVersion: 1,
    persistenceEpoch: 0,
  };
}

function createInlineReactBundlePayload(): string {
  return JSON.stringify({
    files: {
      'src/App.jsx': 'export default function App() { return null; }',
    },
    entry: 'src/App.jsx',
  });
}

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

void test('useReactBundleInlineCompilePreviewSurface returns compile failures as unavailable previews', async () => {
  const fetchMock = installFetchSequence(() =>
    jsonResponse({
      ok: false,
      code: 'boot_failed',
      detail: 'react bundle inline compile failed',
    }),
  );
  const runtimeFrame = createRuntimeFrameRecorder();

  try {
    const hook = await renderHook(useReactBundleInlineCompilePreviewSurface, {
      enabled: true,
      payload: createInlineReactBundlePayload(),
      artifactSessionKey: 'react_bundle::heart-react-demo::completed',
      sourceRef: createSourceRef(),
      renderRuntimeFrame: runtimeFrame.renderRuntimeFrame,
    });

    await hook.flush();
    await hook.flush();

    assert.equal(fetchMock.calls.length, 1);
    assert.equal(hook.result.current?.kind, 'unavailable');
    if (hook.result.current?.kind !== 'unavailable') {
      assert.fail('expected unavailable inline compile preview');
    }
    assert.equal(hook.result.current.code, 'boot_failed');
    assert.equal(
      hook.result.current.detail,
      'react bundle inline compile failed',
    );
    assert.deepEqual(runtimeFrame.calls, []);

    hook.unmount();
  } finally {
    fetchMock.restore();
  }
});

void test('useReactBundleInlineCompilePreviewSurface compiles inline react bundles once per artifact session', async () => {
  const fetchMock = installFetchSequence(() =>
    jsonResponse({
      ok: true,
      manifest: {
        entryUrl:
          'http://127.0.0.1:1455/public-generated/react-bundle-inline/hash/entry.js',
      },
    }),
  );
  const runtimeFrame = createRuntimeFrameRecorder();

  try {
    const initialProps = {
      enabled: true,
      payload: createInlineReactBundlePayload(),
      artifactSessionKey: 'react_bundle::heart-react-demo::completed',
      sourceRef: createSourceRef(),
      renderRuntimeFrame: runtimeFrame.renderRuntimeFrame,
    } as const;
    const hook = await renderHook(
      useReactBundleInlineCompilePreviewSurface,
      initialProps,
    );

    await hook.flush();
    await hook.flush();
    await hook.rerender({
      ...initialProps,
      sourceRef: createSourceRef(),
    });
    await hook.flush();
    await hook.flush();

    assert.equal(fetchMock.calls.length, 1);
    assert.equal(hook.result.current?.kind, 'rendered');
    assert.equal(runtimeFrame.calls.length, 2);
    assert.equal(runtimeFrame.calls[0]?.renderer, 'react_bundle');

    hook.unmount();
  } finally {
    fetchMock.restore();
  }
});

void test('useReactBundleInlineCompilePreviewSurface does not compile disabled react bundles', async () => {
  const fetchMock = installFetchSequence(() =>
    jsonResponse({
      ok: true,
      manifest: {
        entryUrl:
          'http://127.0.0.1:1455/public-generated/react-bundle-inline/hash/entry.js',
      },
    }),
  );
  const runtimeFrame = createRuntimeFrameRecorder();

  try {
    const hook = await renderHook(useReactBundleInlineCompilePreviewSurface, {
      enabled: false,
      payload: createInlineReactBundlePayload(),
      artifactSessionKey: 'react_bundle::heart-react-demo::fallback',
      sourceRef: createSourceRef(),
      renderRuntimeFrame: runtimeFrame.renderRuntimeFrame,
    });

    await hook.flush();
    await hook.flush();

    assert.equal(fetchMock.calls.length, 0);
    assert.equal(hook.result.current, null);
    assert.deepEqual(runtimeFrame.calls, []);

    hook.unmount();
  } finally {
    fetchMock.restore();
  }
});
