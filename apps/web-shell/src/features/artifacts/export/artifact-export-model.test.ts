import test from 'node:test';
import assert from 'node:assert/strict';

import { createArtifactPaneViewModel } from '../../../test-support/create-artifact-pane-view-model.js';
import { deriveArtifactExportModel } from './artifact-export-model.js';

void test('deriveArtifactExportModel exposes static markdown exports through a top-level run draft', () => {
  const model = deriveArtifactExportModel({
    viewModel: createArtifactPaneViewModel(),
    isRunning: false,
    targetPath: 'exports/demo.md',
    generatedTextExportSnapshot: null,
    generatedBinaryExportSnapshot: null,
    generatedBinaryExportPending: false,
    canOfferRememberedBinaryOverwrite: false,
    hasStartArtifactRun: true,
  });

  assert.equal(model.exportMode, 'static');
  assert.equal(model.showExport, true);
  assert.equal(model.canOpenExport, true);
  assert.equal(model.canSubmitExport, true);
  assert.equal(model.exportPlaceholder, 'exports/demo.md');
  assert.match(model.exportDraft?.displayPrompt ?? '', /exports\/demo\.md/);
});

void test('deriveArtifactExportModel derives generated text placeholders from runtime snapshots', () => {
  const model = deriveArtifactExportModel({
    viewModel: createArtifactPaneViewModel({
      parsed: {
        kind: 'artifact',
        state: 'completed',
        renderer: 'js',
        digest: 'fixture',
        payload: 'console.log("hello");',
        raw: 'console.log("hello");',
      },
      actions: {
        apply: { visible: false, enabled: false, reason: null },
        export: { visible: false, enabled: false, reason: null },
      },
      sourceRef: {
        filePath: 'notes/demo.js',
      },
    }),
    isRunning: false,
    targetPath: 'exports/preview.html',
    generatedTextExportSnapshot: {
      content: '<section>Hello</section>',
      mimeType: 'text/html',
      fileNameHint: 'preview.html',
    },
    generatedBinaryExportSnapshot: null,
    generatedBinaryExportPending: false,
    canOfferRememberedBinaryOverwrite: false,
    hasStartArtifactRun: true,
  });

  assert.equal(model.exportMode, 'generated_text');
  assert.equal(model.showExport, true);
  assert.equal(model.exportPlaceholder, 'exports/preview.html');
  assert.equal(model.canOpenExport, true);
  assert.equal(model.canSubmitExport, true);
});

void test('deriveArtifactExportModel exposes runtime generated text exports for react bundles through renderer capabilities', () => {
  const model = deriveArtifactExportModel({
    viewModel: createArtifactPaneViewModel({
      parsed: {
        kind: 'artifact',
        state: 'completed',
        renderer: 'react_bundle',
        digest: 'fixture',
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
      },
      actions: {
        apply: { visible: false, enabled: false, reason: null },
        export: { visible: false, enabled: false, reason: null },
      },
      sourceRef: {
        filePath: 'notes/demo-react.json',
      },
    }),
    isRunning: false,
    targetPath: 'exports/preview.html',
    generatedTextExportSnapshot: {
      content: '<section>Hello</section>',
      mimeType: 'text/html',
      fileNameHint: 'preview.html',
    },
    generatedBinaryExportSnapshot: null,
    generatedBinaryExportPending: false,
    canOfferRememberedBinaryOverwrite: false,
    hasStartArtifactRun: true,
  });

  assert.equal(model.exportMode, 'generated_text');
  assert.equal(model.showExport, true);
  assert.equal(model.canOpenExport, true);
  assert.equal(model.canSubmitExport, true);
});

void test('deriveArtifactExportModel uses binary overwrite hint for generated binary exports', () => {
  const model = deriveArtifactExportModel({
    viewModel: createArtifactPaneViewModel({
      parsed: {
        kind: 'artifact',
        state: 'completed',
        renderer: 'js',
        digest: 'fixture',
        payload: 'console.log("hello");',
        raw: 'console.log("hello");',
      },
      actions: {
        apply: { visible: false, enabled: false, reason: null },
        export: { visible: false, enabled: false, reason: null },
      },
      sourceRef: {
        filePath: 'notes/demo.js',
      },
    }),
    isRunning: false,
    targetPath: 'exports/preview.png',
    generatedTextExportSnapshot: null,
    generatedBinaryExportSnapshot: {
      blob: new Blob(['png'], { type: 'image/png' }),
      fileNameHint: 'preview.png',
    },
    generatedBinaryExportPending: false,
    canOfferRememberedBinaryOverwrite: true,
    hasStartArtifactRun: false,
  });

  assert.equal(model.exportMode, 'generated_binary');
  assert.equal(model.canOpenExport, true);
  assert.equal(model.canSubmitExport, true);
  assert.match(model.exportHint, /Enable overwrite explicitly/);
  assert.equal(model.exportDraft, null);
});

