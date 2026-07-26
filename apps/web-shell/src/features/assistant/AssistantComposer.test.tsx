import test from 'node:test';
import assert from 'node:assert/strict';
import type { ComponentProps } from 'react';
import TestRenderer, { act, type ReactTestRenderer } from 'react-test-renderer';

import { AssistantComposer as ProductAssistantComposer } from './AssistantComposer.js';
import {
  ComposerMenuButton,
  MenuNavRow,
  MenuOptionRow,
} from './composer-menu-rows.js';
import {
  getImageGenerationModelPref,
  setImageGenerationModelPref,
} from './image-model-prefs.js';
import {
  getVideoGenerationPref,
  setVideoGenerationPref,
} from './video-generation-prefs.js';

(
  globalThis as typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
  }
).IS_REACT_ACT_ENVIRONMENT = true;

type TestAssistantComposerProps = Omit<
  ComponentProps<typeof ProductAssistantComposer>,
  | 'planModeIntensity'
  | 'onPlanModeIntensityChange'
  | 'planModeDepth'
  | 'onPlanModeDepthChange'
> &
  Partial<
    Pick<
      ComponentProps<typeof ProductAssistantComposer>,
      | 'planModeIntensity'
      | 'onPlanModeIntensityChange'
      | 'planModeDepth'
      | 'onPlanModeDepthChange'
    >
  >;

function AssistantComposer({
  planModeIntensity = 'visual',
  onPlanModeIntensityChange = () => {},
  planModeDepth = 'standard',
  onPlanModeDepthChange = () => {},
  ...props
}: TestAssistantComposerProps) {
  return (
    <ProductAssistantComposer
      {...props}
      planModeIntensity={planModeIntensity}
      onPlanModeIntensityChange={onPlanModeIntensityChange}
      planModeDepth={planModeDepth}
      onPlanModeDepthChange={onPlanModeDepthChange}
    />
  );
}

function renderComposer(
  imageProviderConnected: Parameters<
    typeof AssistantComposer
  >[0]['imageProviderConnected'],
  contextUsage?: Parameters<typeof AssistantComposer>[0]['contextUsage'],
) {
  return TestRenderer.create(
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
      onSend={async () => true}
      {...(contextUsage !== undefined ? { contextUsage } : {})}
      {...(imageProviderConnected !== undefined
        ? { imageProviderConnected }
        : {})}
    />,
  );
}

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

void test('context usage ring starts at a zero-percent baseline before the first exact measurement', async () => {
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = renderComposer(undefined);
  });

  const ring = renderer.root.findByProps({ className: 'context-usage-ring' });
  assert.equal(ring.props['data-state'], 'unknown');
  assert.equal(ring.props['data-percentage'], '0');
  assert.equal(ring.props.title, '컨텍스트 0%');

  await act(async () => {
    renderer.unmount();
  });
});

void test('context usage ring shows exact progress toward the compaction threshold', async () => {
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = renderComposer(undefined, {
      state: 'measured',
      quality: 'exact',
      modelId: 'gpt-5.6-sol',
      inputTokens: 122_400,
      contextWindow: 272_000,
      thresholdTokens: 244_800,
      requestBytes: 510_000,
    });
  });

  const ring = renderer.root.findByProps({ className: 'context-usage-ring' });
  assert.equal(ring.props['data-state'], 'measured');
  assert.equal(ring.props['data-percentage'], '50');
  assert.match(ring.props.title, /컨텍스트 50%/u);
  assert.match(ring.props.title, /122,400 \/ 244,800 토큰/u);
  assert.equal(
    ring.findByProps({ className: 'context-usage-ring-value' }).props
      .strokeDashoffset,
    50,
  );

  await act(async () => {
    renderer.unmount();
  });
});

void test('context usage ring labels calibrated request estimates without presenting them as exact', async () => {
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = renderComposer(undefined, {
      state: 'measured',
      quality: 'estimated',
      modelId: 'gpt-5.6-sol',
      inputTokens: 122_400,
      contextWindow: 272_000,
      thresholdTokens: 244_800,
      requestBytes: 510_000,
    });
  });

  const ring = renderer.root.findByProps({ className: 'context-usage-ring' });
  assert.equal(ring.props['data-quality'], 'estimated');
  assert.equal(ring.props['data-percentage'], '50');
  assert.match(ring.props.title, /컨텍스트 추정 50%/u);

  await act(async () => {
    renderer.unmount();
  });
});

