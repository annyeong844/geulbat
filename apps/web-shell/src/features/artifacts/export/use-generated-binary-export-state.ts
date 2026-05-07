import { useCallback, useRef, useState } from 'react';
import { isApiError } from '@geulbat/protocol/errors';
import type { FileSaveResponse } from '@geulbat/protocol/files';

import type { GeneratedBinaryExportSnapshot } from '../artifact-types.js';
import {
  FileSaveConflictError,
  replaceBinaryFile,
  saveBinaryFile,
} from '../../../lib/api/files.js';
import { ApiFetchError } from '../../../lib/api/client.js';

interface ArtifactBinaryExportFileApi {
  saveBinaryFile: typeof saveBinaryFile;
  replaceBinaryFile: typeof replaceBinaryFile;
}

interface RememberedGeneratedBinaryExportTarget {
  path: string;
  versionToken: string;
}

export function canOverwriteRememberedGeneratedBinaryExport(args: {
  rememberedTarget: RememberedGeneratedBinaryExportTarget | null;
  targetPath: string;
}): boolean {
  const targetPath = args.targetPath.trim();
  return (
    targetPath.length > 0 &&
    args.rememberedTarget !== null &&
    args.rememberedTarget.versionToken.trim().length > 0 &&
    args.rememberedTarget.path === targetPath
  );
}

export function rememberGeneratedBinaryExportTarget(
  response: Pick<FileSaveResponse, 'path' | 'versionToken'>,
): RememberedGeneratedBinaryExportTarget {
  return {
    path: response.path,
    versionToken: response.versionToken,
  };
}

interface UseGeneratedBinaryExportStateResult {
  generatedBinaryExportSnapshot: GeneratedBinaryExportSnapshot | null;
  rememberedGeneratedBinaryExportTarget: RememberedGeneratedBinaryExportTarget | null;
  generatedBinaryOverwriteArmed: boolean;
  generatedBinaryExportPending: boolean;
  generatedBinaryExportError: string | null;
  onGeneratedBinaryExportSnapshotChange: (
    snapshot: GeneratedBinaryExportSnapshot | null,
  ) => void;
  clearGeneratedBinaryExportSnapshotState: () => void;
  resetGeneratedBinaryExportSessionState: () => void;
  clearGeneratedBinaryExportFormState: () => void;
  handleBinaryExportTargetPathChange: (nextValue: string) => void;
  handleToggleOverwrite: (checked: boolean) => void;
  submitGeneratedBinaryExport: (args: {
    projectId?: string | null;
    targetPath: string;
    onSuccess?: () => void;
  }) => Promise<void>;
}

