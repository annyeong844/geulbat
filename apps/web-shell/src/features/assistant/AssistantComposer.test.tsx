import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import TestRenderer, { act, type ReactTestRenderer } from 'react-test-renderer';

import {
  findRowByTitle,
  renderComposer,
  TestAssistantComposer as AssistantComposer,
} from '../../test-support/assistant-composer-harness.js';

(
  globalThis as typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
  }
).IS_REACT_ACT_ENVIRONMENT = true;

void test('Escape cancels an active run from the composer without sending', async () => {
  let cancelCount = 0;
  let sendCount = 0;
  let prevented = false;
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(
      <AssistantComposer
        isBusy={false}
        isRunning
        permissionMode="basic"
        modelId="gpt-5.6-sol"
        reasoningEffort="medium"
        serviceTier="standard"
        subagentModelRouting={{ mode: 'auto' }}
        onPermissionModeChange={() => {}}
        planModeRequested={false}
        onPlanModeRequestedChange={() => {}}
        onModelIdChange={() => {}}
        onReasoningEffortChange={() => {}}
        onServiceTierChange={() => {}}
        onSubagentModelRoutingChange={() => {}}
        onCancel={() => {
          cancelCount += 1;
        }}
        onSend={async () => {
          sendCount += 1;
          return true;
        }}
      />,
    );
  });

  await act(async () => {
    renderer.root.findByProps({ name: 'assistant-message' }).props.onKeyDown({
      key: 'Escape',
      shiftKey: false,
      preventDefault() {
        prevented = true;
      },
    });
  });

  assert.equal(prevented, true);
  assert.equal(cancelCount, 1);
  assert.equal(sendCount, 0);
  await act(async () => renderer.unmount());
});

void test('Enter sends the current draft once and clears it after successful handoff', async () => {
  const sent: string[] = [];
  let prevented = false;
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(
      <AssistantComposer
        isBusy={false}
        isRunning={false}
        permissionMode="basic"
        modelId="gpt-5.6-sol"
        reasoningEffort="medium"
        serviceTier="standard"
        subagentModelRouting={{ mode: 'auto' }}
        onPermissionModeChange={() => {}}
        planModeRequested={false}
        onPlanModeRequestedChange={() => {}}
        onModelIdChange={() => {}}
        onReasoningEffortChange={() => {}}
        onServiceTierChange={() => {}}
        onSubagentModelRoutingChange={() => {}}
        onCancel={() => {}}
        onSend={async (input) => {
          sent.push(input);
          return true;
        }}
      />,
    );
  });

  const textarea = renderer.root.findByProps({ name: 'assistant-message' });
  act(() => {
    textarea.props.onChange({ target: { value: '현재 초안을 보내주세요.' } });
  });
  await act(async () => {
    textarea.props.onKeyDown({
      key: 'Enter',
      shiftKey: false,
      nativeEvent: { isComposing: false },
      preventDefault() {
        prevented = true;
      },
    });
  });

  assert.equal(prevented, true);
  assert.deepEqual(sent, ['현재 초안을 보내주세요.']);
  assert.equal(
    renderer.root.findByProps({ name: 'assistant-message' }).props.value,
    '',
  );
  await act(async () => renderer.unmount());
});

void test('/goal becomes visibly recognized only after an objective is present', async () => {
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = renderComposer({});
  });
  const textarea = renderer.root.findByProps({ name: 'assistant-message' });

  act(() => {
    textarea.props.onChange({ target: { value: '/goal' } });
  });
  assert.equal(
    renderer.root.findAllByProps({
      className: 'composer-goal-command-indicator',
    }).length,
    0,
  );

  act(() => {
    textarea.props.onChange({
      target: { value: '/goal package-lock.json 비대화 원인을 정리하기' },
    });
  });
  const indicator = renderer.root.findByProps({
    className: 'composer-goal-command-indicator',
  });
  assert.equal(
    indicator.findByProps({ className: 'composer-goal-command-token' })
      .children[0],
    '/goal',
  );
  assert.match(
    indicator
      .findByProps({ className: 'composer-goal-command-label' })
      .children.join(''),
    /목표로 실행/u,
  );

  await act(async () => renderer.unmount());
});

