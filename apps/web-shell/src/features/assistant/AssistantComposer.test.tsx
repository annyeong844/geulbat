import test from 'node:test';
import assert from 'node:assert/strict';
import TestRenderer, { act, type ReactTestRenderer } from 'react-test-renderer';

import { AssistantComposer } from './AssistantComposer.js';
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
      subagentModelRouting={{ mode: 'auto' }}
      onPermissionModeChange={() => {}}
      onModelIdChange={() => {}}
      onReasoningEffortChange={() => {}}
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
    subagentModelRouting: { mode: 'auto' },
    onPermissionModeChange() {},
    onModelIdChange() {},
    onReasoningEffortChange() {},
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
      modelId: 'gpt-5.6-sol',
      inputTokens: 122_400,
      contextWindow: 272_000,
      thresholdTokens: 244_800,
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

void test('context usage ring empties only after compaction commit and keeps the prior measurement in its tooltip', async () => {
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = renderComposer(undefined, {
      state: 'compacted',
      modelId: 'gpt-5.6-sol',
      inputTokens: 244_800,
      contextWindow: 272_000,
      thresholdTokens: 244_800,
    });
  });

  const ring = renderer.root.findByProps({ className: 'context-usage-ring' });
  assert.equal(ring.props['data-state'], 'compacted');
  assert.equal(ring.props['data-percentage'], '0');
  assert.match(ring.props.title, /컨텍스트 압축 완료 · 직전 100%/u);
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
