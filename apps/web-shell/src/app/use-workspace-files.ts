import { useCallback, useState } from 'react';
import type { ConflictStaleWriteError } from '@geulbat/protocol/errors';
import type { FileTreeNode } from '@geulbat/protocol/files';

import {
  FileSaveConflictError,
  getFileTree,
  readFile,
  saveFile,
} from '../lib/api/files.js';
import { createLogger } from '@geulbat/shared-utils/logger';
import { brandProjectId } from '../lib/id-brand-helpers.js';
import { reportVisibleAppError } from './error-reporting.js';

const logger = createLogger('workspace-files');

interface ReportWorkspaceFileErrorArgs {
  logContext: string;
  visiblePrefix: string;
  error: unknown;
}

function reportWorkspaceFileError({
  logContext,
  visiblePrefix,
  error,
}: ReportWorkspaceFileErrorArgs): string {
  return reportVisibleAppError({
    logger,
    logContext,
    visiblePrefix,
    error,
  });
}

export function useWorkspaceFiles(projectId: string) {
  const [tree, setTree] = useState<FileTreeNode[]>([]);
  const [treeError, setTreeError] = useState<string | null>(null);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [fileContent, setFileContent] = useState('');
  const [fileVersionToken, setFileVersionToken] = useState<string | null>(null);
  const [isDirty, setIsDirty] = useState(false);
  const [saveConflict, setSaveConflict] =
    useState<ConflictStaleWriteError | null>(null);
  const [saving, setSaving] = useState(false);
  const [editorError, setEditorError] = useState<string | null>(null);

  const loadTree = useCallback(async () => {
    try {
      const res = await getFileTree(brandProjectId(projectId));
      setTree(res.tree);
      setTreeError(null);
    } catch (err: unknown) {
      setTreeError(
        reportWorkspaceFileError({
          logContext: 'loadTree failed',
          visiblePrefix: 'Unable to load project files.',
          error: err,
        }),
      );
    }
  }, [projectId]);

  const openFile = useCallback(
    async (path: string) => {
      try {
        const res = await readFile(brandProjectId(projectId), path);
        setSelectedFile(path);
        setFileContent(res.content);
        setFileVersionToken(res.versionToken);
        setIsDirty(false);
        setSaveConflict(null);
        setEditorError(null);
      } catch (err: unknown) {
        setEditorError(
          reportWorkspaceFileError({
            logContext: 'openFile failed',
            visiblePrefix: `Unable to open ${path}.`,
            error: err,
          }),
        );
      }
    },
    [projectId],
  );

  const handleContentChange = useCallback((content: string) => {
    setFileContent(content);
    setIsDirty(true);
    setSaveConflict(null);
    setEditorError(null);
  }, []);

  const handleSave = useCallback(async () => {
    if (!selectedFile || !fileVersionToken || saving) {
      return;
    }

    setSaving(true);
    setSaveConflict(null);
    setEditorError(null);
    try {
      const res = await saveFile(
        brandProjectId(projectId),
        selectedFile,
        fileContent,
        fileVersionToken,
      );
      setFileVersionToken(res.versionToken);
      setIsDirty(false);
    } catch (err: unknown) {
      if (err instanceof FileSaveConflictError) {
        setSaveConflict(err.conflict);
        return;
      }
      setEditorError(
        reportWorkspaceFileError({
          logContext: 'save failed',
          visiblePrefix: `Unable to save ${selectedFile}.`,
          error: err,
        }),
      );
    } finally {
      setSaving(false);
    }
  }, [fileContent, fileVersionToken, projectId, saving, selectedFile]);

  const handleConflictReload = useCallback(async () => {
    if (!selectedFile) {
      return;
    }
    await openFile(selectedFile);
  }, [openFile, selectedFile]);

  const handleConflictForceSave = useCallback(async () => {
    if (!selectedFile || !saveConflict) {
      return;
    }

    setSaving(true);
    setSaveConflict(null);
    setEditorError(null);
    try {
      const res = await saveFile(
        brandProjectId(projectId),
        selectedFile,
        fileContent,
        saveConflict.currentVersionToken,
      );
      setFileVersionToken(res.versionToken);
      setIsDirty(false);
    } catch (err: unknown) {
      setEditorError(
        reportWorkspaceFileError({
          logContext: 'force save failed',
          visiblePrefix: `Unable to force save ${selectedFile}.`,
          error: err,
        }),
      );
    } finally {
      setSaving(false);
    }
  }, [fileContent, projectId, saveConflict, selectedFile]);

  return {
    tree,
    treeError,
    selectedFile,
    fileContent,
    isDirty,
    saveConflict,
    editorError,
    saving,
    loadTree,
    openFile,
    handleContentChange,
    handleSave,
    handleConflictReload,
    handleConflictForceSave,
  };
}