void test('context usage ring shows an honest pending state when no calibrated estimate exists', async () => {
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = renderComposer(undefined, {
      state: 'measured',
      quality: 'unknown',
      modelId: 'gpt-5.6-sol',
      requestBytes: 510_000,
    });
  });

  const ring = renderer.root.findByProps({ className: 'context-usage-ring' });
  assert.equal(ring.props['data-state'], 'measured');
  assert.equal(ring.props['data-quality'], 'unknown');
  assert.equal(ring.props['data-percentage'], '0');
  assert.equal(ring.props.title, '컨텍스트 사용량 측정 대기 중');

  await act(async () => {
    renderer.unmount();
  });
});

void test('context usage ring empties only after compaction commit and keeps the prior measurement in its tooltip', async () => {
  const compactedUsage = {
    state: 'compacted',
    quality: 'exact',
    modelId: 'gpt-5.6-sol',
    inputTokens: 244_800,
    contextWindow: 272_000,
    thresholdTokens: 244_800,
    requestBytes: 510_000,
    compactionEntryId: 'compaction-entry-1',
    historyBytesBefore: 65_522,
    historyBytesAfter: 4_003,
  } as const;
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = renderComposer(undefined, compactedUsage);
  });

  const ring = renderer.root.findByProps({ className: 'context-usage-ring' });
  assert.equal(ring.props['data-state'], 'compacted');
  assert.equal(ring.props['data-percentage'], '0');
  assert.equal(
    ring.props.title,
    '컨텍스트 압축 완료 · 직전 100% (244,800 / 244,800 토큰) · 히스토리 65,522 → 4,003 바이트 · 체크포인트 compaction-entry-1',
  );
  assert.doesNotMatch(ring.props.title, /다음 응답/u);
  assert.equal(
    ring.findByProps({ className: 'context-usage-ring-value' }).props
      .strokeDashoffset,
    100,
  );

  await act(async () => {
    renderer.unmount();
  });
});

void test('context usage ring keeps legacy compacted snapshots readable without invented provenance', async () => {
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = renderComposer(undefined, {
      state: 'compacted',
      quality: 'exact',
      modelId: 'gpt-5.6-sol',
      inputTokens: 244_800,
      contextWindow: 272_000,
      thresholdTokens: 244_800,
      requestBytes: 510_000,
    });
  });

  const ring = renderer.root.findByProps({ className: 'context-usage-ring' });
  assert.equal(
    ring.props.title,
    '컨텍스트 압축 완료 · 직전 100% (244,800 / 244,800 토큰)',
  );

  await act(async () => {
    renderer.unmount();
  });
});

type RenderedInstance = ReactTestRenderer['root'];

function instanceText(node: RenderedInstance | string): string {
  if (typeof node === 'string') {
    return node;
  }
  return node.children
    .map((child) => instanceText(child as RenderedInstance | string))
    .join('');
}

function findRowByTitle(renderer: ReactTestRenderer, title: string) {
  return renderer.root
    .findAllByType('button')
    .find((button) => instanceText(button).includes(title));
}

// '이미지 업로드' 옵션 행과 겹치지 않게 내비 행은 클래스로 찾는다
function findImageNavRow(renderer: ReactTestRenderer) {
  return renderer.root
    .findAllByProps({ className: 'context-menu-item menu-nav-row' })
    .find((row) => instanceText(row).includes('이미지'));
}

