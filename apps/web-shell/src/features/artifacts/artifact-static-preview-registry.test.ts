import test from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';

import {
  isStaticArtifactPreviewRenderer,
  resolveStaticArtifactPreview,
} from './artifact-static-preview-registry.js';

void test('resolveStaticArtifactPreview renders markdown through the artifact-owned static registry', () => {
  const preview = resolveStaticArtifactPreview('markdown', '# Hello');

  assert.equal(preview.kind, 'rendered');
  const html = renderToStaticMarkup(preview.node);
  assert.match(html, /Hello/);
});

void test('resolveStaticArtifactPreview renders table previews without runtime adapters', () => {
  const preview = resolveStaticArtifactPreview(
    'table',
    ['Name | Count', '--- | ---', 'apples | 3'].join('\n'),
  );

  assert.equal(preview.kind, 'rendered');
  const html = renderToStaticMarkup(preview.node);
  assert.match(html, /<table/);
  assert.match(html, /apples/);
});

void test('isStaticArtifactPreviewRenderer rejects runtime-backed renderers', () => {
  assert.equal(isStaticArtifactPreviewRenderer('markdown'), true);
  assert.equal(isStaticArtifactPreviewRenderer('code'), true);
  assert.equal(isStaticArtifactPreviewRenderer('html5'), false);
  assert.equal(isStaticArtifactPreviewRenderer('js'), false);
  assert.equal(isStaticArtifactPreviewRenderer('react_bundle'), false);
  assert.equal(isStaticArtifactPreviewRenderer('unknown'), false);
});
