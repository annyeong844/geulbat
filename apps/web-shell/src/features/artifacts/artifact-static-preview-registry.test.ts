import test from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';

import {
  isStaticArtifactPreviewRenderer,
  resolveStaticArtifactPreview,
  STATIC_ARTIFACT_PREVIEW_RESOURCE_POLICY,
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

void test('resolveStaticArtifactPreview refuses markdown previews that exceed the line policy', () => {
  const preview = resolveStaticArtifactPreview(
    'markdown',
    Array.from(
      {
        length: STATIC_ARTIFACT_PREVIEW_RESOURCE_POLICY.maxMarkdownLines + 1,
      },
      (_, index) => `# heading ${index}`,
    ).join('\n'),
  );

  assert.equal(preview.kind, 'unavailable');
  if (preview.kind !== 'unavailable') {
    assert.fail('expected static preview resource policy to block rendering');
  }
  assert.equal(preview.code, 'policy_blocked');
  assert.match(preview.detail, /markdown has/);
});

void test('resolveStaticArtifactPreview refuses oversized code previews without truncating the artifact surface', () => {
  const preview = resolveStaticArtifactPreview(
    'code',
    'x'.repeat(STATIC_ARTIFACT_PREVIEW_RESOURCE_POLICY.maxTextCodeUnits + 1),
  );

  assert.equal(preview.kind, 'unavailable');
  if (preview.kind !== 'unavailable') {
    assert.fail('expected static preview resource policy to block rendering');
  }
  assert.equal(preview.code, 'policy_blocked');
  assert.match(
    preview.detail,
    new RegExp(STATIC_ARTIFACT_PREVIEW_RESOURCE_POLICY.policyId),
  );
  assert.match(preview.detail, /Raw\/source content remains available/);
});

void test('resolveStaticArtifactPreview refuses diff previews that exceed the row policy', () => {
  const preview = resolveStaticArtifactPreview(
    'diff',
    Array.from(
      {
        length: STATIC_ARTIFACT_PREVIEW_RESOURCE_POLICY.maxDiffLines + 1,
      },
      (_, index) => `+line ${index}`,
    ).join('\n'),
  );

  assert.equal(preview.kind, 'unavailable');
  if (preview.kind !== 'unavailable') {
    assert.fail('expected static preview resource policy to block rendering');
  }
  assert.equal(preview.code, 'policy_blocked');
  assert.match(preview.detail, /diff has/);
});

void test('resolveStaticArtifactPreview refuses table previews that exceed the cell policy', () => {
  const preview = resolveStaticArtifactPreview(
    'table',
    [
      Array.from(
        {
          length: STATIC_ARTIFACT_PREVIEW_RESOURCE_POLICY.maxTableCells + 1,
        },
        (_, index) => `cell_${index}`,
      ).join('|'),
    ].join('\n'),
  );

  assert.equal(preview.kind, 'unavailable');
  if (preview.kind !== 'unavailable') {
    assert.fail('expected static preview resource policy to block rendering');
  }
  assert.equal(preview.code, 'policy_blocked');
  assert.match(preview.detail, /table has/);
});

void test('isStaticArtifactPreviewRenderer rejects runtime-backed renderers', () => {
  assert.equal(isStaticArtifactPreviewRenderer('markdown'), true);
  assert.equal(isStaticArtifactPreviewRenderer('code'), true);
  assert.equal(isStaticArtifactPreviewRenderer('html5'), false);
  assert.equal(isStaticArtifactPreviewRenderer('js'), false);
  assert.equal(isStaticArtifactPreviewRenderer('react_bundle'), false);
  assert.equal(isStaticArtifactPreviewRenderer('unknown'), false);
});
