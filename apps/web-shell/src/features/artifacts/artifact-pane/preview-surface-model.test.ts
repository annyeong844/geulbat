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

void test('shouldUseArtifactPaneHookManagedPreview recognizes the committed react bundle route', () => {
  assert.equal(
    shouldUseArtifactPaneHookManagedPreview(
      createArtifactPaneViewModel({
        artifact: { renderer: 'react_bundle' },
      }),
    ),
    true,
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
      artifact: { renderer: 'react_bundle' },
    }),
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
      artifact: {
        renderer: 'markdown',
        payload: '# hello artifact',
      },
    }),
    hookManagedPreviewSurface: null,
  });

  assert.equal(model.kind, 'surface');
  if (model.kind !== 'surface' || model.previewSurface?.kind !== 'rendered') {
    assert.fail('expected a rendered static preview surface');
  }

  const html = renderToStaticMarkup(model.previewSurface.node);
  assert.match(html, /hello artifact/);
});

void test('resolveArtifactPanePreviewSurfaceModel builds committed runtime preview requests with scoped export callbacks', () => {
  const onGeneratedTextExportSnapshotChange = (
    _snapshot: GeneratedTextExportSnapshot | null,
  ) => undefined;
  const onGeneratedBinaryExportSnapshotChange = (
    _snapshot: GeneratedBinaryExportSnapshot | null,
  ) => undefined;
  const jsModel = resolveArtifactPanePreviewSurfaceModel({
    viewModel: createArtifactPaneViewModel({
      artifact: {
        renderer: 'js',
        payload: 'document.body.textContent = "hello";',
      },
    }),
    hookManagedPreviewSurface: null,
    onGeneratedTextExportSnapshotChange,
    onGeneratedBinaryExportSnapshotChange,
  });

  assert.equal(jsModel.kind, 'runtime');
  if (jsModel.kind !== 'runtime') {
    assert.fail('expected a runtime preview request');
  }
  assert.equal(jsModel.renderer, 'js');
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
      artifact: {
        renderer: 'html5',
        payload: '<main>hello</main>',
      },
    }),
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
