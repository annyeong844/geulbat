import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';

import {
  installFetchSequence,
  jsonResponse,
  renderHook,
} from '../../../../test-support/hook-test.js';
import { brandThreadId } from '../../../../lib/id-brand-helpers.js';
import type { ResolvedArtifactSourceRef } from '../../artifact-types.js';
import type { ArtifactRuntimeFrameRenderArgs } from '../types.js';
import type { ReactBundlePreviewModule } from './inline-compile-preview-model.js';
import * as reactBundlePreviewModule from './preview.js';
import { useReactBundleInlineCompilePreviewSurface } from './use-inline-compile-preview-surface.js';

const REACT_BUNDLE_ENTRY_URL =
  'http://127.0.0.1:1455/public-generated/react-bundle-inline/hash/entry.js';

function createSourceRef(): ResolvedArtifactSourceRef {
  return {
    kind: null,
    workingDirectory: 'stories/sample',
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

function createManifestReactBundlePayload(): string {
  return JSON.stringify({ entryUrl: REACT_BUNDLE_ENTRY_URL });
}

function createPreviewModuleLoader() {
  let callCount = 0;
  return {
    get callCount() {
      return callCount;
    },
    loadPreviewModule(): Promise<ReactBundlePreviewModule> {
      callCount += 1;
      return Promise.resolve(reactBundlePreviewModule);
    },
  };
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

void test('useReactBundleInlineCompilePreviewSurface shares and reuses the loaded runtime module across canvas mounts', async () => {
  let resolvePreviewModule!: (module: ReactBundlePreviewModule) => void;
  const previewModulePromise = new Promise<ReactBundlePreviewModule>(
    (resolve) => {
      resolvePreviewModule = resolve;
    },
  );
  let loadCallCount = 0;
  const loadPreviewModule = () => {
    loadCallCount += 1;
    return previewModulePromise;
  };
  const runtimeFrame = createRuntimeFrameRecorder();
  const hook = await renderHook(useReactBundleInlineCompilePreviewSurface, {
    enabled: true,
    payload: createManifestReactBundlePayload(),
    artifactSessionKey: 'react_bundle::manifest-demo::completed',
    sourceRef: createSourceRef(),
    renderRuntimeFrame: runtimeFrame.renderRuntimeFrame,
    loadPreviewModule,
  });
  const concurrentHook = await renderHook(
    useReactBundleInlineCompilePreviewSurface,
    {
      enabled: true,
      payload: createManifestReactBundlePayload(),
      artifactSessionKey: 'react_bundle::manifest-demo-2::completed',
      sourceRef: createSourceRef(),
      renderRuntimeFrame: runtimeFrame.renderRuntimeFrame,
      loadPreviewModule,
    },
  );

  assert.equal(loadCallCount, 1);
  assert.equal(hook.result.current?.kind, 'pending');
  assert.equal(concurrentHook.result.current?.kind, 'pending');
  assert.equal(runtimeFrame.calls.length, 0);

  resolvePreviewModule(reactBundlePreviewModule);
  await hook.flush();
  await concurrentHook.flush();

  assert.equal(hook.result.current?.kind, 'rendered');
  assert.equal(concurrentHook.result.current?.kind, 'rendered');
  assert.ok(runtimeFrame.calls.length >= 2);
  assert.ok(
    runtimeFrame.calls.every((call) => call.renderer === 'react_bundle'),
  );
  hook.unmount();
  concurrentHook.unmount();

  const reopenedHook = await renderHook(
    useReactBundleInlineCompilePreviewSurface,
    {
      enabled: true,
      payload: createManifestReactBundlePayload(),
      artifactSessionKey: 'react_bundle::manifest-demo-3::completed',
      sourceRef: createSourceRef(),
      renderRuntimeFrame: runtimeFrame.renderRuntimeFrame,
      loadPreviewModule,
    },
  );

  assert.equal(loadCallCount, 1);
  assert.equal(reopenedHook.result.current?.kind, 'rendered');
  assert.ok(runtimeFrame.calls.length >= 3);
  assert.equal(runtimeFrame.calls.at(-1)?.renderer, 'react_bundle');
  reopenedHook.unmount();
});

void test('useReactBundleInlineCompilePreviewSurface reports runtime module load failures', async () => {
  const runtimeFrame = createRuntimeFrameRecorder();
  let loadCallCount = 0;
  const loadPreviewModule = () => {
    loadCallCount += 1;
    return loadCallCount === 1
      ? Promise.reject(new Error('react bundle runtime preview chunk failed'))
      : Promise.resolve(reactBundlePreviewModule);
  };
  const hook = await renderHook(useReactBundleInlineCompilePreviewSurface, {
    enabled: true,
    payload: createManifestReactBundlePayload(),
    artifactSessionKey: 'react_bundle::manifest-load-failure::completed',
    sourceRef: createSourceRef(),
    renderRuntimeFrame: runtimeFrame.renderRuntimeFrame,
    loadPreviewModule,
  });

  await hook.flush();

  assert.equal(hook.result.current?.kind, 'unavailable');
  if (hook.result.current?.kind !== 'unavailable') {
    assert.fail('expected unavailable runtime module preview');
  }
  assert.equal(hook.result.current.code, 'boot_failed');
  assert.equal(
    hook.result.current.detail,
    'react bundle runtime preview chunk failed',
  );
  assert.deepEqual(runtimeFrame.calls, []);
  hook.unmount();

  const retriedHook = await renderHook(
    useReactBundleInlineCompilePreviewSurface,
    {
      enabled: true,
      payload: createManifestReactBundlePayload(),
      artifactSessionKey: 'react_bundle::manifest-load-retry::completed',
      sourceRef: createSourceRef(),
      renderRuntimeFrame: runtimeFrame.renderRuntimeFrame,
      loadPreviewModule,
    },
  );
  await retriedHook.flush();

  assert.equal(loadCallCount, 2);
  assert.equal(retriedHook.result.current?.kind, 'rendered');
  assert.equal(runtimeFrame.calls.length, 1);
  retriedHook.unmount();
});

void test('useReactBundleInlineCompilePreviewSurface does not load the runtime module for invalid payloads', async () => {
  const runtimeFrame = createRuntimeFrameRecorder();
  const previewModuleLoader = createPreviewModuleLoader();
  const hook = await renderHook(useReactBundleInlineCompilePreviewSurface, {
    enabled: true,
    payload: '{',
    artifactSessionKey: 'react_bundle::invalid::completed',
    sourceRef: createSourceRef(),
    renderRuntimeFrame: runtimeFrame.renderRuntimeFrame,
    loadPreviewModule: previewModuleLoader.loadPreviewModule,
  });

  await hook.flush();

  assert.equal(previewModuleLoader.callCount, 0);
  assert.equal(hook.result.current?.kind, 'unavailable');
  assert.deepEqual(runtimeFrame.calls, []);
  hook.unmount();
});

void test('useReactBundleInlineCompilePreviewSurface returns compile failures as unavailable previews', async () => {
  const fetchMock = installFetchSequence(
    () =>
      jsonResponse({
        ok: true,
        inputRef:
          'react-bundle-inline-compile-input:00000000-0000-4000-8000-000000000001',
        byteLength: 64,
      }),
    () =>
      jsonResponse({
        ok: false,
        code: 'boot_failed',
        detail: 'react bundle inline compile failed',
      }),
  );
  const runtimeFrame = createRuntimeFrameRecorder();
  const previewModuleLoader = createPreviewModuleLoader();

  try {
    const hook = await renderHook(useReactBundleInlineCompilePreviewSurface, {
      enabled: true,
      payload: createInlineReactBundlePayload(),
      artifactSessionKey: 'react_bundle::heart-react-demo::completed',
      sourceRef: createSourceRef(),
      renderRuntimeFrame: runtimeFrame.renderRuntimeFrame,
      loadPreviewModule: previewModuleLoader.loadPreviewModule,
    });

    await hook.flush();
    await hook.flush();

    assert.equal(fetchMock.calls.length, 2);
    assert.equal(previewModuleLoader.callCount, 1);
    assert.match(
      fetchMock.calls[0]?.url ?? '',
      /^\/api\/react-bundle-inline-compile\/inputs$/u,
    );
    assert.match(
      fetchMock.calls[1]?.url ?? '',
      /^\/api\/react-bundle-inline-compile$/u,
    );
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
  const fetchMock = installFetchSequence(
    () =>
      jsonResponse({
        ok: true,
        inputRef:
          'react-bundle-inline-compile-input:00000000-0000-4000-8000-000000000002',
        byteLength: 64,
      }),
    () =>
      jsonResponse({
        ok: true,
        manifest: {
          entryUrl:
            'http://127.0.0.1:1455/public-generated/react-bundle-inline/hash/entry.js',
        },
      }),
  );
  const runtimeFrame = createRuntimeFrameRecorder();
  const previewModuleLoader = createPreviewModuleLoader();

  try {
    const initialProps = {
      enabled: true,
      payload: createInlineReactBundlePayload(),
      artifactSessionKey: 'react_bundle::heart-react-demo::completed',
      sourceRef: createSourceRef(),
      renderRuntimeFrame: runtimeFrame.renderRuntimeFrame,
      loadPreviewModule: previewModuleLoader.loadPreviewModule,
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

    assert.equal(fetchMock.calls.length, 2);
    assert.equal(previewModuleLoader.callCount, 1);
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
  const previewModuleLoader = createPreviewModuleLoader();

  try {
    const hook = await renderHook(useReactBundleInlineCompilePreviewSurface, {
      enabled: false,
      payload: createInlineReactBundlePayload(),
      artifactSessionKey: 'react_bundle::heart-react-demo::fallback',
      sourceRef: createSourceRef(),
      renderRuntimeFrame: runtimeFrame.renderRuntimeFrame,
      loadPreviewModule: previewModuleLoader.loadPreviewModule,
    });

    await hook.flush();
    await hook.flush();

    assert.equal(fetchMock.calls.length, 0);
    assert.equal(previewModuleLoader.callCount, 0);
    assert.equal(hook.result.current, null);
    assert.deepEqual(runtimeFrame.calls, []);

    hook.unmount();
  } finally {
    fetchMock.restore();
  }
});
