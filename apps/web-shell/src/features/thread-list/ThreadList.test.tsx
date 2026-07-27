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

void test('the icon-only import control keeps its name and still says when it is working', () => {
  // 글자를 글리프로 바꾸면 화면에서 이름이 사라진다. 이름은 접근성 표면으로
  // 옮겨가야 하고, "진행 중"이라는 사실도 함께 남아야 한다 — 비활성만으로는
  // 눌리지 않는 이유가 진행 중인지 쓸 수 없는지 구분되지 않는다.
  function renderImportButton(importing: boolean) {
    return renderToStaticMarkup(
      <ThreadList
        threads={[]}
        selectedThreadId={null}
        importingThreadArchive={importing}
        onLoad={() => {}}
        onSelect={() => {}}
        onDeleteRequest={() => {}}
        onImport={() => {}}
      />,
    );
  }

  const idle = renderImportButton(false);
  assert.match(idle, /aria-label="대화 가져오기"[^>]*>⤓</u);
  assert.doesNotMatch(idle, /is-busy/);

  const busy = renderImportButton(true);
  assert.match(busy, /aria-label="대화 가져오는 중"/u);
  assert.match(busy, /aria-busy="true"/u);
  assert.match(busy, /class="thread-import-button is-busy"/u);
});

void test('ThreadList exposes user-named conversation import and export actions without archive parsing', async () => {
  const threadId = brandThreadId('00000000-0000-4000-8000-000000000001');
  const exportedThreadIds: string[] = [];
  const importedArchives: Blob[] = [];
  const archive = new Blob(['opaque archive']);
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(
      <ThreadList
        threads={[
          {
            threadId,
            title: 'Portable conversation',
            lastUpdated: '2026-07-27T00:00:00.000Z',
            messageCount: 2,
          },
        ]}
        selectedThreadId={threadId}
        transferNotice="대화를 가져왔습니다."
        onLoad={() => {}}
        onSelect={() => {}}
        onDeleteRequest={() => {}}
        onExport={(selectedThreadId) => {
          exportedThreadIds.push(selectedThreadId);
        }}
        onImport={(selectedArchive) => {
          importedArchives.push(selectedArchive);
        }}
      />,
    );
  });

  try {
    assert.equal(
      renderer.root.findByProps({ role: 'status' }).children.join(''),
      '대화를 가져왔습니다.',
    );

    await act(async () => {
      renderer.root.findByProps({ type: 'file' }).props.onChange({
        currentTarget: {
          files: [archive],
          value: 'selected',
        },
      });
    });
    assert.deepEqual(importedArchives, [archive]);

    act(() => {
      renderer.root
        .findByProps({ 'aria-label': 'Portable conversation 메뉴' })
        .props.onClick();
    });
    const exportButton = renderer.root
      .findByProps({ role: 'menu' })
      .findAllByType('button')
      .find((button) => button.children.join('') === '대화 내보내기…');
    assert.ok(exportButton);
    await act(async () => {
      exportButton.props.onClick();
    });
    assert.deepEqual(exportedThreadIds, [threadId]);
  } finally {
    act(() => renderer.unmount());
  }
});
