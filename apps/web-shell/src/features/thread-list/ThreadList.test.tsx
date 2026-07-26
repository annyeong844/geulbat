import test from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import TestRenderer, { act, type ReactTestRenderer } from 'react-test-renderer';

import { ThreadList } from './ThreadList.js';
import { brandThreadId } from '../../lib/id-brand-helpers.js';

(
  globalThis as typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
  }
).IS_REACT_ACT_ENVIRONMENT = true;

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

void test('ThreadList exposes delete through the row menu and forwards the selected thread id', async () => {
  const threadId = brandThreadId('00000000-0000-4000-8000-000000000001');
  const deletedThreadIds: string[] = [];
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(
      <ThreadList
        threads={[
          {
            threadId,
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
        onDeleteRequest={(selectedThreadId) => {
          deletedThreadIds.push(selectedThreadId);
        }}
      />,
    );
  });

  try {
    act(() => {
      renderer.root
        .findByProps({ 'aria-label': 'Draft Thread 메뉴' })
        .props.onClick();
    });
    const deleteButton = renderer.root
      .findByProps({ role: 'menu' })
      .findByType('button');
    assert.equal(deleteButton.findByType('span').children.join(''), '삭제');

    await act(async () => {
      deleteButton.props.onClick();
    });
    assert.deepEqual(deletedThreadIds, [threadId]);
  } finally {
    act(() => renderer.unmount());
  }
});
