import test from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import TestRenderer, { act, type ReactTestRenderer } from 'react-test-renderer';

import { Editor } from './Editor.js';

(
  globalThis as typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
  }
).IS_REACT_ACT_ENVIRONMENT = true;

void test('Editor renders a visible alert when file operations fail', () => {
  const html = renderToStaticMarkup(
    <Editor
      filePath="episodes/ch01.md"
      content="draft"
      isDirty={true}
      saving={false}
      openingFile={false}
      lastSavedAt={null}
      uiError="Unable to save episodes/ch01.md. network down"
      saveConflict={null}
      onChange={() => {}}
      onSave={() => {}}
      onConflictReload={() => {}}
      onConflictSaveAsCopy={() => {}}
      onConflictInspect={async () => null}
    />,
  );

  assert.match(html, /role="alert"/);
  assert.match(html, /Unable to save episodes\/ch01\.md/);
});

void test('Editor announces stale-save conflict with plain-editor-safe actions only', () => {
  const html = renderToStaticMarkup(
    <Editor
      filePath="episodes/ch01.md"
      content="draft"
      isDirty={true}
      saving={false}
      openingFile={false}
      lastSavedAt={null}
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
      onConflictSaveAsCopy={() => {}}
      onConflictInspect={async () => null}
    />,
  );

  assert.match(html, /role="alert"/);
  assert.match(html, /aria-live="assertive"/);
  assert.match(html, /본문이 다른 곳에서 변경되었습니다/);
  assert.match(html, /현재 파일 확인하기/);
  assert.match(html, /내 변경을 사본으로 저장/);
  assert.match(html, /다시 불러오기/);
  // force overwrite 액션은 P7 v1에서 제공하지 않는다 (§10.20)
  assert.doesNotMatch(html, /덮어쓰|force/i);
});

void test('Editor preserves the dirty buffer read-only when the daemon disconnects', () => {
  const html = renderToStaticMarkup(
    <Editor
      filePath="episodes/ch01.md"
      content="draft"
      isDirty={true}
      saving={false}
      openingFile={false}
      lastSavedAt={null}
      uiError={null}
      saveConflict={null}
      readOnly={true}
      onChange={() => {}}
      onSave={() => {}}
      onConflictReload={() => {}}
      onConflictSaveAsCopy={() => {}}
      onConflictInspect={async () => null}
    />,
  );

  assert.match(html, /readonly/i);
  assert.match(html, /읽기 전용/);
  assert.match(html, /저장되지 않은 변경은 화면에 보존/);
  // dirty buffer 내용은 그대로 유지 (§10.33 — silent discard 금지)
  assert.match(html, /draft/);
});

void test('Editor shows the empty pre-workspace state without a file', () => {
  const html = renderToStaticMarkup(
    <Editor
      filePath={null}
      content=""
      isDirty={false}
      saving={false}
      openingFile={false}
      lastSavedAt={null}
      uiError={null}
      saveConflict={null}
      onChange={() => {}}
      onSave={() => {}}
      onConflictReload={() => {}}
      onConflictSaveAsCopy={() => {}}
      onConflictInspect={async () => null}
    />,
  );

  assert.match(html, /파일을 열어 시작하세요/);
});

void test('Editor file tabs use native buttons and move selection with arrow keys', () => {
  const selectedPaths: string[] = [];
  const originalWindowDescriptor = Object.getOwnPropertyDescriptor(
    globalThis,
    'window',
  );
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      addEventListener() {},
      removeEventListener() {},
    },
  });

  let renderer!: ReactTestRenderer;
  try {
    withQuietReactTestRenderer(() => {
      act(() => {
        renderer = TestRenderer.create(
          <Editor
            filePath="episodes/ch01.ts"
            content="draft"
            isDirty={false}
            saving={false}
            openingFile={false}
            lastSavedAt={null}
            uiError={null}
            saveConflict={null}
            openFiles={[
              { path: 'episodes/ch01.ts', isDirty: false },
              { path: 'episodes/ch02.ts', isDirty: true },
            ]}
            onSelectFileTab={(path) => selectedPaths.push(path)}
            onChange={() => {}}
            onSave={() => {}}
            onConflictReload={() => {}}
            onConflictSaveAsCopy={() => {}}
            onConflictInspect={async () => null}
          />,
        );
      });
    });

    const tabs = renderer.root.findAllByProps({ role: 'tab' });
    assert.equal(tabs.length, 2);
    assert.equal(tabs[0]!.type, 'button');
    assert.equal(tabs[0]!.props.tabIndex, 0);
    assert.equal(tabs[1]!.props.tabIndex, -1);

    let prevented = false;
    let focusedIndex: number | null = null;
    act(() => {
      tabs[0]!.props.onKeyDown({
        key: 'ArrowRight',
        preventDefault() {
          prevented = true;
        },
        currentTarget: {
          closest() {
            return {
              querySelectorAll() {
                return [
                  { focus: () => (focusedIndex = 0) },
                  { focus: () => (focusedIndex = 1) },
                ];
              },
            };
          },
        },
      });
    });

    assert.equal(prevented, true);
    assert.deepEqual(selectedPaths, ['episodes/ch02.ts']);
    assert.equal(focusedIndex, 1);
  } finally {
    if (renderer !== undefined) {
      act(() => renderer.unmount());
    }
    if (originalWindowDescriptor === undefined) {
      Reflect.deleteProperty(globalThis, 'window');
    } else {
      Object.defineProperty(globalThis, 'window', originalWindowDescriptor);
    }
  }
});

function withQuietReactTestRenderer(callback: () => void): void {
  const originalConsoleError = console.error;
  console.error = (...args: unknown[]) => {
    if (
      typeof args[0] === 'string' &&
      args[0].includes('react-test-renderer is deprecated')
    ) {
      return;
    }
    originalConsoleError(...args);
  };

  try {
    callback();
  } finally {
    console.error = originalConsoleError;
  }
}