export function useGeneratedBinaryExportState(args: {
  fileApi?: Partial<ArtifactBinaryExportFileApi>;
}): UseGeneratedBinaryExportStateResult {
  const saveBinaryFileImpl = args.fileApi?.saveBinaryFile ?? saveBinaryFile;
  const replaceBinaryFileImpl =
    args.fileApi?.replaceBinaryFile ?? replaceBinaryFile;

  const [generatedBinaryExportSnapshot, setGeneratedBinaryExportSnapshot] =
    useState<GeneratedBinaryExportSnapshot | null>(null);
  const [
    rememberedGeneratedBinaryExportTarget,
    setRememberedGeneratedBinaryExportTarget,
  ] = useState<RememberedGeneratedBinaryExportTarget | null>(null);
  const [generatedBinaryOverwriteArmed, setGeneratedBinaryOverwriteArmed] =
    useState(false);
  const [generatedBinaryExportPending, setGeneratedBinaryExportPending] =
    useState(false);
  const [generatedBinaryExportError, setGeneratedBinaryExportError] = useState<
    string | null
  >(null);

  const generatedBinaryExportSnapshotRef =
    useRef<GeneratedBinaryExportSnapshot | null>(null);

  const clearGeneratedBinaryExportSnapshotState = useCallback(() => {
    generatedBinaryExportSnapshotRef.current = null;
    setGeneratedBinaryExportSnapshot(null);
    setRememberedGeneratedBinaryExportTarget(null);
    setGeneratedBinaryOverwriteArmed(false);
    setGeneratedBinaryExportError(null);
  }, []);

  const resetGeneratedBinaryExportSessionState = useCallback(() => {
    generatedBinaryExportSnapshotRef.current = null;
    setGeneratedBinaryExportSnapshot(null);
    setRememberedGeneratedBinaryExportTarget(null);
    setGeneratedBinaryOverwriteArmed(false);
    setGeneratedBinaryExportPending(false);
    setGeneratedBinaryExportError(null);
  }, []);

  const clearGeneratedBinaryExportFormState = useCallback(() => {
    setGeneratedBinaryOverwriteArmed(false);
    setGeneratedBinaryExportError(null);
  }, []);

  const onGeneratedBinaryExportSnapshotChange = useCallback(
    (snapshot: GeneratedBinaryExportSnapshot | null) => {
      generatedBinaryExportSnapshotRef.current = snapshot;
      setGeneratedBinaryExportSnapshot(snapshot);
      setRememberedGeneratedBinaryExportTarget(null);
      setGeneratedBinaryOverwriteArmed(false);
      setGeneratedBinaryExportError(null);
    },
    [],
  );

  const handleBinaryExportTargetPathChange = useCallback(
    (nextValue: string) => {
      if (
        !canOverwriteRememberedGeneratedBinaryExport({
          rememberedTarget: rememberedGeneratedBinaryExportTarget,
          targetPath: nextValue,
        })
      ) {
        setGeneratedBinaryOverwriteArmed(false);
      }
      setGeneratedBinaryExportError(null);
    },
    [rememberedGeneratedBinaryExportTarget],
  );

  const handleToggleOverwrite = useCallback((checked: boolean) => {
    setGeneratedBinaryOverwriteArmed(checked);
    setGeneratedBinaryExportError(null);
  }, []);

  const submitGeneratedBinaryExport = useCallback(
    async (submitArgs: {
      projectId?: string | null;
      targetPath: string;
      onSuccess?: () => void;
    }) => {
      const frozenSnapshot = generatedBinaryExportSnapshotRef.current;
      const projectId = submitArgs.projectId;
      const targetPath = submitArgs.targetPath.trim();
      const frozenRememberedTarget = rememberedGeneratedBinaryExportTarget;
      const shouldReplace =
        generatedBinaryOverwriteArmed &&
        canOverwriteRememberedGeneratedBinaryExport({
          rememberedTarget: frozenRememberedTarget,
          targetPath,
        });
      if (!frozenSnapshot || !projectId || !targetPath) {
        return;
      }

      setGeneratedBinaryExportPending(true);
      setGeneratedBinaryExportError(null);
      try {
        const response = shouldReplace
          ? await replaceBinaryFileImpl(
              projectId,
              targetPath,
              frozenSnapshot.blob,
              frozenRememberedTarget!.versionToken,
            )
          : await saveBinaryFileImpl(
              projectId,
              targetPath,
              frozenSnapshot.blob,
            );
        setRememberedGeneratedBinaryExportTarget(
          rememberGeneratedBinaryExportTarget(response),
        );
        setGeneratedBinaryOverwriteArmed(false);
        submitArgs.onSuccess?.();
      } catch (error: unknown) {
        if (error instanceof FileSaveConflictError) {
          setRememberedGeneratedBinaryExportTarget(null);
          setGeneratedBinaryOverwriteArmed(false);
        }
        setGeneratedBinaryExportError(
          describeGeneratedBinaryExportError(error, targetPath),
        );
      } finally {
        setGeneratedBinaryExportPending(false);
      }
    },
    [
      generatedBinaryOverwriteArmed,
      rememberedGeneratedBinaryExportTarget,
      replaceBinaryFileImpl,
      saveBinaryFileImpl,
    ],
  );

  return {
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
  };
}

function describeGeneratedBinaryExportError(
  error: unknown,
  targetPath: string,
): string {
  if (error instanceof ApiFetchError && isApiError(error.bodyJson)) {
    const bodyJson = error.bodyJson;
    return `Unable to export ${targetPath}: ${bodyJson.message}`;
  }
  if (error instanceof Error && error.message.trim()) {
    return `Unable to export ${targetPath}: ${error.message}`;
  }
  return `Unable to export ${targetPath}.`;
}
