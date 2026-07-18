import type { ConflictStaleWriteError } from '@geulbat/protocol/errors';
import type { FileTreeNode } from '@geulbat/protocol/files';

import type { ManageFileOperation } from '../lib/api/files.js';
import type { OpenFileTab } from './use-workspace-files.js';

interface ProjectWorkspaceFilesInput {
  tree: FileTreeNode[];
  treeError: string | null;
  browseEnabled: boolean;
  browsePath: string;
  browseStartPath: string;
  browseShortcuts: Array<{ label: string; path: string }>;
  binaryPreview: {
    path: string;
    kind: 'image' | 'audio' | 'video' | 'unsupported';
    url?: string;
    byteSize?: number;
  } | null;
  extractedDocument: 'docx' | 'xlsx' | 'hwpx' | null;
  navigateUp: () => void;
  navigateInto: (path: string) => void;
  selectedFile: string | null;
  fileContent: string;
  isDirty: boolean;
  saveConflict: ConflictStaleWriteError | null;
  editorError: string | null;
  saving: boolean;
  openingFile: boolean;
  lastSavedAt: number | null;
  openFiles: OpenFileTab[];
  loadTree: () => Promise<void>;
  loadSubtree: (path: string) => Promise<void>;
  openFile: (path: string) => Promise<void>;
  activateTab: (path: string) => void;
  closeTab: (path: string) => void;
  createFile: (path: string) => Promise<boolean>;
  manageEntry: (
    operation: ManageFileOperation,
    path: string,
    destination?: string,
  ) => Promise<boolean>;
  insertFileIntoActiveBuffer: (path: string) => Promise<void>;
  handleContentChange: (content: string) => void;
  handleSave: () => Promise<void>;
  handleConflictReload: () => Promise<void>;
  handleConflictSaveAsCopy: () => Promise<void>;
  inspectCurrentFile: () => Promise<string | null>;
}

type ProjectWorkspaceFilesSource = ProjectWorkspaceFilesInput;

export function createProjectWorkspaceFilesInput(
  files: ProjectWorkspaceFilesSource,
): ProjectWorkspaceFilesInput {
  return {
    tree: files.tree,
    treeError: files.treeError,
    browseEnabled: files.browseEnabled,
    browsePath: files.browsePath,
    browseStartPath: files.browseStartPath,
    browseShortcuts: files.browseShortcuts,
    binaryPreview: files.binaryPreview,
    extractedDocument: files.extractedDocument,
    navigateUp: files.navigateUp,
    navigateInto: files.navigateInto,
    selectedFile: files.selectedFile,
    fileContent: files.fileContent,
    isDirty: files.isDirty,
    saveConflict: files.saveConflict,
    editorError: files.editorError,
    saving: files.saving,
    openingFile: files.openingFile,
    lastSavedAt: files.lastSavedAt,
    openFiles: files.openFiles,
    loadTree: files.loadTree,
    loadSubtree: files.loadSubtree,
    openFile: files.openFile,
    activateTab: files.activateTab,
    closeTab: files.closeTab,
    createFile: files.createFile,
    manageEntry: files.manageEntry,
    insertFileIntoActiveBuffer: files.insertFileIntoActiveBuffer,
    handleContentChange: files.handleContentChange,
    handleSave: files.handleSave,
    handleConflictReload: files.handleConflictReload,
    handleConflictSaveAsCopy: files.handleConflictSaveAsCopy,
    inspectCurrentFile: files.inspectCurrentFile,
  };
}
