import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import TestRenderer, { act, type ReactTestRenderer } from 'react-test-renderer';

import { createAssistantProps } from '../../test-support/create-assistant-props.js';
import {
  findButtonByText,
  renderedText,
} from '../../test-support/react-test-queries.js';
import { Assistant } from './Assistant.js';

void test('assistant requests the native folder picker when the user chooses the start location', async () => {
  let chooseCount = 0;
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(
      <Assistant
        {...createAssistantProps({
          workspace: {
            workingDirectory: 'home/user',
            browseStartPath: 'home/user',
            onChooseWorkingDirectory: async () => {
              chooseCount += 1;
            },
          },
        })}
      />,
    );
  });

  const plusButton = renderer.root
    .findAllByType('button')
    .find((button) => button.props.title === '첨부와 도구');
  assert.ok(plusButton);
  act(() => {
    plusButton.props.onClick();
  });

  const startLocation = findButtonByText(renderer, '시작 위치');
  assert.ok(startLocation);
  await act(async () => {
    startLocation.props.onClick();
  });

  assert.equal(chooseCount, 1);
  assert.equal(renderer.root.findAllByProps({ role: 'dialog' }).length, 0);
  await act(async () => renderer.unmount());
});

void test('assistant uses the cross-platform Computer browser for cwd when browse metadata is available', async (t) => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ root: 'computer', tree: [] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  let nativeChooseCount = 0;
  let selectedPath: string | null = null;
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(
      <Assistant
        {...createAssistantProps({
          workspace: {
            workingDirectory: 'home/writer',
            browseEnabled: true,
            browsePath: 'home/writer/projects',
            browseStartPath: 'home/writer',
            browseShortcuts: [
              { label: 'Fedora', path: '' },
              { label: 'Archive', path: 'volumes/archive' },
            ],
            onSelectWorkingDirectory: (path) => {
              selectedPath = path;
            },
            onChooseWorkingDirectory: async () => {
              nativeChooseCount += 1;
            },
          },
        })}
      />,
    );
  });

  const plusButton = renderer.root
    .findAllByType('button')
    .find((button) => button.props.title === '첨부와 도구');
  assert.ok(plusButton);
  act(() => {
    plusButton.props.onClick();
  });
  const startLocation = findButtonByText(renderer, '시작 위치');
  assert.ok(startLocation);
  await act(async () => {
    startLocation.props.onClick();
  });

  assert.equal(renderer.root.findAllByProps({ role: 'dialog' }).length, 1);
  assert.ok(findButtonByText(renderer, 'Fedora'));
  assert.ok(findButtonByText(renderer, 'Archive'));
  assert.equal(nativeChooseCount, 0);

  const useFolder = findButtonByText(renderer, '이 폴더 사용');
  assert.ok(useFolder);
  await act(async () => {
    useFolder.props.onClick();
  });
  assert.equal(selectedPath, 'home/writer');
  assert.equal(renderer.root.findAllByProps({ role: 'dialog' }).length, 0);

  await act(async () => renderer.unmount());
});

void test('assistant can detach the working directory and show chat mode', async (t) => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ root: 'computer', tree: [] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  let selectedPath: string | null = 'home/writer';
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(
      <Assistant
        {...createAssistantProps({
          workspace: {
            workingDirectory: 'home/writer',
            browseEnabled: true,
            browsePath: 'home/writer',
            browseStartPath: 'home/writer',
            browseShortcuts: [],
            onSelectWorkingDirectory: (path) => {
              selectedPath = path;
            },
          },
        })}
      />,
    );
  });

  act(() => {
    renderer.root
      .findAllByType('button')
      .find((button) => button.props.title === '첨부와 도구')
      ?.props.onClick();
  });
  await act(async () => {
    findButtonByText(renderer, '시작 위치')?.props.onClick();
  });

  const noFolder = findButtonByText(renderer, '작업 폴더 없이 대화');
  assert.ok(noFolder);
  await act(async () => {
    noFolder.props.onClick();
  });
  assert.equal(selectedPath, null);
  assert.equal(renderer.root.findAllByProps({ role: 'dialog' }).length, 0);

  await act(async () => {
    renderer.update(
      <Assistant
        {...createAssistantProps({
          workspace: {
            workingDirectory: null,
            browseEnabled: true,
            browsePath: 'home/writer',
            browseStartPath: 'home/writer',
            browseShortcuts: [],
            onSelectWorkingDirectory: (path) => {
              selectedPath = path;
            },
          },
        })}
      />,
    );
  });
  assert.match(renderedText(renderer.root), /작업 폴더 없음/u);

  await act(async () => renderer.unmount());
});

void test('assistant keeps the native picker single-flight until the selection settles', async () => {
  let chooseCount = 0;
  let finishSelection: (() => void) | undefined;
  const selection = new Promise<void>((resolve) => {
    finishSelection = resolve;
  });
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(
      <Assistant
        {...createAssistantProps({
          workspace: {
            workingDirectory: 'home/user',
            browseStartPath: 'home/user',
            onChooseWorkingDirectory: () => {
              chooseCount += 1;
              return selection;
            },
          },
        })}
      />,
    );
  });

  const openPlusMenu = () => {
    renderer.root
      .findAllByType('button')
      .find((button) => button.props.title === '첨부와 도구')
      ?.props.onClick();
  };
  act(openPlusMenu);
  const firstStartLocation = findButtonByText(renderer, '시작 위치');
  assert.ok(firstStartLocation);
  await act(async () => {
    firstStartLocation.props.onClick();
    await Promise.resolve();
  });

  assert.equal(chooseCount, 1);
  act(openPlusMenu);
  const pendingStartLocation = findButtonByText(renderer, '시작 위치');
  assert.ok(pendingStartLocation);
  assert.equal(pendingStartLocation.props.disabled, true);
  assert.match(
    renderedText(pendingStartLocation),
    /폴더 선택 창이 열려 있어요/u,
  );

  if (finishSelection === undefined) {
    throw new Error('selection completion was not captured');
  }
  const completeSelection = finishSelection;
  await act(async () => {
    completeSelection();
    await selection;
  });
  const settledStartLocation = findButtonByText(renderer, '시작 위치');
  assert.ok(settledStartLocation);
  assert.equal(settledStartLocation.props.disabled, false);
  assert.equal(chooseCount, 1);
  await act(async () => renderer.unmount());
});

void test('assistant exposes native folder picker failures without changing the cwd', async () => {
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(
      <Assistant
        {...createAssistantProps({
          workspace: {
            workingDirectory: 'home/user',
            browseStartPath: 'home/user',
            onChooseWorkingDirectory: async () => {
              throw new Error('native dialog unavailable');
            },
          },
        })}
      />,
    );
  });

  act(() => {
    renderer.root
      .findAllByType('button')
      .find((button) => button.props.title === '첨부와 도구')
      ?.props.onClick();
  });
  const startLocation = findButtonByText(renderer, '시작 위치');
  assert.ok(startLocation);
  await act(async () => {
    startLocation.props.onClick();
  });

  assert.match(
    renderer.root.findByProps({ role: 'alert' }).children.join(''),
    /native dialog unavailable/u,
  );
  await act(async () => renderer.unmount());
});
