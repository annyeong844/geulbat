import test from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';

import { createArtifactPaneViewModel } from '../../../test-support/create-artifact-pane-view-model.js';
import {
  pendingArtifactPreview,
  type GeneratedBinaryExportSnapshot,
  type GeneratedTextExportSnapshot,
} from '../artifact-types.js';
import {
  resolveArtifactPanePreviewSurfaceModel,
  shouldUseArtifactPaneHookManagedPreview,
} from './preview-surface-model.js';

void test('shouldUseArtifactPaneHookManagedPreview only enables completed hook-managed renderers', () => {
  assert.equal(
    shouldUseArtifactPaneHookManagedPreview(
      createArtifactPaneViewModel({
        parsed: artifactParseResult({
          renderer: 'react_bundle',
          state: 'completed',
        }),
      }),
    ),
    true,
  );
  assert.equal(
    shouldUseArtifactPaneHookManagedPreview(
      createArtifactPaneViewModel({
        parsed: artifactParseResult({
          renderer: 'react_bundle',
          state: 'fallback',
        }),
      }),
    ),
    false,
  );
  assert.equal(
    shouldUseArtifactPaneHookManagedPreview(createArtifactPaneViewModel()),
    false,
  );
});

void test('resolveArtifactPanePreviewSurfaceModel returns hook-managed preview surfaces without runtime routing', () => {
  const hookManagedPreviewSurface = pendingArtifactPreview(
    'Compiling inline bundle',
  );
  const model = resolveArtifactPanePreviewSurfaceModel({
    viewModel: createArtifactPaneViewModel({
      parsed: artifactParseResult({ renderer: 'react_bundle' }),
    }),
    canShowPreview: true,
    supportsStreamingPreview: false,
    isLiveStreamingArtifact: false,
    hookManagedPreviewSurface,
  });

  assert.equal(model.kind, 'surface');
  if (model.kind === 'surface') {
    assert.equal(model.previewSurface, hookManagedPreviewSurface);
  }
});

void test('resolveArtifactPanePreviewSurfaceModel resolves static previews in the artifact owner', () => {
  const model = resolveArtifactPanePreviewSurfaceModel({
    viewModel: createArtifactPaneViewModel({
      parsed: artifactParseResult({
        renderer: 'markdown',
        payload: '# hello artifact',
      }),
    }),
    canShowPreview: true,
    supportsStreamingPreview: false,
    isLiveStreamingArtifact: false,
    hookManagedPreviewSurface: null,
  });

  assert.equal(model.kind, 'surface');
  if (model.kind !== 'surface' || model.previewSurface?.kind !== 'rendered') {
    assert.fail('expected a rendered static preview surface');
  }

  const html = renderToStaticMarkup(model.previewSurface.node);
  assert.match(html, /hello artifact/);
});

void test('resolveArtifactPanePreviewSurfaceModel builds runtime preview requests with scoped export callbacks', () => {
  const onGeneratedTextExportSnapshotChange = (
    _snapshot: GeneratedTextExportSnapshot | null,
  ) => undefined;
  const onGeneratedBinaryExportSnapshotChange = (
    _snapshot: GeneratedBinaryExportSnapshot | null,
  ) => undefined;
  const jsModel = resolveArtifactPanePreviewSurfaceModel({
    viewModel: createArtifactPaneViewModel({
      parsed: artifactParseResult({
        renderer: 'js',
        state: 'streaming',
        payload: 'document.body.textContent = "hello";',
      }),
    }),
    canShowPreview: true,
    supportsStreamingPreview: true,
    isLiveStreamingArtifact: false,
    hookManagedPreviewSurface: null,
    onGeneratedTextExportSnapshotChange,
    onGeneratedBinaryExportSnapshotChange,
  });

  assert.equal(jsModel.kind, 'runtime');
  if (jsModel.kind !== 'runtime') {
    assert.fail('expected a runtime preview request');
  }
  assert.equal(jsModel.renderer, 'js');
  assert.equal(jsModel.context.isStreamingPreview, true);
  assert.equal(
    jsModel.context.onGeneratedTextExportSnapshotChange,
    onGeneratedTextExportSnapshotChange,
  );
  assert.equal(
    jsModel.context.onGeneratedBinaryExportSnapshotChange,
    onGeneratedBinaryExportSnapshotChange,
  );

  const htmlModel = resolveArtifactPanePreviewSurfaceModel({
    viewModel: createArtifactPaneViewModel({
      parsed: artifactParseResult({
        renderer: 'html5',
        state: 'streaming',
        payload: '<main>hello</main>',
      }),
    }),
    canShowPreview: true,
    supportsStreamingPreview: true,
    isLiveStreamingArtifact: false,
    hookManagedPreviewSurface: null,
    onGeneratedTextExportSnapshotChange,
    onGeneratedBinaryExportSnapshotChange,
  });

  assert.equal(htmlModel.kind, 'runtime');
  if (htmlModel.kind !== 'runtime') {
    assert.fail('expected a runtime preview request');
  }
  assert.equal(
    'onGeneratedTextExportSnapshotChange' in htmlModel.context,
    false,
  );
  assert.equal(
    'onGeneratedBinaryExportSnapshotChange' in htmlModel.context,
    false,
  );
});

void test('resolveArtifactPanePreviewSurfaceModel hides unavailable preview routes', () => {
  assert.deepEqual(
    resolveArtifactPanePreviewSurfaceModel({
      viewModel: createArtifactPaneViewModel(),
      canShowPreview: false,
      supportsStreamingPreview: false,
      isLiveStreamingArtifact: false,
      hookManagedPreviewSurface: null,
    }),
    {
      kind: 'surface',
      previewSurface: null,
    },
  );
  assert.deepEqual(
    resolveArtifactPanePreviewSurfaceModel({
      viewModel: createArtifactPaneViewModel({
        parsed: artifactParseResult({ renderer: 'unknown' }),
      }),
      canShowPreview: true,
      supportsStreamingPreview: false,
      isLiveStreamingArtifact: false,
      hookManagedPreviewSurface: null,
    }),
    {
      kind: 'surface',
      previewSurface: null,
    },
  );
});

function artifactParseResult(
  overrides: Partial<{
    state: 'streaming' | 'completed' | 'fallback';
    renderer: string | null;
    digest: string | null;
    payload: string;
  }> = {},
) {
  return {
    kind: 'artifact' as const,
    state: overrides.state ?? 'completed',
    renderer: overrides.renderer ?? 'markdown',
    digest: overrides.digest ?? 'fixture',
    payload: overrides.payload ?? 'hello',
    raw: overrides.payload ?? 'hello',
    ...(overrides.state === 'fallback'
      ? { issue: 'artifact suffix is not supported' }
      : {}),
  };
}
