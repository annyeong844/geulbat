import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import TestRenderer, { act, type ReactTestRenderer } from 'react-test-renderer';

import {
  findRowByTitle,
  instanceText,
  renderComposer,
  TestAssistantComposer as AssistantComposer,
} from '../../test-support/assistant-composer-harness.js';
import {
  ComposerMenuButton,
  MenuNavRow,
  MenuOptionRow,
} from './composer-menu-rows.js';

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
