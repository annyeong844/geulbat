import test from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';

import { Editor } from './Editor.js';

void test('Editor renders a visible alert when file operations fail', () => {
  const html = renderToStaticMarkup(
    <Editor
      filePath="episodes/ch01.md"
      content="draft"
      isDirty={true}
      saving={false}
      uiError="Unable to save episodes/ch01.md. network down"
      saveConflict={null}
      onChange={() => {}}
      onSave={() => {}}
      onConflictReload={() => {}}
      onConflictForceSave={() => {}}
    />,
  );

  assert.match(html, /role="alert"/);
  assert.match(html, /Unable to save episodes\/ch01\.md/);
});

void test('Editor announces stale-save conflict banners as alerts', () => {
  const html = renderToStaticMarkup(
    <Editor
      filePath="episodes/ch01.md"
      content="draft"
      isDirty={true}
      saving={false}
      uiError={null}
      saveConflict={{
        code: 'conflict_stale_write',
        message: 'stale write',
        path: 'episodes/ch01.md',
        currentVersionToken: 'next-token',
      }}
      onChange={() => {}}
      onSave={() => {}}
      onConflictReload={() => {}}
      onConflictForceSave={() => {}}
    />,
  );

  assert.match(html, /role="alert"/);
  assert.match(html, /aria-live="assertive"/);
  assert.match(html, /Conflict:/);
});
