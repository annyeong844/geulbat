import test from 'node:test';
import assert from 'node:assert/strict';

import {
  isRuntimeArtifactPreviewRenderer,
  supportsGeneratedBinaryExportSnapshot,
  supportsGeneratedTextExportSnapshot,
  supportsRuntimeGeneratedExportSnapshots,
  supportsStreamingArtifactPreview,
  usesHookManagedArtifactPreview,
} from './artifact-renderer-capabilities.js';

void test('artifact renderer generated export capabilities are owned by the artifact contract', () => {
  assert.equal(supportsGeneratedTextExportSnapshot('js'), true);
  assert.equal(supportsGeneratedBinaryExportSnapshot('js'), true);
  assert.equal(supportsGeneratedTextExportSnapshot('react_bundle'), true);
  assert.equal(supportsGeneratedBinaryExportSnapshot('react_bundle'), true);
  assert.equal(supportsRuntimeGeneratedExportSnapshots('html5'), false);
  assert.equal(supportsRuntimeGeneratedExportSnapshots('markdown'), false);
  assert.equal(supportsRuntimeGeneratedExportSnapshots('unknown'), false);
});

void test('artifact renderer preview lifecycle capabilities are owned by the artifact contract', () => {
  assert.equal(supportsStreamingArtifactPreview('html5'), true);
  assert.equal(supportsStreamingArtifactPreview('react_bundle'), false);
  assert.equal(usesHookManagedArtifactPreview('react_bundle'), true);
  assert.equal(usesHookManagedArtifactPreview('html5'), false);
  assert.equal(usesHookManagedArtifactPreview('unknown'), false);
});

void test('artifact renderer runtime preview capabilities are owned by the artifact contract', () => {
  assert.equal(isRuntimeArtifactPreviewRenderer('html5'), true);
  assert.equal(isRuntimeArtifactPreviewRenderer('js'), true);
  assert.equal(isRuntimeArtifactPreviewRenderer('react_bundle'), true);
  assert.equal(isRuntimeArtifactPreviewRenderer('markdown'), false);
  assert.equal(isRuntimeArtifactPreviewRenderer('unknown'), false);
  assert.equal(isRuntimeArtifactPreviewRenderer(null), false);
});
