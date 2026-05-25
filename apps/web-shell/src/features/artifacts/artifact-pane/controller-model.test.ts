import test from 'node:test';
import assert from 'node:assert/strict';

import { createArtifactPaneViewModel } from '../../../test-support/create-artifact-pane-view-model.js';
import {
  buildArtifactPaneControllerProps,
  type ArtifactPaneControllerExportState,
  type ArtifactPaneControllerPaneState,
} from './controller-model.js';

void test('buildArtifactPaneControllerProps exposes open source only with a file path and handler', () => {
  const withoutHandler = buildArtifactPaneControllerProps({
    label: 'Artifact',
    viewModel: createArtifactPaneViewModel(),
    paneState: createPaneState(),
    exportState: createExportState(),
  });

  assert.equal(withoutHandler.headerProps.showOpenSource, false);
  assert.equal(withoutHandler.headerProps.onOpenSource, undefined);

  const openedPaths: string[] = [];
  const withHandler = buildArtifactPaneControllerProps({
    label: 'Artifact',
    viewModel: createArtifactPaneViewModel(),
    paneState: createPaneState(),
    exportState: createExportState(),
    onOpenSource: (path) => {
      openedPaths.push(path);
    },
  });

  assert.equal(withHandler.headerProps.showOpenSource, true);
  void withHandler.headerProps.onOpenSource?.();
  assert.deepEqual(openedPaths, ['notes/demo.md']);
});

void test('buildArtifactPaneControllerProps hides open source when source file path is missing', () => {
  const controller = buildArtifactPaneControllerProps({
    label: 'Artifact',
    viewModel: createArtifactPaneViewModel({
      sourceRef: {
        filePath: null,
      },
    }),
    paneState: createPaneState(),
    exportState: createExportState(),
    onOpenSource: () => {},
  });

  assert.equal(controller.headerProps.showOpenSource, false);
  assert.equal(controller.headerProps.onOpenSource, undefined);
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
      tab: 'raw',
      canShowPreview: false,
      runtimeUnavailableMessage: 'Canvas unavailable',
    }),
    exportState: createExportState(),
  });

  assert.equal(controller.exportPanelProps, null);
  assert.equal(controller.bodyProps.parsed, viewModel.parsed);
  assert.equal(controller.bodyProps.tab, 'raw');
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
    showOpenSource: true,
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
