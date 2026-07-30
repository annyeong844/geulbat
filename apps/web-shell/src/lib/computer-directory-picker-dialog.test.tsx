import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import TestRenderer, { act, type ReactTestRenderer } from 'react-test-renderer';

import { ComputerDirectoryPickerDialog } from './computer-directory-picker-dialog.js';

const reactActEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};
reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;

void test('directory picker uses discovered host locations and the Computer tree API without OS path guesses', async (t) => {
  const originalFetch = globalThis.fetch;
  const requestedPaths: string[] = [];
  globalThis.fetch = async (input) => {
    const url = new URL(String(input), 'http://localhost');
    const path = url.searchParams.get('path') ?? '';
    requestedPaths.push(path);
    return new Response(
      JSON.stringify({
        root: 'computer',
        tree:
          path === 'volumes/archive'
            ? [
                {
                  name: 'projects',
                  path: 'volumes/archive/projects',
                  type: 'directory',
                },
                {
                  name: 'notes.txt',
                  path: 'volumes/archive/notes.txt',
                  type: 'file',
                },
              ]
            : [],
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  let selectedPath: string | null = null;
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(
      <ComputerDirectoryPickerDialog
        title="시작 위치 선택"
        confirmLabel="이 폴더 사용"
        initialPath="home/writer"
        browsePath="home/writer/work"
        browseStartPath="home/writer"
        browseShortcuts={[
          { label: 'Linux', path: '' },
          { label: 'Archive', path: 'volumes/archive' },
        ]}
        onSelect={(path) => {
          selectedPath = path;
        }}
        onClose={() => {}}
      />,
    );
  });

  assert.deepEqual(requestedPaths, ['home/writer']);
  assert.equal(
    renderer.root.findByProps({ role: 'dialog' }).props['aria-labelledby'],
    'computer-directory-picker-title',
  );
  assert.equal(
    renderer.root.findByProps({ id: 'computer-directory-picker-title' })
      .children[0],
    '시작 위치 선택',
  );
  const locationLabels = renderer.root
    .findByProps({ 'aria-label': '컴퓨터 위치' })
    .findAllByType('button')
    .map((button) => button.children.join(''));
  assert.deepEqual(locationLabels, [
    '현재 탐색 위치',
    '홈',
    'Linux',
    'Archive',
  ]);
  assert.equal(
    renderer.root
      .findAllByType('button')
      .some((button) => button.children.join('') === '운영체제 선택기'),
    false,
  );

  const homeBreadcrumb = renderer.root.findByProps({
    'aria-label': '경로로 이동: home',
  });
  await act(async () => {
    homeBreadcrumb.props.onClick();
  });
  assert.deepEqual(requestedPaths, ['home/writer', 'home']);

  const archiveButton = renderer.root
    .findByProps({ 'aria-label': '컴퓨터 위치' })
    .findAllByType('button')
    .find((button) => button.children.join('') === 'Archive');
  assert.ok(archiveButton);
  await act(async () => {
    archiveButton.props.onClick();
  });
  assert.deepEqual(requestedPaths, ['home/writer', 'home', 'volumes/archive']);
  assert.equal(
    renderer.root.findAllByProps({ 'aria-label': '폴더 열기: projects' })
      .length,
    1,
  );
  assert.equal(
    renderer.root.findAllByProps({ 'aria-label': '폴더 열기: notes.txt' })
      .length,
    0,
  );

  await act(async () => {
    renderer.root
      .findAllByType('button')
      .find((button) => button.children.join('') === '이 폴더 사용')
      ?.props.onClick();
  });
  assert.equal(selectedPath, 'volumes/archive');

  await act(async () => renderer.unmount());
});

void test('directory picker retries the current folder after a transient fetch failure', async (t) => {
  const originalFetch = globalThis.fetch;
  const requestedPaths: string[] = [];
  let requestCount = 0;
  globalThis.fetch = async (input) => {
    const url = new URL(String(input), 'http://localhost');
    requestedPaths.push(url.searchParams.get('path') ?? '');
    requestCount += 1;
    if (requestCount === 1) {
      throw new TypeError('Failed to fetch');
    }
    return new Response(
      JSON.stringify({
        root: 'computer',
        tree: [
          {
            name: 'src',
            path: 'home/writer/project/src',
            type: 'directory',
          },
        ],
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(
      <ComputerDirectoryPickerDialog
        title="시작 위치 선택"
        confirmLabel="이 폴더 사용"
        initialPath="home/writer/project"
        browsePath="home/writer/project"
        browseStartPath="home/writer"
        browseShortcuts={[]}
        onSelect={() => {}}
        onClose={() => {}}
      />,
    );
  });

  assert.deepEqual(requestedPaths, ['home/writer/project']);
  assert.equal(
    renderer.root.findByProps({ role: 'alert' }).children.join(''),
    '데몬 연결이 잠시 끊겼습니다. 다시 시도해 주세요.',
  );

  await act(async () => {
    renderer.root
      .findAllByType('button')
      .find((button) => button.children.join('') === '다시 시도')
      ?.props.onClick();
  });

  assert.deepEqual(requestedPaths, [
    'home/writer/project',
    'home/writer/project',
  ]);
  assert.equal(renderer.root.findAllByProps({ role: 'alert' }).length, 0);
  assert.equal(
    renderer.root.findAllByProps({ 'aria-label': '폴더 열기: src' }).length,
    1,
  );
  assert.equal(
    renderer.root
      .findAllByType('button')
      .some((button) => button.children.join('') === '이 폴더 사용'),
    true,
  );

  await act(async () => renderer.unmount());
});

void test('directory picker exposes an optional action that does not select a folder', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ root: 'computer', tree: [] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });

  let cleared = false;
  let selected = false;
  let renderer!: ReactTestRenderer;
  try {
    await act(async () => {
      renderer = TestRenderer.create(
        <ComputerDirectoryPickerDialog
          title="시작 위치 선택"
          confirmLabel="이 폴더 사용"
          clearLabel="작업 폴더 없이 대화"
          initialPath="home/writer"
          browsePath="home/writer"
          browseStartPath="home/writer"
          browseShortcuts={[]}
          onSelect={() => {
            selected = true;
          }}
          onClear={() => {
            cleared = true;
          }}
          onClose={() => {}}
        />,
      );
    });

    await act(async () => {
      renderer.root
        .findAllByType('button')
        .find((button) => button.children.join('') === '작업 폴더 없이 대화')
        ?.props.onClick();
    });

    assert.equal(cleared, true);
    assert.equal(selected, false);
  } finally {
    globalThis.fetch = originalFetch;
    if (renderer !== undefined) {
      await act(async () => renderer.unmount());
    }
  }
});
