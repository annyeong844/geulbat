import test from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import TestRenderer, { act, type ReactTestRenderer } from 'react-test-renderer';

import { ProjectTree } from './ProjectTree.js';
import { TreeContextMenu } from './TreeContextMenu.js';
import { flattenVisibleTree } from './tree-flatten.js';

const reactActEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};
reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;

void test('ProjectTree renders a visible alert when tree loading fails', () => {
  const html = renderToStaticMarkup(
    <ProjectTree
      tree={[]}
      uiError="Unable to load project files. network down"
      onLoad={() => {}}
      onSelect={() => {}}
      onCreateFile={async () => true}
      onManageEntry={async () => true}
    />,
  );

  assert.match(html, /role="alert"/);
  assert.match(html, /Unable to load project files/);
});

void test('ProjectTree marks the selected file with the active accent', () => {
  const html = renderToStaticMarkup(
    <ProjectTree
      tree={[
        { name: '1장.md', path: '1장.md', type: 'file' },
        { name: '2장.md', path: '2장.md', type: 'file' },
      ]}
      selectedPath="1장.md"
      onLoad={() => {}}
      onSelect={() => {}}
      onCreateFile={async () => true}
      onManageEntry={async () => true}
    />,
  );

  assert.match(html, /tree-node[^"]*active/);
  assert.match(html, /1장\.md/);
  assert.match(html, /role="tree"/);
});

void test('ProjectTree keeps daemon shortcut paths intact and labels the logical computer root truthfully', () => {
  const navigatedPaths: string[] = [];
  let renderer!: ReactTestRenderer;
  withQuietReactTestRenderer(() => {
    act(() => {
      renderer = TestRenderer.create(
        <ProjectTree
          tree={[]}
          browseEnabled
          browsePath="Users/user/Downloads"
          browseStartPath="Users/user"
          browseShortcuts={[
            {
              label: '다운로드',
              path: 'Users/user/Downloads',
            },
          ]}
          onNavigateInto={(path) => navigatedPaths.push(path)}
          onLoad={() => {}}
          onSelect={() => {}}
          onCreateFile={async () => true}
          onManageEntry={async () => true}
        />,
      );
    });

    const downloadButton = renderer.root
      .findAllByType('button')
      .find((button) => button.children.includes('다운로드'));
    assert.ok(downloadButton, 'expected the Downloads shortcut button');
    act(() => {
      downloadButton.props.onClick();
    });
  });

  assert.deepEqual(navigatedPaths, ['Users/user/Downloads']);
  const html = renderToStaticMarkup(
    <ProjectTree
      tree={[]}
      browseEnabled
      browsePath="Users/user/Downloads"
      onLoad={() => {}}
      onSelect={() => {}}
      onCreateFile={async () => true}
      onManageEntry={async () => true}
    />,
  );
  assert.match(html, /컴퓨터 \/ Users\/user\/Downloads/);
  assert.doesNotMatch(html, /C:\//);
  assert.match(html, /<nav class="quick-access"/);
});

void test('TreeContextMenu supports arrow navigation and Escape close', () => {
  let closeCount = 0;
  let renderer!: ReactTestRenderer;
  withQuietReactTestRenderer(() => {
    act(() => {
      renderer = TestRenderer.create(
        <TreeContextMenu
          menu={{
            x: 10,
            y: 20,
            row: {
              node: {
                name: 'chapter.md',
                path: 'chapter.md',
                type: 'file',
              },
              depth: 0,
              isExpanded: false,
            },
          }}
          onClose={() => {
            closeCount += 1;
          }}
          onCreateFile={() => {}}
          onCreateFolder={() => {}}
          onOpenFile={() => {}}
          onRename={() => {}}
          onDelete={() => {}}
          onInsertIntoManuscript={() => {}}
        />,
      );
    });
  });

  const menu = renderer.root.findByProps({ role: 'menu' });
  assert.equal(menu.props.tabIndex, -1);

  const firstItem = { focus() {} };
  let focusedItem: 'second' | null = null;
  const secondItem = { focus: () => (focusedItem = 'second' as const) };
  const originalDocumentDescriptor = Object.getOwnPropertyDescriptor(
    globalThis,
    'document',
  );
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: { activeElement: firstItem },
  });

  try {
    let arrowPrevented = false;
    act(() => {
      menu.props.onKeyDown({
        key: 'ArrowDown',
        preventDefault() {
          arrowPrevented = true;
        },
        currentTarget: {
          querySelectorAll() {
            return [firstItem, secondItem];
          },
        },
      });
    });
    assert.equal(arrowPrevented, true);
    assert.equal(focusedItem, 'second');

    let escapePrevented = false;
    act(() => {
      menu.props.onKeyDown({
        key: 'Escape',
        preventDefault() {
          escapePrevented = true;
        },
      });
    });
    assert.equal(escapePrevented, true);
    assert.equal(closeCount, 1);
  } finally {
    if (originalDocumentDescriptor === undefined) {
      Reflect.deleteProperty(globalThis, 'document');
    } else {
      Object.defineProperty(globalThis, 'document', originalDocumentDescriptor);
    }
    act(() => renderer.unmount());
  }
});

void test('flattenVisibleTree orders folders before files with Korean natural sort', () => {
  const tree = [
    { name: 'hello.txt', path: 'hello.txt', type: 'file' as const },
    { name: '자료', path: '자료', type: 'directory' as const, children: [] },
    { name: '10장.md', path: '10장.md', type: 'file' as const },
    { name: '2장.md', path: '2장.md', type: 'file' as const },
    { name: 'docs', path: 'docs', type: 'directory' as const, children: [] },
  ];

  const names = flattenVisibleTree(tree, new Set()).map((r) => r.node.name);

  // 폴더 먼저, 이후 파일 — ko 로케일은 한글을 라틴보다 앞에, 숫자는 자연 정렬 (2장 < 10장)
  assert.deepEqual(names, ['자료', 'docs', '2장.md', '10장.md', 'hello.txt']);
});

void test('flattenVisibleTree only walks expanded directories', () => {
  const tree = [
    {
      name: '자료',
      path: '자료',
      type: 'directory' as const,
      children: [
        { name: '인물.md', path: '자료/인물.md', type: 'file' as const },
      ],
    },
  ];

  const collapsed = flattenVisibleTree(tree, new Set());
  assert.equal(collapsed.length, 1);

  const expanded = flattenVisibleTree(tree, new Set(['자료']));
  assert.equal(expanded.length, 2);
  assert.equal(expanded[1]?.depth, 1);
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