void test('the reasoning-strength menu owns the Ultra selection', async () => {
  const effortChanges: string[] = [];
  let standardComposer!: ReactTestRenderer;
  await act(async () => {
    standardComposer = TestRenderer.create(
      <AssistantComposer
        isBusy={false}
        isRunning={false}
        permissionMode="basic"
        modelId="grok-4.5"
        reasoningEffort="low"
        serviceTier="standard"
        subagentModelRouting={{ mode: 'auto' }}
        onPermissionModeChange={() => {}}
        planModeRequested={false}
        onPlanModeRequestedChange={() => {}}
        onModelIdChange={() => {}}
        onReasoningEffortChange={(effort) => effortChanges.push(effort)}
        onServiceTierChange={() => {}}
        onSubagentModelRoutingChange={() => {}}
        onCancel={() => {}}
        onSend={async () => true}
      />,
    );
  });

  const standardMenu = standardComposer.root
    .findAllByType(ComposerMenuButton)
    .find((node) => node.props.title === '모델, 사고 강도와 속도');
  assert.ok(standardMenu);
  await act(async () => standardMenu.props.onToggle());
  assert.equal(
    standardComposer.root
      .findAllByType(MenuNavRow)
      .some((row) => row.props.label === '에이전트 모드'),
    false,
  );
  const effortNav = standardComposer.root
    .findAllByType(MenuNavRow)
    .find((row) => row.props.label === '사고 강도');
  assert.ok(effortNav);
  await act(async () => effortNav.props.onClick());
  const ultraRow = standardComposer.root
    .findAllByType(MenuOptionRow)
    .find((row) => row.props.title === 'Ultra');
  assert.ok(ultraRow);
  await act(async () => ultraRow.props.onClick());
  assert.deepEqual(effortChanges, ['ultra']);
  await act(async () => standardComposer.unmount());

  let ultraComposer!: ReactTestRenderer;
  await act(async () => {
    ultraComposer = TestRenderer.create(
      <AssistantComposer
        isBusy={false}
        isRunning={false}
        permissionMode="basic"
        modelId="grok-4.5"
        reasoningEffort="ultra"
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
        onSend={async () => true}
      />,
    );
  });

  const ultraMenu = ultraComposer.root
    .findAllByType(ComposerMenuButton)
    .find((node) => node.props.title === '모델, 사고 강도와 속도');
  assert.ok(ultraMenu);
  assert.equal(ultraMenu.props.label, 'Grok 4.5 Ultra');
  await act(async () => ultraMenu.props.onToggle());
  const ultraEffortNav = ultraComposer.root
    .findAllByType(MenuNavRow)
    .find((row) => row.props.label === '사고 강도');
  assert.ok(ultraEffortNav);
  await act(async () => ultraEffortNav.props.onClick());
  assert.deepEqual(
    ultraComposer.root
      .findAllByType(MenuOptionRow)
      .map((row) => row.props.title),
    ['낮음', '중간', '높음', 'Ultra'],
  );
  const selectedUltraRow = ultraComposer.root
    .findAllByType(MenuOptionRow)
    .find((row) => row.props.title === 'Ultra');
  assert.ok(selectedUltraRow);
  assert.equal(selectedUltraRow.props.description, undefined);
  assert.doesNotMatch(JSON.stringify(ultraComposer.toJSON()), /Ultra는/u);
  await act(async () => ultraComposer.unmount());
});

void test('Ultra shows a fixed child model at its effective catalog maximum', async () => {
  const routingChanges: unknown[] = [];
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(
      <AssistantComposer
        isBusy={false}
        isRunning={false}
        permissionMode="basic"
        modelId="gpt-5.6-sol"
        reasoningEffort="ultra"
        serviceTier="standard"
        subagentModelRouting={{
          mode: 'fixed',
          choice: {
            modelId: 'grok-4.5',
            reasoningEffort: 'low',
          },
        }}
        onPermissionModeChange={() => {}}
        planModeRequested={false}
        onPlanModeRequestedChange={() => {}}
        onModelIdChange={() => {}}
        onReasoningEffortChange={() => {}}
        onServiceTierChange={() => {}}
        onSubagentModelRoutingChange={(routing) => {
          routingChanges.push(routing);
        }}
        onCancel={() => {}}
        onSend={async () => true}
      />,
    );
  });

  const menu = renderer.root
    .findAllByType(ComposerMenuButton)
    .find((node) => node.props.title === '모델, 사고 강도와 속도');
  assert.ok(menu);
  await act(async () => menu.props.onToggle());
  const subagentNav = renderer.root
    .findAllByType(MenuNavRow)
    .find((row) => row.props.label === '서브에이전트');
  assert.ok(subagentNav);
  assert.equal(subagentNav.props.value, 'Grok 4.5 높음 고정');
  await act(async () => subagentNav.props.onClick());

  const effortNav = renderer.root
    .findAllByType(MenuNavRow)
    .find((row) => row.props.label === '고정 모델 사고 강도');
  assert.ok(effortNav);
  assert.equal(effortNav.props.value, '높음');
  await act(async () => effortNav.props.onClick());

  const effortRows = renderer.root.findAllByType(MenuOptionRow);
  assert.deepEqual(
    effortRows.map((row) => ({
      checked: row.props.checked,
      title: row.props.title,
    })),
    [{ checked: true, title: '높음' }],
  );
  assert.doesNotMatch(JSON.stringify(renderer.toJSON()), /Ultra는/u);
  assert.deepEqual(routingChanges, []);
  await act(async () => renderer.unmount());
});

