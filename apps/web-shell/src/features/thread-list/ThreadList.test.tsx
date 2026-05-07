import test from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';

import { ThreadList } from './ThreadList.js';
import { brandProjectId, brandThreadId } from '../../lib/id-brand-helpers.js';

void test('ThreadList renders a visible alert when thread loading fails', () => {
  const html = renderToStaticMarkup(
    <ThreadList
      threads={[]}
      selectedThreadId={null}
      deletingThreadId={null}
      uiError="Unable to load threads. network down"
      onLoad={() => {}}
      onSelect={() => {}}
      onDeleteRequest={() => {}}
    />,
  );

  assert.match(html, /role="alert"/);
  assert.match(html, /Unable to load threads/);
});

void test('ThreadList renders delete action next to thread rows', () => {
  const html = renderToStaticMarkup(
    <ThreadList
      threads={[
        {
          threadId: brandThreadId('00000000-0000-4000-8000-000000000001'),
          projectId: brandProjectId('workspace'),
          title: 'Draft Thread',
          lastUpdated: '2026-03-26T00:00:00.000Z',
          messageCount: 3,
        },
      ]}
      selectedThreadId={null}
      deletingThreadId={null}
      uiError={null}
      onLoad={() => {}}
      onSelect={() => {}}
      onDeleteRequest={() => {}}
    />,
  );

  assert.match(html, /Delete thread Draft Thread/);
  assert.match(html, />Delete</);
});