void test('deriveArtifactExportModel keeps runtime exports hidden without full artifact session authority', () => {
  const model = deriveArtifactExportModel({
    viewModel: createArtifactPaneViewModel({
      parsed: {
        kind: 'artifact',
        state: 'completed',
        renderer: 'js',
        digest: 'fixture',
        payload: 'console.log("hello");',
        raw: 'console.log("hello");',
      },
      actions: {
        apply: { visible: false, enabled: false, reason: null },
        export: { visible: false, enabled: false, reason: null },
      },
      sourceRef: {
        threadId: null,
        runId: null,
        filePath: 'notes/demo.js',
        messageTimestamp: null,
      },
    }),
    isRunning: false,
    targetPath: 'exports/preview.html',
    generatedTextExportSnapshot: {
      content: '<section>Hello</section>',
      mimeType: 'text/html',
      fileNameHint: 'preview.html',
    },
    generatedBinaryExportSnapshot: null,
    generatedBinaryExportPending: false,
    canOfferRememberedBinaryOverwrite: false,
    hasStartArtifactRun: true,
  });

  assert.equal(model.exportMode, null);
  assert.equal(model.showExport, false);
  assert.equal(model.canOpenExport, false);
  assert.equal(model.canSubmitExport, false);
});

void test('deriveArtifactExportModel keeps generated binary export closed while a host save is pending', () => {
  const model = deriveArtifactExportModel({
    viewModel: createArtifactPaneViewModel({
      parsed: {
        kind: 'artifact',
        state: 'completed',
        renderer: 'js',
        digest: 'fixture',
        payload: 'console.log("hello");',
        raw: 'console.log("hello");',
      },
      actions: {
        apply: { visible: false, enabled: false, reason: null },
        export: { visible: false, enabled: false, reason: null },
      },
      sourceRef: {
        filePath: 'notes/demo.js',
      },
    }),
    isRunning: false,
    targetPath: 'exports/preview.png',
    generatedTextExportSnapshot: null,
    generatedBinaryExportSnapshot: {
      blob: new Blob(['png'], { type: 'image/png' }),
      fileNameHint: 'preview.png',
    },
    generatedBinaryExportPending: true,
    canOfferRememberedBinaryOverwrite: false,
    hasStartArtifactRun: false,
  });

  assert.equal(model.exportMode, 'generated_binary');
  assert.equal(model.showExport, true);
  assert.equal(model.canOpenExport, false);
  assert.equal(model.canSubmitExport, false);
});

void test('deriveArtifactExportModel rejects malformed generated text snapshots instead of surfacing export controls', () => {
  const model = deriveArtifactExportModel({
    viewModel: createArtifactPaneViewModel({
      parsed: {
        kind: 'artifact',
        state: 'completed',
        renderer: 'js',
        digest: 'fixture',
        payload: 'console.log("hello");',
        raw: 'console.log("hello");',
      },
      actions: {
        apply: { visible: false, enabled: false, reason: null },
        export: { visible: false, enabled: false, reason: null },
      },
    }),
    isRunning: false,
    targetPath: 'exports/preview.bad',
    generatedTextExportSnapshot: {
      content: '<section>Hello</section>',
      mimeType: 'application/octet-stream',
      fileNameHint: 'preview.bad',
    } as never,
    generatedBinaryExportSnapshot: null,
    generatedBinaryExportPending: false,
    canOfferRememberedBinaryOverwrite: false,
    hasStartArtifactRun: true,
  });

  assert.equal(model.exportMode, null);
  assert.equal(model.showExport, false);
  assert.equal(model.canOpenExport, false);
  assert.equal(model.canSubmitExport, false);
});