void test('speed is present on the first model-menu render and selects Fast without a loading phase', async () => {
  let selectedServiceTier: string | null = null;
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
        onServiceTierChange={(tier) => {
          selectedServiceTier = tier;
        }}
        onSubagentModelRoutingChange={() => {}}
        onCancel={() => {}}
        onSend={async () => true}
      />,
    );
  });

  const modelButton = renderer.root
    .findAllByType('button')
    .find((candidate) => candidate.props.title === '모델, 사고 강도와 속도');
  assert.ok(modelButton);
  act(() => {
    modelButton.props.onClick({ stopPropagation() {} });
  });

  const navRows = renderer.root.findAllByProps({
    className: 'context-menu-item menu-nav-row',
  });
  const navText = navRows.map((row) => instanceText(row));
  const effortIndex = navText.findIndex((text) => text.includes('사고 강도'));
  const speedIndex = navText.findIndex((text) => text.includes('속도'));
  const subagentIndex = navText.findIndex((text) =>
    text.includes('서브에이전트'),
  );
  assert.equal(speedIndex, effortIndex + 1);
  assert.equal(subagentIndex, speedIndex + 1);
  assert.match(navText[speedIndex] ?? '', /표준/u);

  act(() => {
    navRows[speedIndex]?.props.onClick();
  });
  const fastRow = findRowByTitle(renderer, '빠름');
  assert.ok(fastRow);
  assert.equal(fastRow.props.disabled, false);
  act(() => {
    fastRow.props.onClick();
  });
  assert.equal(selectedServiceTier, 'fast');

  await act(async () => renderer.unmount());
});

void test('model menu returns to its root page when reopened', async () => {
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = renderComposer(undefined);
  });

  const toggleModelMenu = () => {
    const button = renderer.root
      .findAllByType('button')
      .find((candidate) => candidate.props.title === '모델, 사고 강도와 속도');
    assert.ok(button);
    button.props.onClick({ stopPropagation() {} });
  };
  await act(async () => {
    toggleModelMenu();
  });
  const effortNav = renderer.root
    .findAllByProps({ className: 'context-menu-item menu-nav-row' })
    .find((row) => instanceText(row).includes('사고 강도'));
  assert.ok(effortNav);
  await act(async () => {
    effortNav.props.onClick();
  });
  assert.match(
    JSON.stringify(renderer.toJSON()),
    /더 높은 사고는 더 철저한 응답을 주지만/u,
  );

  await act(async () => {
    toggleModelMenu();
  });
  await act(async () => {
    toggleModelMenu();
  });
  assert.doesNotMatch(
    JSON.stringify(renderer.toJSON()),
    /더 높은 사고는 더 철저한 응답을 주지만/u,
  );
  assert.ok(
    renderer.root
      .findAllByProps({ className: 'menu-option-title' })
      .some((row) => instanceText(row) === 'GPT-5.6 Sol'),
  );

  await act(async () => {
    renderer.unmount();
  });
});

