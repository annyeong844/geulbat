import type { ConflictStaleWriteError } from '@geulbat/protocol/errors';
import type { FileTreeNode } from '@geulbat/protocol/files';

interface ProjectWorkspaceFilesInput {
  tree: FileTreeNode[];
  treeError: string | null;
  selectedFile: string | null;
  fileContent: string;
  isDirty: boolean;
  saveConflict: ConflictStaleWriteError | null;
  editorError: string | null;
  saving: boolean;
  loadTree: () => Promise<void>;
  openFile: (path: string) => Promise<void>;
  handleContentChange: (content: string) => void;
  handleSave: () => Promise<void>;
  handleConflictReload: () => Promise<void>;
  handleConflictForceSave: () => Promise<void>;
}

type ProjectWorkspaceFilesSource = ProjectWorkspaceFilesInput;

export function createProjectWorkspaceFilesInput(
  files: ProjectWorkspaceFilesSource,
): ProjectWorkspaceFilesInput {
  return {
    tree: files.tree,
    treeError: files.treeError,
    selectedFile: files.selectedFile,
    fileContent: files.fileContent,
    isDirty: files.isDirty,
    saveConflict: files.saveConflict,
    editorError: files.editorError,
    saving: files.saving,
    loadTree: files.loadTree,
    openFile: files.openFile,
    handleContentChange: files.handleContentChange,
    handleSave: files.handleSave,
    handleConflictReload: files.handleConflictReload,
    handleConflictForceSave: files.handleConflictForceSave,
  };
}
