import type { ComponentProps } from 'react';
import TestRenderer, { type ReactTestRenderer } from 'react-test-renderer';

import {
  AssistantComposer as ProductAssistantComposer,
  type AssistantComposerControls,
} from '../features/assistant/AssistantComposer.js';

// AssistantComposer 테스트 하네스. AssistantComposer.test.tsx 안의 지역
// 래퍼·조회 헬퍼였고, 테마별 컴포저 테스트로 나눌 때 네 파일이 같은 하네스를
// 쓰도록 여기로 올렸다. 본문은 이동 전과 동일하며 지역 `AssistantComposer`만
// `TestAssistantComposer`로 이름을 바꿨다 — 제품 컴포넌트와 같은 이름을 이
// 모듈이 다시 export하지 않도록. 호출부는 별칭 import로 되돌린다.
type OptionalTestControl =
  | 'planModeIntensity'
  | 'onPlanModeIntensityChange'
  | 'planModeDepth'
  | 'onPlanModeDepthChange';

type TestAssistantComposerProps = Omit<
  ComponentProps<typeof ProductAssistantComposer>,
  'controls'
> &
  Omit<AssistantComposerControls, OptionalTestControl> &
  Partial<Pick<AssistantComposerControls, OptionalTestControl>>;

export function TestAssistantComposer({
  permissionMode,
  onPermissionModeChange,
  planModeRequested,
  onPlanModeRequestedChange,
  planModeIntensity = 'visual',
  onPlanModeIntensityChange = () => {},
  planModeDepth = 'standard',
  onPlanModeDepthChange = () => {},
  modelId,
  onModelIdChange,
  reasoningEffort,
  onReasoningEffortChange,
  serviceTier,
  onServiceTierChange,
  subagentModelRouting,
  onSubagentModelRoutingChange,
  ...props
}: TestAssistantComposerProps) {
  return (
    <ProductAssistantComposer
      {...props}
      controls={{
        permissionMode,
        onPermissionModeChange,
        planModeRequested,
        onPlanModeRequestedChange,
        planModeIntensity,
        onPlanModeIntensityChange,
        planModeDepth,
        onPlanModeDepthChange,
        modelId,
        onModelIdChange,
        reasoningEffort,
        onReasoningEffortChange,
        serviceTier,
        onServiceTierChange,
        subagentModelRouting,
        onSubagentModelRoutingChange,
      }}
    />
  );
}

export function renderComposer(
  imageProviderConnected: Parameters<
    typeof TestAssistantComposer
  >[0]['imageProviderConnected'],
  contextUsage?: Parameters<typeof TestAssistantComposer>[0]['contextUsage'],
) {
  return TestRenderer.create(
    <TestAssistantComposer
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

type RenderedInstance = ReactTestRenderer['root'];

export function instanceText(node: RenderedInstance | string): string {
  if (typeof node === 'string') {
    return node;
  }
  return node.children
    .map((child) => instanceText(child as RenderedInstance | string))
    .join('');
}

export function findRowByTitle(renderer: ReactTestRenderer, title: string) {
  return renderer.root
    .findAllByType('button')
    .find((button) => instanceText(button).includes(title));
}

// '이미지 업로드' 옵션 행과 겹치지 않게 내비 행은 클래스로 찾는다
export function findImageNavRow(renderer: ReactTestRenderer) {
  return renderer.root
    .findAllByProps({ className: 'context-menu-item menu-nav-row' })
    .find((row) => instanceText(row).includes('이미지'));
}