void test('model submenu stays open when its clicked row is replaced before window bubbling', async () => {
  const windowDescriptor = Object.getOwnPropertyDescriptor(
    globalThis,
    'window',
  );
  const elementDescriptor = Object.getOwnPropertyDescriptor(
    globalThis,
    'Element',
  );
  class FakeElement {
    constructor(private readonly menuAnchor = false) {}

    closest() {
      return null;
    }

    matches(selector: string) {
      return selector === '.composer-menu-anchor' && this.menuAnchor;
    }
  }
  type FakeClickEvent = {
    target: FakeElement;
    composedPath: () => FakeElement[];
  };
  let windowClickListener: ((event: FakeClickEvent) => void) | undefined;
  Object.defineProperty(globalThis, 'Element', {
    configurable: true,
    value: FakeElement,
  });
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      addEventListener(
        type: string,
        listener: (event: FakeClickEvent) => void,
      ) {
        if (type === 'click') {
          windowClickListener = listener;
        }
      },
      removeEventListener(
        type: string,
        listener: (event: FakeClickEvent) => void,
      ) {
        if (type === 'click' && windowClickListener === listener) {
          windowClickListener = undefined;
        }
      },
    },
  });

  let renderer!: ReactTestRenderer;
  try {
    await act(async () => {
      renderer = renderComposer(undefined);
    });
    const modelButton = renderer.root
      .findAllByType('button')
      .find((candidate) => candidate.props.title === '모델, 사고 강도와 속도');
    assert.ok(modelButton);
    await act(async () => {
      modelButton.props.onClick({ stopPropagation() {} });
    });
    const effortNav = renderer.root
      .findAllByProps({ className: 'context-menu-item menu-nav-row' })
      .find((row) => instanceText(row).includes('사고 강도'));
    assert.ok(effortNav);
    assert.ok(windowClickListener);

    await act(async () => {
      effortNav.props.onClick();
      windowClickListener?.({
        target: new FakeElement(),
        composedPath: () => [new FakeElement(), new FakeElement(true)],
      });
    });

    assert.match(
      JSON.stringify(renderer.toJSON()),
      /더 높은 사고는 더 철저한 응답을 주지만/u,
    );
  } finally {
    if (renderer !== undefined) {
      await act(async () => renderer.unmount());
    }
    if (windowDescriptor === undefined) {
      Reflect.deleteProperty(globalThis, 'window');
    } else {
      Object.defineProperty(globalThis, 'window', windowDescriptor);
    }
    if (elementDescriptor === undefined) {
      Reflect.deleteProperty(globalThis, 'Element');
    } else {
      Object.defineProperty(globalThis, 'Element', elementDescriptor);
    }
  }
});

void test('plus menu image subpanel selects a default image model with gates applied', async () => {
  setImageGenerationModelPref(null);
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = renderComposer({
      grok_oauth: true,
      openai_codex_direct: true,
    });
  });

  // [+] 열기 → '이미지 시스템 기본값 ›' 내비 행
  const plusToggle = renderer.root.findByProps({ title: '첨부와 도구' });
  await act(async () => {
    plusToggle.findByType('button').props.onClick({ stopPropagation() {} });
  });
  const imageNav = findImageNavRow(renderer);
  assert.ok(imageNav, 'expected 이미지 nav row');
  assert.match(instanceText(imageNav), /시스템 기본값/);
  await act(async () => {
    imageNav.props.onClick();
  });

  // 서브패널: 3종 전부 활성(이미지 2는 S3 라이브 검증 통과로 게이트 해제,
  // 2026-07-13) — '검증 대기'는 더 이상 없어야 한다
  const markup = JSON.stringify(renderer.toJSON());
  assert.match(markup, /그록 퀄리티/);
  assert.doesNotMatch(markup, /검증 대기/);
  const gptRow = findRowByTitle(renderer, '이미지 2');
  assert.ok(gptRow);
  assert.equal(gptRow.props.disabled, false);

  // 그록 퀄리티 선택 → pref 저장 + 알림 + 메뉴 닫힘
  const qualityRow = findRowByTitle(renderer, '그록 퀄리티');
  assert.ok(qualityRow);
  assert.equal(qualityRow.props.disabled, false);
  await act(async () => {
    qualityRow.props.onClick();
  });
  assert.equal(getImageGenerationModelPref(), 'grok-imagine-image-quality');
  const afterSelect = JSON.stringify(renderer.toJSON());
  assert.match(
    afterSelect,
    /기본 이미지 모델을 그록 퀄리티\(으\)로 설정했어요/,
  );
  assert.doesNotMatch(afterSelect, /검증 대기/); // 메뉴 닫힘
  const dismissNotice = renderer.root.findByProps({
    'aria-label': '모델 설정 알림 닫기',
  });
  await act(async () => {
    dismissNotice.props.onClick();
  });
  assert.doesNotMatch(
    JSON.stringify(renderer.toJSON()),
    /기본 이미지 모델을 그록 퀄리티\(으\)로 설정했어요/,
  );

  await act(async () => {
    renderer.unmount();
  });
  setImageGenerationModelPref(null);
});

