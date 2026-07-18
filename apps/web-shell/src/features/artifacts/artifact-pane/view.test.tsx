import test from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';

import { createArtifactPaneViewModel } from '../../../test-support/create-artifact-pane-view-model.js';
import { buildArtifactPaneControllerProps } from './controller-model.js';
import { ArtifactPaneView } from './view.js';

void test('ArtifactPaneView renders artifact-owned pane shell', () => {
  const viewModel = createArtifactPaneViewModel();
  const controllerProps = buildArtifactPaneControllerProps({
    label: 'Artifact',
    viewModel,
    paneState: {
      tab: 'source',
      canShowPreview: true,
      showApply: true,
      canApply: true,
      surfaceStateBadge: null,
      previewSurface: null,
      runtimeUnavailableMessage: null,
      handleSelectTab: () => {},
      handleApply: () => {},
    },
    exportState: {
      exportExpanded: true,
      exportTargetPath: 'exports/demo.md',
      showExport: true,
      canOpenExport: true,
      canSubmitExport: true,
      exportPlaceholder: 'exports/demo.md',
      exportHint: 'Export markdown into a workspace file.',
      generatedBinaryOverwriteArmed: false,
      canOfferRememberedBinaryOverwrite: false,
      generatedBinaryExportPending: false,
      generatedBinaryExportError: null,
      handleToggleExport: () => {},
      handleExportChange: () => {},
      handleExportCancel: () => {},
      handleExportSubmit: async () => {},
      handleToggleOverwrite: () => {},
    },
  });

  const markup = renderToStaticMarkup(
    <ArtifactPaneView {...controllerProps} />,
  );

  assert.match(markup, /Artifact/);
  assert.match(markup, /Export/);
  assert.match(markup, /exports\/demo\.md/);
  assert.match(markup, /# hello/);
});
