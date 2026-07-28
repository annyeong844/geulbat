import assert from 'node:assert/strict';
import test from 'node:test';
import type { ComponentProps } from 'react';
import TestRenderer, {
  act,
  type ReactTestInstance,
  type ReactTestRenderer,
} from 'react-test-renderer';

import { TestAssistantComposer as AssistantComposer } from '../../test-support/assistant-composer-harness.js';

(
  globalThis as typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
  }
).IS_REACT_ACT_ENVIRONMENT = true;

type ComposerProps = ComponentProps<typeof AssistantComposer>;

const DEFAULT_PROPS: ComposerProps = {
  isBusy: false,
  isRunning: false,
  permissionMode: 'basic',
  modelId: 'gpt-5.6-sol',
  reasoningEffort: 'medium',
  serviceTier: 'standard',
  subagentModelRouting: { mode: 'auto' },
  onPermissionModeChange: () => {},
  planModeRequested: false,
  onPlanModeRequestedChange: () => {},
  onModelIdChange: () => {},
  onReasoningEffortChange: () => {},
  onServiceTierChange: () => {},
  onSubagentModelRoutingChange: () => {},
  onCancel: () => {},
  onSend: async () => true,
};

void test('typing slash opens the four native composer commands and filters them', async () => {
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = renderComposer();
  });

  typeIntoComposer(renderer, '/');
  assert.deepEqual(
    renderer.root
      .findAllByProps({ role: 'option' })
      .map((option) => renderedText(option)),
    [
      '목표/goal계속 추구할 목표를 새로 설정합니다',
      '스킬/skills설치된 스킬과 사용 가능한 스킬을 살펴봅니다',
      'MCP/mcpMCP 서버와 연결된 도구를 관리합니다',
      '상태/status대기 중 · 모델, 컨텍스트와 시작 위치를 봅니다',
    ],
  );

  typeIntoComposer(renderer, '/mc');
  assert.deepEqual(
    renderer.root
      .findAllByProps({ role: 'option' })
      .map((option) => renderedText(option)),
    ['MCP/mcpMCP 서버와 연결된 도구를 관리합니다'],
  );

  await act(async () => renderer.unmount());
});

void test('goal selection leaves a writable goal command without sending', async () => {
  let sendCount = 0;
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = renderComposer({
      onSend: async () => {
        sendCount += 1;
        return true;
      },
    });
  });

  typeIntoComposer(renderer, '/');
  await act(() => optionByLabel(renderer.root, '목표').props.onClick());

  assert.equal(composerInput(renderer).props.value, '/goal ');
  assert.equal(sendCount, 0);
  assert.equal(renderer.root.findAllByProps({ role: 'listbox' }).length, 0);
  await act(async () => renderer.unmount());
});

void test('keyboard selection opens the existing skills surface without sending slash text', async () => {
  let openSkillsCount = 0;
  let sendCount = 0;
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = renderComposer({
      onOpenSkills: () => {
        openSkillsCount += 1;
      },
      onSend: async () => {
        sendCount += 1;
        return true;
      },
    });
  });

  typeIntoComposer(renderer, '/');
  pressComposerKey(renderer, 'ArrowDown');
  pressComposerKey(renderer, 'Enter');

  assert.equal(openSkillsCount, 1);
  assert.equal(sendCount, 0);
  assert.equal(composerInput(renderer).props.value, '');
  await act(async () => renderer.unmount());
});

void test('MCP selection opens existing settings and status stays inside the palette', async () => {
  let openMcpCount = 0;
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = renderComposer({
      workingDirectory: '/workspace/geulbat',
      contextUsage: {
        state: 'measured',
        quality: 'exact',
        modelId: 'gpt-5.6-sol',
        inputTokens: 122_400,
        contextWindow: 272_000,
        thresholdTokens: 244_800,
        requestBytes: 510_000,
      },
      onOpenMcpSettings: () => {
        openMcpCount += 1;
      },
    });
  });

  typeIntoComposer(renderer, '/mcp');
  await act(() => optionByLabel(renderer.root, 'MCP').props.onClick());
  assert.equal(openMcpCount, 1);
  assert.equal(composerInput(renderer).props.value, '');

  typeIntoComposer(renderer, '/status');
  await act(() => optionByLabel(renderer.root, '상태').props.onClick());
  const statusDialog = renderer.root.findByProps({
    role: 'dialog',
    'aria-label': '현재 작업 상태',
  });
  assert.match(renderedText(statusDialog), /대기 중/u);
  assert.match(renderedText(statusDialog), /GPT-5\.6 Sol · 사고 중간/u);
  assert.match(renderedText(statusDialog), /컨텍스트 50%/u);
  assert.match(renderedText(statusDialog), /\/workspace\/geulbat/u);

  pressComposerKey(renderer, 'Escape');
  assert.equal(renderer.root.findAllByProps({ role: 'dialog' }).length, 0);
  assert.equal(renderer.root.findAllByProps({ role: 'listbox' }).length, 1);

  pressComposerKey(renderer, 'Escape');
  assert.equal(renderer.root.findAllByProps({ role: 'listbox' }).length, 0);
  await act(async () => renderer.unmount());
});

function renderComposer(overrides: Partial<ComposerProps> = {}) {
  return TestRenderer.create(
    <AssistantComposer {...DEFAULT_PROPS} {...overrides} />,
  );
}

function composerInput(renderer: ReactTestRenderer): ReactTestInstance {
  return renderer.root.findByProps({ name: 'assistant-message' });
}

function typeIntoComposer(renderer: ReactTestRenderer, value: string): void {
  act(() => {
    composerInput(renderer).props.onChange({ target: { value } });
  });
}

function pressComposerKey(renderer: ReactTestRenderer, key: string): void {
  act(() => {
    composerInput(renderer).props.onKeyDown({
      key,
      shiftKey: false,
      nativeEvent: { isComposing: false },
      preventDefault() {},
    });
  });
}

function optionByLabel(
  root: ReactTestInstance,
  label: string,
): ReactTestInstance {
  const option = root
    .findAllByProps({ role: 'option' })
    .find((candidate) => renderedText(candidate).startsWith(label));
  assert.ok(option, `missing slash option: ${label}`);
  return option;
}

function renderedText(node: ReactTestInstance | string): string {
  if (typeof node === 'string') {
    return node;
  }
  return node.children
    .map((child) => renderedText(child as ReactTestInstance | string))
    .join('');
}