void test('plus menu image subpanel disables models whose provider is not connected', async () => {
  setImageGenerationModelPref(null);
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = renderComposer({
      grok_oauth: false,
      openai_codex_direct: false,
    });
  });

  const plusToggle = renderer.root.findByProps({ title: '첨부와 도구' });
  await act(async () => {
    plusToggle.findByType('button').props.onClick({ stopPropagation() {} });
  });
  const imageNav = findImageNavRow(renderer);
  assert.ok(imageNav);
  await act(async () => {
    imageNav.props.onClick();
  });

  // 미연결 프로바이더의 모델은 비활성 + 사유 표시(§3, fail-closed 예방선)
  const markup = JSON.stringify(renderer.toJSON());
  assert.match(markup, /AI 제공자 연결 필요/);
  const qualityRow = findRowByTitle(renderer, '그록 퀄리티');
  assert.ok(qualityRow);
  assert.equal(qualityRow.props.disabled, true);

  await act(async () => {
    renderer.unmount();
  });
});

void test('plus menu video row opens the settings popup with detail controls and gates apply', async () => {
  setVideoGenerationPref(null);
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = renderComposer({
      grok_oauth: true,
      openai_codex_direct: true,
    });
  });

  // [+] 열기 → '동영상 시스템 기본값 ›' 행 클릭 = 서브패널이 아니라 팝업
  const plusToggle = renderer.root.findByProps({ title: '첨부와 도구' });
  await act(async () => {
    plusToggle.findByType('button').props.onClick({ stopPropagation() {} });
  });
  const videoNav = renderer.root
    .findAllByProps({ className: 'context-menu-item menu-nav-row' })
    .find((row) => instanceText(row).includes('동영상'));
  assert.ok(videoNav, 'expected 동영상 nav row');
  assert.match(instanceText(videoNav), /시스템 기본값/);
  await act(async () => {
    videoNav.props.onClick();
  });

  const dialog = renderer.root.findByProps({ 'aria-label': '동영상 설정' });
  assert.ok(dialog);
  assert.equal(dialog.props.role, 'dialog');
  assert.equal(dialog.props.onClick, undefined);
  // 게이트 오픈(사용자 결정 2026-07-13) — 모델 행이 선택 가능해야 한다
  const markup = JSON.stringify(renderer.toJSON());
  assert.doesNotMatch(markup, /검증 대기/);
  const modelRow = findRowByTitle(renderer, '그록 비디오 1.5');
  assert.ok(modelRow);
  assert.equal(modelRow.props.disabled, false);
  // 상세 설정: 길이 슬라이더 + 화면비/해상도 칩(실측 폐쇄 집합)
  const slider = renderer.root.findByProps({
    'aria-label': '동영상 길이(초)',
  });
  assert.equal(slider.props.min, 1);
  assert.equal(slider.props.max, 15);
  assert.match(markup, /16:9/);
  assert.match(markup, /1080p/);

  // 모델 사용 선택 + 화면비/해상도 조작 후 저장 → pref에 상세 옵션 반영
  await act(async () => {
    modelRow.props.onClick();
  });
  const ratioChip = renderer.root
    .findAllByType('button')
    .find(
      (button) =>
        button.props.className?.includes('video-settings-chip') &&
        instanceText(button) === '9:16',
    );
  assert.ok(ratioChip);
  await act(async () => {
    ratioChip.props.onClick();
  });
  const resolutionChip = renderer.root
    .findAllByType('button')
    .find(
      (button) =>
        button.props.className?.includes('video-settings-chip') &&
        instanceText(button) === '720p',
    );
  assert.ok(resolutionChip);
  await act(async () => {
    resolutionChip.props.onClick();
  });
  const saveButton = renderer.root.findByProps({
    className: 'video-settings-save',
  });
  await act(async () => {
    saveButton.props.onClick();
  });
  assert.deepEqual(getVideoGenerationPref(), {
    model: 'grok-imagine-video-1.5',
    durationSeconds: 5,
    aspectRatio: '9:16',
    resolution: '720p',
  });
  const afterSave = JSON.stringify(renderer.toJSON());
  assert.match(afterSave, /동영상 설정을 저장했어요/);
  assert.equal(
    renderer.root.findAllByProps({ 'aria-label': '동영상 설정' }).length,
    0,
  );

  await act(async () => {
    renderer.unmount();
  });
  setVideoGenerationPref(null);
});

