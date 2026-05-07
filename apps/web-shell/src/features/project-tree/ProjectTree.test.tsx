import test from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';

import { ProjectTree } from './ProjectTree.js';

void test('ProjectTree renders a visible alert when tree loading fails', () => {
  const html = renderToStaticMarkup(
    <ProjectTree
      tree={[]}
      uiError="Unable to load project files. network down"
      onLoad={() => {}}
      onSelect={() => {}}
    />,
  );

  assert.match(html, /role="alert"/);
  assert.match(html, /Unable to load project files/);
});