void test('accepting a follow-up suggestion drafts it without sending and dismisses the suggestion', async () => {
  let dismissCount = 0;
  let sendCount = 0;
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(
      <AssistantComposer
        isBusy={false}
        isRunning={false}
        permissionMode="basic"
        modelId="gpt-5.6-sol"
        reasoningEffort="medium"
        serviceTier="standard"
        subagentModelRouting={{ mode: 'auto' }}
        onPermissionModeChange={() => {}}
        planModeRequested={false}
        onPlanModeRequestedChange={() => {}}
        onModelIdChange={() => {}}
        onReasoningEffortChange={() => {}}
        onServiceTierChange={() => {}}
        onSubagentModelRoutingChange={() => {}}
        onCancel={() => {}}
        onSend={async () => {
          sendCount += 1;
          return true;
        }}
        followupSuggestion="이어서 회귀 테스트를 확인해 주세요."
        onDismissFollowupSuggestion={() => {
          dismissCount += 1;
        }}
      />,
    );
  });

  const suggestion = renderer.root.findByProps({
    className: 'composer-followup-accept',
  });
  await act(async () => suggestion.props.onClick());

  assert.equal(
    renderer.root.findByProps({ name: 'assistant-message' }).props.value,
    '이어서 회귀 테스트를 확인해 주세요.',
  );
  assert.equal(dismissCount, 1);
  assert.equal(sendCount, 0);
  assert.equal(
    renderer.root.findAllByProps({
      className: 'composer-followup-accept',
    }).length,
    0,
  );
  await act(async () => renderer.unmount());
});

void test('creator draft requests preserve existing composer text without auto-sending', async () => {
  let sendCount = 0;
  const baseProps: Omit<
    Parameters<typeof AssistantComposer>[0],
    'draftRequest'
  > = {
    isBusy: false,
    isRunning: false,
    permissionMode: 'basic',
    modelId: 'gpt-5.6-sol',
    reasoningEffort: 'medium',
    serviceTier: 'standard',
    subagentModelRouting: { mode: 'auto' },
    onPermissionModeChange() {},
    planModeRequested: false,
    onPlanModeRequestedChange() {},
    onModelIdChange() {},
    onReasoningEffortChange() {},
    onServiceTierChange() {},
    onSubagentModelRoutingChange() {},
    onCancel() {},
    async onSend() {
      sendCount += 1;
      return true;
    },
  };
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(
      <AssistantComposer
        {...baseProps}
        draftRequest={{ requestId: 1, text: '@plugin_creator' }}
      />,
    );
  });
  assert.equal(
    renderer.root.findByProps({ name: 'assistant-message' }).props.value,
    '@plugin_creator ',
  );
  assert.equal(sendCount, 0);

  act(() => {
    renderer.root.findByProps({ name: 'assistant-message' }).props.onChange({
      target: { value: '자료 정리 도구를 만들고 싶어요.' },
    });
  });
  await act(async () => {
    renderer.update(
      <AssistantComposer
        {...baseProps}
        draftRequest={{ requestId: 2, text: '@skill_creator' }}
      />,
    );
  });
  assert.equal(
    renderer.root.findByProps({ name: 'assistant-message' }).props.value,
    '@skill_creator 자료 정리 도구를 만들고 싶어요.',
  );
  assert.equal(sendCount, 0);

  await act(async () => renderer.unmount());
});

void test('the plus menu opens the start-location picker without changing file authority itself', async () => {
  let openCount = 0;
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(
      <AssistantComposer
        isBusy={false}
        isRunning={false}
        permissionMode="basic"
        modelId="gpt-5.6-sol"
        reasoningEffort="medium"
        serviceTier="standard"
        subagentModelRouting={{ mode: 'auto' }}
        workingDirectory="home/user/old-project"
        browseStartPath="home/user"
        onOpenWorkingDirectoryPicker={() => {
          openCount += 1;
        }}
        onPermissionModeChange={() => {}}
        planModeRequested={false}
        onPlanModeRequestedChange={() => {}}
        onModelIdChange={() => {}}
        onReasoningEffortChange={() => {}}
        onServiceTierChange={() => {}}
        onSubagentModelRoutingChange={() => {}}
        onCancel={() => {}}
        onSend={async () => true}
      />,
    );
  });

  const plusButton = renderer.root
    .findAllByType('button')
    .find((node) => node.props.title === '첨부와 도구');
  assert.ok(plusButton);
  act(() => {
    plusButton.props.onClick();
  });
  const startLocation = renderer.root
    .findAllByProps({ className: 'menu-option-title' })
    .find((node) => node.children.includes('시작 위치'));
  assert.ok(startLocation?.parent?.parent);
  assert.equal(
    startLocation.parent.findByProps({ className: 'menu-option-desc' })
      .children[0],
    'home/user/old-project',
  );
  act(() => {
    startLocation.parent?.parent?.props.onClick();
  });

  assert.equal(openCount, 1);
  assert.equal(renderer.root.findAllByProps({ role: 'menu' }).length, 0);
  await act(async () => renderer.unmount());
});

