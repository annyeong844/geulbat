import test from 'node:test';
import assert from 'node:assert/strict';

import { createProjectWorkspaceFilesInput } from './project-workspace-files-input.js';

function createFilesSourceStub() {
  return {
    tree: [{ name: 'draft.md', path: 'draft.md', type: 'file' as const }],
    treeError: 'tree failed',
    selectedFile: 'draft.md',
    fileContent: '# draft',
    isDirty: true,
    saveConflict: null,
    editorError: 'editor failed',
    saving: true,
    loadTree: async () => {},
    openFile: async () => {},
    handleContentChange: () => {},
    handleSave: async () => {},
    handleConflictReload: async () => {},
    handleConflictForceSave: async () => {},
  };
}

void test('createProjectWorkspaceFilesInput preserves the file surface used by workspace shell', () => {
  const files = createFilesSourceStub();
  const input = createProjectWorkspaceFilesInput(files);

  assert.equal(input.tree, files.tree);
  assert.equal(input.treeError, 'tree failed');
  assert.equal(input.selectedFile, 'draft.md');
  assert.equal(input.fileContent, '# draft');
  assert.equal(input.isDirty, true);
  assert.equal(input.saveConflict, null);
  assert.equal(input.editorError, 'editor failed');
  assert.equal(input.saving, true);
  assert.equal(input.loadTree, files.loadTree);
  assert.equal(input.openFile, files.openFile);
  assert.equal(input.handleContentChange, files.handleContentChange);
  assert.equal(input.handleSave, files.handleSave);
  assert.equal(input.handleConflictReload, files.handleConflictReload);
  assert.equal(input.handleConflictForceSave, files.handleConflictForceSave);
});
