import { useCallback, useEffect, useRef, useState } from 'react';
import type { RunRequest } from '@geulbat/protocol/run-contract';

import { deriveArtifactExportModel } from './artifact-export-model.js';
import {
  buildArtifactSessionKey,
  type ArtifactPaneViewModel,
} from '../artifact-pane-view-model.js';
import type {
  GeneratedBinaryExportSnapshot,
  GeneratedTextExportSnapshot,
} from '../artifact-types.js';
import {
  canOverwriteRememberedGeneratedBinaryExport,
  useGeneratedBinaryExportState,
} from './use-generated-binary-export-state.js';

interface UseArtifactExportStateResult {
  exportExpanded: boolean;
  exportTargetPath: string;
  showExport: boolean;
  canOpenExport: boolean;
  canSubmitExport: boolean;
  exportPlaceholder: string;
  exportHint: string;
  generatedBinaryOverwriteArmed: boolean;
  canOfferRememberedBinaryOverwrite: boolean;
  generatedBinaryExportPending: boolean;
  generatedBinaryExportError: string | null;
  handleToggleExport: () => void;
  handleExportChange: (nextValue: string) => void;
  handleExportCancel: () => void;
  handleExportSubmit: () => Promise<void>;
  handleToggleOverwrite: (checked: boolean) => void;
  onGeneratedTextExportSnapshotChange: (
    snapshot: GeneratedTextExportSnapshot | null,
  ) => void;
  onGeneratedBinaryExportSnapshotChange: (
    snapshot: GeneratedBinaryExportSnapshot | null,
  ) => void;
}

export function useArtifactExportState(args: {
  viewModel: ArtifactPaneViewModel;
  isRunning: boolean;
  onStartArtifactRun?: (request: RunRequest) => Promise<void> | void;
  fileApi?: Parameters<typeof useGeneratedBinaryExportState>[0]['fileApi'];
}): UseArtifactExportStateResult {
  const { viewModel, isRunning, onStartArtifactRun, fileApi } = args;
  const artifactSessionKey = buildArtifactSessionKey(viewModel);

  const [exportExpanded, setExportExpanded] = useState(false);
  const [exportTargetPath, setExportTargetPath] = useState('');
  const [generatedTextExportSnapshot, setGeneratedTextExportSnapshot] =
    useState<GeneratedTextExportSnapshot | null>(null);
  const generatedTextExportSnapshotRef =
    useRef<GeneratedTextExportSnapshot | null>(null);
  const {
    generatedBinaryExportSnapshot,
    rememberedGeneratedBinaryExportTarget,
    generatedBinaryOverwriteArmed,
    generatedBinaryExportPending,
    generatedBinaryExportError,
    onGeneratedBinaryExportSnapshotChange,
    clearGeneratedBinaryExportSnapshotState,
    resetGeneratedBinaryExportSessionState,
    clearGeneratedBinaryExportFormState,
    handleBinaryExportTargetPathChange,
    handleToggleOverwrite,
    submitGeneratedBinaryExport,
  } = useGeneratedBinaryExportState(fileApi !== undefined ? { fileApi } : {});

  useEffect(() => {
    setExportExpanded(false);
    setExportTargetPath('');
    generatedTextExportSnapshotRef.current = null;
    setGeneratedTextExportSnapshot(null);
    resetGeneratedBinaryExportSessionState();
  }, [artifactSessionKey, resetGeneratedBinaryExportSessionState]);

  const canOfferRememberedBinaryOverwrite =
    canOverwriteRememberedGeneratedBinaryExport({
      rememberedTarget: rememberedGeneratedBinaryExportTarget,
      targetPath: exportTargetPath,
    });
  const exportModel = deriveArtifactExportModel({
    viewModel,
    isRunning,
    targetPath: exportTargetPath,
    generatedTextExportSnapshot,
    generatedBinaryExportSnapshot,
    generatedBinaryExportPending,
    canOfferRememberedBinaryOverwrite,
    hasStartArtifactRun: !!onStartArtifactRun,
  });

  const handleToggleExport = () => {
    if (!exportModel.canOpenExport) {
      return;
    }
    setExportExpanded((value) => !value);
  };

  const handleExportChange = (nextValue: string) => {
    setExportTargetPath(nextValue);
    handleBinaryExportTargetPathChange(nextValue);
  };

  const handleExportCancel = () => {
    setExportExpanded(false);
    setExportTargetPath('');
    clearGeneratedBinaryExportFormState();
  };

  const handleExportSubmit = async () => {
    if (exportModel.exportMode === 'generated_binary') {
      await submitGeneratedBinaryExport({
        targetPath: exportTargetPath,
        onSuccess: () => {
          setExportExpanded(false);
          setExportTargetPath('');
        },
      });
      return;
    }

    const frozenExportDraft = deriveArtifactExportModel({
      viewModel,
      isRunning,
      targetPath: exportTargetPath,
      generatedTextExportSnapshot: generatedTextExportSnapshotRef.current,
      generatedBinaryExportSnapshot,
      generatedBinaryExportPending,
      canOfferRememberedBinaryOverwrite,
      hasStartArtifactRun: !!onStartArtifactRun,
    }).exportDraft;
    if (!frozenExportDraft) {
      return;
    }
    void onStartArtifactRun?.(frozenExportDraft);
    setExportExpanded(false);
    setExportTargetPath('');
  };

  const handleGeneratedTextExportSnapshotChange = useCallback(
    (snapshot: GeneratedTextExportSnapshot | null) => {
      generatedTextExportSnapshotRef.current = snapshot;
      setGeneratedTextExportSnapshot(snapshot);
      clearGeneratedBinaryExportSnapshotState();
    },
    [clearGeneratedBinaryExportSnapshotState],
  );

  const handleGeneratedBinaryExportSnapshotChange = useCallback(
    (snapshot: GeneratedBinaryExportSnapshot | null) => {
      generatedTextExportSnapshotRef.current = null;
      setGeneratedTextExportSnapshot(null);
      onGeneratedBinaryExportSnapshotChange(snapshot);
    },
    [onGeneratedBinaryExportSnapshotChange],
  );

  return {
    exportExpanded,
    exportTargetPath,
    showExport: exportModel.showExport,
    canOpenExport: exportModel.canOpenExport,
    canSubmitExport: exportModel.canSubmitExport,
    exportPlaceholder: exportModel.exportPlaceholder,
    exportHint: exportModel.exportHint,
    generatedBinaryOverwriteArmed,
    canOfferRememberedBinaryOverwrite,
    generatedBinaryExportPending,
    generatedBinaryExportError,
    handleToggleExport,
    handleExportChange,
    handleExportCancel,
    handleExportSubmit,
    handleToggleOverwrite,
    onGeneratedTextExportSnapshotChange:
      handleGeneratedTextExportSnapshotChange,
    onGeneratedBinaryExportSnapshotChange:
      handleGeneratedBinaryExportSnapshotChange,
  };
}