void test('Qwen is selectable and exposes the unified thinking-only effort ladder', async () => {
  const modelChanges: string[] = [];
  let picker!: ReactTestRenderer;
  await act(async () => {
    picker = TestRenderer.create(
      <AssistantComposer
        isBusy={false}
        isRunning={false}
        permissionMode="basic"
        modelId="gpt-5.6-sol"
        reasoningEffort="high"
        serviceTier="standard"
        subagentModelRouting={{ mode: 'auto' }}
        onPermissionModeChange={() => {}}
        planModeRequested={false}
        onPlanModeRequestedChange={() => {}}
        onModelIdChange={(modelId) => modelChanges.push(modelId)}
        onReasoningEffortChange={() => {}}
        onServiceTierChange={() => {}}
        onSubagentModelRoutingChange={() => {}}
        onCancel={() => {}}
        onSend={async () => true}
      />,
    );
  });
  const pickerMenu = picker.root
    .findAllByType(ComposerMenuButton)
    .find((node) => node.props.title === '모델, 사고 강도와 속도');
  assert.ok(pickerMenu);
  await act(async () => pickerMenu.props.onToggle());
  const qwenRow = picker.root
    .findAllByType(MenuOptionRow)
    .find((row) => row.props.title === 'Qwen3.8 Max Preview');
  assert.ok(qwenRow);
  await act(async () => qwenRow.props.onClick());
  assert.deepEqual(modelChanges, ['qwen3.8-max-preview']);
  await act(async () => picker.unmount());

  const effortChanges: string[] = [];
  let qwenComposer!: ReactTestRenderer;
  await act(async () => {
    qwenComposer = TestRenderer.create(
      <AssistantComposer
        isBusy={false}
        isRunning={false}
        permissionMode="basic"
        modelId="qwen3.8-max-preview"
        reasoningEffort="high"
        serviceTier="standard"
        subagentModelRouting={{ mode: 'auto' }}
        onPermissionModeChange={() => {}}
        planModeRequested={false}
        onPlanModeRequestedChange={() => {}}
        onModelIdChange={() => {}}
        onReasoningEffortChange={(effort) => effortChanges.push(effort)}
        onServiceTierChange={() => {}}
        onSubagentModelRoutingChange={() => {}}
        onCancel={() => {}}
        onSend={async () => true}
      />,
    );
  });
  const qwenMenu = qwenComposer.root
    .findAllByType(ComposerMenuButton)
    .find((node) => node.props.title === '모델, 사고 강도와 속도');
  assert.ok(qwenMenu);

  const openEffortPage = async () => {
    await act(async () => qwenMenu.props.onToggle());
    const effortNav = qwenComposer.root
      .findAllByType(MenuNavRow)
      .find((row) => row.props.label === '사고 강도');
    assert.ok(effortNav);
    await act(async () => effortNav.props.onClick());
  };

  await openEffortPage();
  const effortRows = qwenComposer.root.findAllByType(MenuOptionRow);
  assert.deepEqual(
    effortRows.map((row) => row.props.title),
    ['낮음', '중간', '높음', '매우 높음', '최대', 'Ultra'],
  );
  assert.match(
    JSON.stringify(qwenComposer.toJSON()),
    /필수 사고 모델이며 현재 Token Plan API는 모든 단계에서 사고를 켭니다/,
  );

  for (const title of ['낮음', '매우 높음', '최대']) {
    if (title !== '낮음') {
      await openEffortPage();
    }
    const row = qwenComposer.root
      .findAllByType(MenuOptionRow)
      .find((candidate) => candidate.props.title === title);
    assert.ok(row);
    await act(async () => row.props.onClick());
  }
  assert.deepEqual(effortChanges, ['low', 'xhigh', 'max']);

  await act(async () => qwenComposer.unmount());
});
