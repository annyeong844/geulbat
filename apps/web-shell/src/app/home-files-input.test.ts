import test from 'node:test';
import assert from 'node:assert/strict';

import { createHomeFilesInput } from './home-files-input.js';

function createFilesSourceStub() {
  return {
    tree: [{ name: 'draft.md', path: 'draft.md', type: 'file' as const }],
    treeError: 'tree failed',
    browseEnabled: false,
    browsePath: '',
    browseStartPath: '',
    browseShortcuts: [],
    binaryPreview: null,
    extractedDocument: null,
    navigateUp: () => {},
    navigateInto: () => {},
    selectedFile: 'draft.md',
    fileContent: '# draft',
    isDirty: true,
    saveConflict: null,
    editorError: 'editor failed',
    saving: true,
    openingFile: false,
    lastSavedAt: null,
    openFiles: [],
    loadTree: async () => {},
    loadSubtree: async () => {},
    openFile: async () => {},
    activateTab: () => {},
    closeTab: () => {},
    createFile: async () => true,
    manageEntry: async () => true,
    insertFileIntoActiveBuffer: async () => {},
    handleContentChange: () => {},
    handleSave: async () => {},
    handleConflictReload: async () => {},
    handleConflictSaveAsCopy: async () => {},
    inspectCurrentFile: async () => null,
  };
}

void test('createHomeFilesInput preserves the file surface used by Home shell', () => {
  const files = createFilesSourceStub();
  const input = createHomeFilesInput(files);

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
  assert.equal(input.handleConflictSaveAsCopy, files.handleConflictSaveAsCopy);
  assert.equal(input.createFile, files.createFile);
  assert.equal(input.manageEntry, files.manageEntry);
  assert.equal(input.inspectCurrentFile, files.inspectCurrentFile);
});
