import test from 'node:test';
import assert from 'node:assert/strict';

import { createArtifactPaneViewModel } from '../../../test-support/create-artifact-pane-view-model.js';
import {
  buildArtifactPaneControllerProps,
  type ArtifactPaneControllerExportState,
  type ArtifactPaneControllerPaneState,
} from './controller-model.js';

void test('buildArtifactPaneControllerProps exposes a local direct-save target for completed artifacts', () => {
  const controller = buildArtifactPaneControllerProps({
    label: 'Artifact',
    viewModel: createArtifactPaneViewModel(),
    paneState: createPaneState(),
    exportState: createExportState(),
  });

  assert.notEqual(controller.directSave, null);
  assert.equal(controller.directSave?.defaultPath.includes('.'), true);
  assert.equal(controller.directSave?.payload.trim().length !== 0, true);
});

void test('buildArtifactPaneControllerProps opens export panel from export state', () => {
  const exportState = createExportState({
    exportExpanded: true,
    exportTargetPath: 'exports/demo.md',
    exportPlaceholder: 'exports/demo.md',
    exportHint: 'Export markdown into a workspace file.',
    generatedBinaryExportError: 'export failed',
  });
  const controller = buildArtifactPaneControllerProps({
    label: 'Artifact',
    viewModel: createArtifactPaneViewModel(),
    paneState: createPaneState(),
    exportState,
  });

  assert.equal(controller.headerProps.showExport, true);
  assert.equal(controller.headerProps.exportExpanded, true);
  assert.equal(controller.exportPanelProps?.placeholder, 'exports/demo.md');
  assert.equal(controller.exportPanelProps?.value, 'exports/demo.md');
  assert.equal(
    controller.exportPanelProps?.exportHint,
    'Export markdown into a workspace file.',
  );
  assert.equal(controller.exportPanelProps?.error, 'export failed');
});

void test('buildArtifactPaneControllerProps maps pane state into body props', () => {
  const viewModel = createArtifactPaneViewModel();
  const controller = buildArtifactPaneControllerProps({
    label: 'Artifact',
    viewModel,
    paneState: createPaneState({
      tab: 'source',
      canShowPreview: false,
      runtimeUnavailableMessage: 'Canvas unavailable',
    }),
    exportState: createExportState(),
  });

  assert.equal(controller.exportPanelProps, null);
  assert.equal(controller.bodyProps.parsed, viewModel.parsed);
  assert.equal(controller.bodyProps.tab, 'source');
  assert.equal(controller.bodyProps.canShowPreview, false);
  assert.equal(
    controller.bodyProps.runtimeUnavailableMessage,
    'Canvas unavailable',
  );
});

function createPaneState(
  overrides: Partial<ArtifactPaneControllerPaneState> = {},
): ArtifactPaneControllerPaneState {
  return {
    tab: 'show',
    canShowPreview: true,
    showApply: true,
    canApply: true,
    surfaceStateBadge: null,
    previewSurface: null,
    runtimeUnavailableMessage: null,
    handleSelectTab: () => {},
    handleApply: () => {},
    ...overrides,
  };
}

function createExportState(
  overrides: Partial<ArtifactPaneControllerExportState> = {},
): ArtifactPaneControllerExportState {
  return {
    exportExpanded: false,
    exportTargetPath: '',
    showExport: true,
    canOpenExport: true,
    canSubmitExport: false,
    exportPlaceholder: 'exports/demo.md',
    exportHint: '',
    generatedBinaryOverwriteArmed: false,
    canOfferRememberedBinaryOverwrite: false,
    generatedBinaryExportPending: false,
    generatedBinaryExportError: null,
    handleToggleExport: () => {},
    handleExportChange: () => {},
    handleExportCancel: () => {},
    handleExportSubmit: async () => {},
    handleToggleOverwrite: () => {},
    ...overrides,
  };
}
