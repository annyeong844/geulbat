import {
  isRunModelId,
  resolveRunModelDescriptor,
  type ImageGenerationModelId,
  type RunModelId,
  type RunReasoningEffort,
} from '@geulbat/protocol/run-contract';

// 모델·사고 강도에 대한 작가-facing 문구 — 컴포저 피커와 보조 작업
// 카드/세션 뷰어가 같은 표현을 쓴다.
export const REASONING_EFFORT_LABELS = {
  low: '낮음',
  medium: '중간',
  high: '높음',
  xhigh: '매우 높음',
  max: '최대',
} as const satisfies Record<RunReasoningEffort, string>;

// 이미지 모델 한 줄 소개 — [+] 메뉴 "이미지" 서브패널 행 설명
export const IMAGE_GENERATION_MODEL_TAGLINES = {
  'grok-imagine-image': 'xAI · 빠른 기본 품질',
  'grok-imagine-image-quality': 'xAI · 고품질(권장)',
  'gpt-image-2': 'OpenAI · 텍스트 렌더 강함',
} as const satisfies Record<ImageGenerationModelId, string>;

// 모델 한 줄 소개 — 피커에서 이름 아래 회색 줄로 보인다
export const RUN_MODEL_TAGLINES = {
  'gpt-5.6-sol': '가장 어려운 과제를 위해',
  'gpt-5.6-terra': '일상적인 작업에 가장 효율적',
  'gpt-5.6-luna': '가장 빠른 답변',
  'grok-4.5': '색다른 관점이 필요할 때',
} as const satisfies Record<RunModelId, string>;

export function formatRunModelLabel(modelId: string): string {
  return isRunModelId(modelId)
    ? resolveRunModelDescriptor(modelId).label
    : modelId;
}

// 보조 작업 카드/세션 뷰어용: "GPT-5.6 Luna · 사고 높음"
export function formatSubagentModelMeta(entry: {
  modelId?: string;
  reasoningEffort?: RunReasoningEffort;
}): string | null {
  if (entry.modelId === undefined) {
    return null;
  }
  const label = formatRunModelLabel(entry.modelId);
  return entry.reasoningEffort === undefined
    ? label
    : `${label} · 사고 ${REASONING_EFFORT_LABELS[entry.reasoningEffort]}`;
}