void test('the start-location row is visibly disabled while the native picker is pending', async () => {
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(
      <AssistantComposer
        isBusy={false}
        isRunning={false}
        permissionMode="basic"
        modelId="gpt-5.6-sol"
        reasoningEffort="medium"
        serviceTier="standard"
        subagentModelRouting={{ mode: 'auto' }}
        workingDirectory="home/user"
        workingDirectorySelectionPending
        onOpenWorkingDirectoryPicker={() => {}}
        onPermissionModeChange={() => {}}
        planModeRequested={false}
        onPlanModeRequestedChange={() => {}}
        onModelIdChange={() => {}}
        onReasoningEffortChange={() => {}}
        onServiceTierChange={() => {}}
        onSubagentModelRoutingChange={() => {}}
        onCancel={() => {}}
        onSend={async () => true}
      />,
    );
  });

  act(() => {
    renderer.root
      .findAllByType('button')
      .find((node) => node.props.title === '첨부와 도구')
      ?.props.onClick();
  });
  const startLocation = renderer.root
    .findAllByType('button')
    .find((node) =>
      node
        .findAllByProps({ className: 'menu-option-title' })
        .some((title) => title.children.includes('시작 위치')),
    );

  assert.ok(startLocation);
  assert.equal(startLocation.props.disabled, true);
  assert.equal(
    startLocation.findByProps({ className: 'menu-option-desc' }).children[0],
    '폴더 선택 창이 열려 있어요',
  );
  await act(async () => renderer.unmount());
});

void test('attachment rows open native pickers directly and close the plus menu first', async () => {
  let fileShowPickerCount = 0;
  let fileClickCount = 0;
  let imageClickCount = 0;
  const fileInput = {
    value: 'previous-file',
    showPicker() {
      fileShowPickerCount += 1;
    },
    click() {
      fileClickCount += 1;
    },
  };
  const imageInput = {
    value: 'previous-image',
    click() {
      imageClickCount += 1;
    },
  };
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(
      <AssistantComposer
        isBusy={false}
        isRunning={false}
        permissionMode="basic"
        modelId="gpt-5.6-sol"
        reasoningEffort="medium"
        serviceTier="standard"
        subagentModelRouting={{ mode: 'auto' }}
        onPermissionModeChange={() => {}}
        planModeRequested={false}
        onPlanModeRequestedChange={() => {}}
        onModelIdChange={() => {}}
        onReasoningEffortChange={() => {}}
        onServiceTierChange={() => {}}
        onSubagentModelRoutingChange={() => {}}
        onUploadFiles={async () => {}}
        onCancel={() => {}}
        onSend={async () => true}
      />,
      {
        createNodeMock(element) {
          const props = element.props;
          if (
            typeof props !== 'object' ||
            props === null ||
            !('name' in props)
          ) {
            return null;
          }
          if (props.name === 'computer-file-upload') {
            return fileInput;
          }
          if (props.name === 'computer-image-upload') {
            return imageInput;
          }
          return null;
        },
      },
    );
  });

  const openPlusMenu = () => {
    const plusButton = renderer.root
      .findAllByType('button')
      .find((node) => node.props.title === '첨부와 도구');
    assert.ok(plusButton);
    plusButton.props.onClick({ stopPropagation() {} });
  };
  await act(async () => openPlusMenu());
  await act(async () =>
    findRowByTitle(renderer, '파일 업로드')?.props.onClick(),
  );
  assert.equal(fileShowPickerCount, 1);
  assert.equal(fileClickCount, 0);
  assert.equal(fileInput.value, '');
  assert.equal(renderer.root.findAllByProps({ role: 'menu' }).length, 0);

  await act(async () => openPlusMenu());
  await act(async () =>
    findRowByTitle(renderer, '이미지 업로드')?.props.onClick(),
  );
  assert.equal(imageClickCount, 1);
  assert.equal(imageInput.value, '');
  assert.equal(renderer.root.findAllByProps({ role: 'menu' }).length, 0);

  await act(async () => renderer.unmount());
});
