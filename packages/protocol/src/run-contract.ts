import type { RunId, ThreadId } from './ids.js';
import { isGoalRef, type GoalRef } from './goal.js';
import { isPermissionMode, type PermissionMode } from './run-approval.js';
import { isThreadId } from './ids.js';
import {
  isApprovedPlanRef,
  isPlanModeDepth,
  isPlanModeIntensity,
  type ApprovedPlanRef,
  type PlanModeDepth,
  type PlanModeIntensity,
} from './planning-workflow.js';
import {
  PROVIDER_AUTH_PROVIDER_IDS,
  type ProviderAuthProviderId,
} from './provider-auth.js';
import {
  hasOnlyKeys,
  isBoolean,
  isNumber,
  isRecord,
  isString,
} from './wire-value-guards.js';

// 사고 수준 — provider의 reasoning effort와 같은 축. 셸과 daemon은 이
// 계약만 공유하고 서로의 구현을 모른다.
export const RUN_REASONING_EFFORTS = [
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
] as const;
export type RunReasoningEffort = (typeof RUN_REASONING_EFFORTS)[number];

export const RUN_REASONING_SELECTIONS = [
  ...RUN_REASONING_EFFORTS,
  'ultra',
] as const;
export type RunReasoningSelection = (typeof RUN_REASONING_SELECTIONS)[number];

export function isRunReasoningSelection(
  value: unknown,
): value is RunReasoningSelection {
  return RUN_REASONING_SELECTIONS.some((selection) => selection === value);
}

export const RUN_SERVICE_TIERS = ['standard', 'fast'] as const;
export type RunServiceTier = (typeof RUN_SERVICE_TIERS)[number];
export const DEFAULT_RUN_SERVICE_TIER =
  'standard' as const satisfies RunServiceTier;

export function isRunServiceTier(value: unknown): value is RunServiceTier {
  return RUN_SERVICE_TIERS.some((tier) => tier === value);
}

export function isRunReasoningEffort(
  value: unknown,
): value is RunReasoningEffort {
  return (RUN_REASONING_EFFORTS as readonly unknown[]).includes(value);
}

export const RUN_PROVIDER_IDS = [
  ...PROVIDER_AUTH_PROVIDER_IDS,
  'qwen_token_plan',
] as const;
export type RunProviderId = (typeof RUN_PROVIDER_IDS)[number];

export function isRunProviderId(value: unknown): value is RunProviderId {
  return (
    typeof value === 'string' &&
    (RUN_PROVIDER_IDS as readonly string[]).includes(value)
  );
}

export const RUN_MODEL_CATALOG = [
  {
    id: 'gpt-5.6-sol',
    label: 'GPT-5.6 Sol',
    providerId: 'openai_codex_direct',
    reasoningEfforts: RUN_REASONING_EFFORTS,
    defaultReasoningEffort: 'medium',
    serviceTiers: RUN_SERVICE_TIERS,
    supportsHostedToolSearch: true,
    supportsGeneratedSdkToolDiscovery: true,
  },
  {
    id: 'gpt-5.6-terra',
    label: 'GPT-5.6 Terra',
    providerId: 'openai_codex_direct',
    reasoningEfforts: RUN_REASONING_EFFORTS,
    defaultReasoningEffort: 'medium',
    serviceTiers: RUN_SERVICE_TIERS,
    supportsHostedToolSearch: true,
    supportsGeneratedSdkToolDiscovery: false,
  },
  {
    id: 'gpt-5.6-luna',
    label: 'GPT-5.6 Luna',
    providerId: 'openai_codex_direct',
    reasoningEfforts: RUN_REASONING_EFFORTS,
    defaultReasoningEffort: 'medium',
    serviceTiers: RUN_SERVICE_TIERS,
    supportsHostedToolSearch: true,
    supportsGeneratedSdkToolDiscovery: false,
  },
  {
    id: 'grok-4.5',
    label: 'Grok 4.5',
    providerId: 'grok_oauth',
    reasoningEfforts: ['low', 'medium', 'high'],
    defaultReasoningEffort: 'high',
    serviceTiers: ['standard'],
    supportsHostedToolSearch: false,
    supportsGeneratedSdkToolDiscovery: false,
  },
  {
    id: 'qwen3.8-max-preview',
    label: 'Qwen3.8 Max Preview',
    providerId: 'qwen_token_plan',
    reasoningEfforts: RUN_REASONING_EFFORTS,
    defaultReasoningEffort: 'high',
    serviceTiers: ['standard'],
    supportsHostedToolSearch: false,
    supportsGeneratedSdkToolDiscovery: false,
  },
] as const satisfies readonly {
  id: string;
  label: string;
  providerId: RunProviderId;
  reasoningEfforts: readonly RunReasoningEffort[];
  defaultReasoningEffort: RunReasoningEffort;
  serviceTiers: readonly RunServiceTier[];
  supportsHostedToolSearch: boolean;
  supportsGeneratedSdkToolDiscovery: boolean;
}[];

type RunModelDescriptor = (typeof RUN_MODEL_CATALOG)[number];
export type RunModelId = RunModelDescriptor['id'];

export const DEFAULT_RUN_MODEL_ID = 'gpt-5.6-sol' as const satisfies RunModelId;

export function isRunModelId(value: unknown): value is RunModelId {
  return RUN_MODEL_CATALOG.some((model) => model.id === value);
}

export function resolveRunModelDescriptor(
  modelId: RunModelId,
): RunModelDescriptor {
  for (const model of RUN_MODEL_CATALOG) {
    if (model.id === modelId) {
      return model;
    }
  }
  throw new Error(`unknown run model '${modelId}'`);
}

export function resolveMaximumReasoningEffort(
  modelId: RunModelId,
): RunReasoningEffort {
  const descriptor = resolveRunModelDescriptor(modelId);
  for (const effort of [...RUN_REASONING_EFFORTS].reverse()) {
    if (
      (descriptor.reasoningEfforts as readonly RunReasoningEffort[]).includes(
        effort,
      )
    ) {
      return effort;
    }
  }
  throw new Error(`run model '${modelId}' has no supported reasoning effort`);
}

export function resolveRunReasoningSelection(
  modelId: RunModelId,
  selection: RunReasoningSelection | undefined,
): {
  reasoningEffort: RunReasoningEffort | undefined;
  ultraReasoning: boolean;
} {
  return selection === 'ultra'
    ? {
        reasoningEffort: resolveMaximumReasoningEffort(modelId),
        ultraReasoning: true,
      }
    : {
        reasoningEffort: selection,
        ultraReasoning: false,
      };
}

// 이미지 생성 모델 카탈로그(image-generation-open §4.0) — 선택 단위는
// "이미지 모델"이고, 모델이 프로바이더(과금 주체·생성 경로)를 함축한다.
// id는 프로바이더의 실제 모델 id를 그대로 쓴다(별칭 계층 없음 — 구식화되면
// 카탈로그 갱신이 곧 마이그레이션이고, 유효하지 않은 id는 fail-closed로
// 명시적 오류가 된다).
export const IMAGE_GENERATION_MODEL_CATALOG = [
  {
    id: 'grok-imagine-image',
    label: '그록',
    providerId: 'grok_oauth',
  },
  {
    id: 'grok-imagine-image-quality',
    label: '그록 퀄리티',
    providerId: 'grok_oauth',
  },
  {
    id: 'gpt-image-2',
    label: '이미지 2',
    providerId: 'openai_codex_direct',
  },
] as const satisfies readonly {
  id: string;
  label: string;
  providerId: ProviderAuthProviderId;
}[];

type ImageGenerationModelDescriptor =
  (typeof IMAGE_GENERATION_MODEL_CATALOG)[number];
export type ImageGenerationModelId = ImageGenerationModelDescriptor['id'];

export function isImageGenerationModelId(
  value: unknown,
): value is ImageGenerationModelId {
  return IMAGE_GENERATION_MODEL_CATALOG.some((model) => model.id === value);
}

export function resolveImageGenerationModelDescriptor(
  modelId: ImageGenerationModelId,
): ImageGenerationModelDescriptor {
  for (const model of IMAGE_GENERATION_MODEL_CATALOG) {
    if (model.id === modelId) {
      return model;
    }
  }
  throw new Error(`unknown image generation model '${modelId}'`);
}

// 동영상 생성 모델 카탈로그(video-generation-open §4.0) — 이미지 카탈로그와
// 별도 상수로 둬서 이미지 피커/prefs에 동영상 모델이 새는 교차 오염을
// 타입 수준에서 차단한다. v1은 1.5 단일 모델(투명 캔버스 브리지가 text
// 발상을 흡수 — §2-(b)/D-V5).
export const VIDEO_GENERATION_MODEL_CATALOG = [
  {
    id: 'grok-imagine-video-1.5',
    label: '그록 비디오 1.5',
    providerId: 'grok_oauth',
    modality: 'video',
  },
] as const satisfies readonly {
  id: string;
  label: string;
  providerId: ProviderAuthProviderId;
  modality: 'video';
}[];

type VideoGenerationModelDescriptor =
  (typeof VIDEO_GENERATION_MODEL_CATALOG)[number];
export type VideoGenerationModelId = VideoGenerationModelDescriptor['id'];

export function isVideoGenerationModelId(
  value: unknown,
): value is VideoGenerationModelId {
  return VIDEO_GENERATION_MODEL_CATALOG.some((model) => model.id === value);
}

export function resolveVideoGenerationModelDescriptor(
  modelId: VideoGenerationModelId,
): VideoGenerationModelDescriptor {
  for (const model of VIDEO_GENERATION_MODEL_CATALOG) {
    if (model.id === modelId) {
      return model;
    }
  }
  throw new Error(`unknown video generation model '${modelId}'`);
}

// 프로바이더 실측 가드(S0/S3 무과금 프로브, 2026-07-13): duration은
// "1~15초", aspect_ratio/resolution은 serde enum 오류로 전량 확인한 폐쇄
// 집합이다. 기본값은 데몬/프로바이더가 소유한다(§4.1 사다리) — 여기는
// 계약 범위만 강제.
export const VIDEO_GENERATION_MIN_DURATION_SECONDS = 1;
export const VIDEO_GENERATION_MAX_DURATION_SECONDS = 15;

export const VIDEO_GENERATION_ASPECT_RATIOS = [
  '1:1',
  '16:9',
  '9:16',
  '4:3',
  '3:4',
  '3:2',
  '2:3',
] as const;

export type VideoGenerationAspectRatio =
  (typeof VIDEO_GENERATION_ASPECT_RATIOS)[number];

export const VIDEO_GENERATION_RESOLUTIONS = ['480p', '720p', '1080p'] as const;

export type VideoGenerationResolution =
  (typeof VIDEO_GENERATION_RESOLUTIONS)[number];

export interface VideoGenerationSettings {
  durationSeconds?: number;
  aspectRatio?: VideoGenerationAspectRatio;
  resolution?: VideoGenerationResolution;
}

export function isVideoGenerationSettings(
  value: unknown,
): value is VideoGenerationSettings {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ['durationSeconds', 'aspectRatio', 'resolution']) &&
    (value.durationSeconds === undefined ||
      (isNumber(value.durationSeconds) &&
        Number.isInteger(value.durationSeconds) &&
        value.durationSeconds >= VIDEO_GENERATION_MIN_DURATION_SECONDS &&
        value.durationSeconds <= VIDEO_GENERATION_MAX_DURATION_SECONDS)) &&
    (value.aspectRatio === undefined ||
      (VIDEO_GENERATION_ASPECT_RATIOS as readonly unknown[]).includes(
        value.aspectRatio,
      )) &&
    (value.resolution === undefined ||
      (VIDEO_GENERATION_RESOLUTIONS as readonly unknown[]).includes(
        value.resolution,
      ))
  );
}

export interface RunSubagentModelChoice {
  modelId: RunModelId;
  reasoningEffort?: RunReasoningEffort;
}

export type RunSubagentModelRouting =
  | { mode: 'auto' }
  | { mode: 'fixed'; choice: RunSubagentModelChoice };

export const DEFAULT_RUN_SUBAGENT_MODEL_ROUTING = {
  mode: 'auto',
} as const satisfies RunSubagentModelRouting;

const SUBAGENT_MODEL_SELECTION_SOURCES = [
  'user_fixed',
  'model_selected',
  'inherited',
] as const;

export type SubagentModelSelectionSource =
  (typeof SUBAGENT_MODEL_SELECTION_SOURCES)[number];

// 사용자 업로드 첨부 — 바이트는 미리 binary-inputs로 스트리밍 업로드하고
// (JSON body 제한 회피), run 시작 요청은 contentRef만 나른다. 모델에게는
// 이미지 입력 블록/파일 본문 블록으로 실제 내용이 전달된다.
export interface RunAttachmentInput {
  name: string;
  contentRef: string;
  mimeType?: string;
}

export interface RunProviderTransitionRecovery {
  sourceModelId: RunModelId;
  sourceReasoningEffort: RunReasoningEffort;
}

export interface RunRequest {
  prompt: string;
  displayPrompt?: string;
  threadId?: ThreadId;
  // Preferred host working directory. Relative paths start from the Computer
  // coordinate base; absolute and parent-relative paths are allowed.
  workingDirectory?: string;
  modelId?: RunModelId;
  currentFile?: string;
  selection?: { startLine: number; endLine: number; text: string };
  allowedPublicToolNames?: string[];
  permissionMode?: PermissionMode;
  // 계획 모드 진입 요청. 상태가 아니라 요청이다 — 활성 워크플로우의 진실
  // 소유자는 daemon이고, 이 필드로 활성 워크플로우를 빠져나갈 수는 없다.
  planModeRequested?: boolean;
  planModeIntensity?: PlanModeIntensity;
  planModeDepth?: PlanModeDepth;
  // 승인된 정확한 계획을 실행하는 새 run의 daemon-issued 참조.
  approvedPlanRef?: ApprovedPlanRef;
  // 명시적인 Goal 시작 요청. 상태 자체는 daemon이 소유하며, 이후 같은
  // 스레드 run은 활성 Goal을 자동으로 이어받는다.
  goalModeRequested?: boolean;
  // daemon이 resume 명령에서 발급한 정확한 Goal 실행 handoff.
  goalRef?: GoalRef;
  // Ultra도 별도 에이전트 모드가 아니라 사고 강도 선택이다. daemon은
  // 선택 모델의 실제 최고 effort로 해석하고 재귀 서브에이전트를 연다.
  reasoningEffort?: RunReasoningSelection;
  // 제품 표면은 표준/빠름을 사용한다. provider wire 값(priority 등)은
  // daemon provider adapter가 소유한다.
  serviceTier?: RunServiceTier;
  // 사용자가 교차 provider 전환 시 허용한 1회 overflow 복구. 대상 모델은
  // modelId가 소유하며, 원문 요청이 실제 context limit에 거절될 때만 쓴다.
  providerTransitionRecovery?: RunProviderTransitionRecovery;
  subagentModelRouting?: RunSubagentModelRouting;
  attachments?: RunAttachmentInput[];
  // 답변 재생성(덮어쓰기) — run 시작 전에 스레드를 마지막 사용자 턴
  // 직전까지 잘라내고 prompt를 그 자리에 다시 기록한다. threadId 필수 의미.
  regenerate?: boolean;
  // UI 발 자동 요청(아티팩트 ♻ 다시 만들기 등) — 사용자 턴은 감사용으로
  // 기록되지만 채팅에는 그리지 않는다 (user metadata.silent로 각인).
  silentPrompt?: boolean;
  // 프레임 발 턴 귀속 (back-channel 설계 보안 체크리스트 "가시성") —
  // request_prompt/티어 B 강등으로 시작된 턴은 user metadata.origin으로
  // 각인되어 채팅에 "아티팩트 발"로 명확히 렌더된다. 은밀한 새 턴 금지.
  promptOrigin?: 'artifact_frame';
  // 사용자가 저장한 기본 이미지 모델(카탈로그 id). 무선택이면 생략 —
  // 데몬 env/내장 기본값은 무선택 상태 전용이다(§4.2 fail-closed).
  imageGenerationModel?: ImageGenerationModelId;
  // 사용자가 저장한 기본 동영상 모델·설정(video-generation-open §4.3).
  // 무선택이면 생략 — 판정·기본값은 데몬 소관(이미지와 같은 규범).
  videoGenerationModel?: VideoGenerationModelId;
  videoGenerationSettings?: VideoGenerationSettings;
}

type RunPromptRefRequest = Omit<RunRequest, 'prompt'> & {
  promptRef: string;
};

export type RunStartRequest = RunRequest | RunPromptRefRequest;

export interface RunPromptInputRefResponse {
  ok: true;
  promptRef: string;
  byteLength: number;
}

/** Payload for the first `run_ack` event in the websocket run channel. */
export interface RunAck {
  runId: RunId;
  threadId: ThreadId;
}

type RunSelection = NonNullable<RunRequest['selection']>;

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(isString);
}

function isNonEmptyString(value: unknown): value is string {
  return isString(value) && value.length > 0;
}

export function isSubagentModelSelectionSource(
  value: unknown,
): value is SubagentModelSelectionSource {
  return (SUBAGENT_MODEL_SELECTION_SOURCES as readonly unknown[]).includes(
    value,
  );
}

function isRunSubagentModelChoice(
  value: unknown,
): value is RunSubagentModelChoice {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ['modelId', 'reasoningEffort']) ||
    !isRunModelId(value.modelId) ||
    (value.reasoningEffort !== undefined &&
      !isRunReasoningEffort(value.reasoningEffort))
  ) {
    return false;
  }
  if (value.reasoningEffort === undefined) {
    return true;
  }
  const descriptor = resolveRunModelDescriptor(value.modelId);
  return (
    descriptor.reasoningEfforts as readonly RunReasoningEffort[]
  ).includes(value.reasoningEffort);
}

export function isRunSubagentModelRouting(
  value: unknown,
): value is RunSubagentModelRouting {
  if (!isRecord(value)) {
    return false;
  }
  if (value.mode === 'auto') {
    return hasOnlyKeys(value, ['mode']);
  }
  return (
    value.mode === 'fixed' &&
    hasOnlyKeys(value, ['mode', 'choice']) &&
    isRunSubagentModelChoice(value.choice)
  );
}

function isRunSelection(value: unknown): value is RunSelection {
  return (
    isRecord(value) &&
    isNumber(value.startLine) &&
    isNumber(value.endLine) &&
    isString(value.text)
  );
}

export function isRunRequest(value: unknown): value is RunRequest {
  return (
    isRecord(value) &&
    value.promptRef === undefined &&
    isString(value.prompt) &&
    isRunRequestBase(value)
  );
}

function isRunPromptRefRequest(value: unknown): value is RunPromptRefRequest {
  return (
    isRecord(value) &&
    value.prompt === undefined &&
    isString(value.promptRef) &&
    value.promptRef.length > 0 &&
    isRunRequestBase(value)
  );
}

export function isRunStartRequest(value: unknown): value is RunStartRequest {
  return isRunRequest(value) || isRunPromptRefRequest(value);
}

export function isRunPromptInputRefResponse(
  value: unknown,
): value is RunPromptInputRefResponse {
  return (
    isRecord(value) &&
    value.ok === true &&
    isString(value.promptRef) &&
    isNumber(value.byteLength)
  );
}

function isRunRequestBase(value: Record<string, unknown>): boolean {
  // run.start selects model, permissions, tools, workspace, and media policy.
  // Treat it as a closed mutation/authority command so misspelled selectors do
  // not disappear while the daemon executes a different intent.
  return (
    hasOnlyKeys(value, [
      'prompt',
      'promptRef',
      'displayPrompt',
      'threadId',
      'workingDirectory',
      'modelId',
      'currentFile',
      'selection',
      'allowedPublicToolNames',
      'permissionMode',
      'planModeRequested',
      'planModeIntensity',
      'planModeDepth',
      'approvedPlanRef',
      'goalModeRequested',
      'goalRef',
      'reasoningEffort',
      'serviceTier',
      'providerTransitionRecovery',
      'subagentModelRouting',
      'attachments',
      'regenerate',
      'silentPrompt',
      'promptOrigin',
      'imageGenerationModel',
      'videoGenerationModel',
      'videoGenerationSettings',
    ]) &&
    (value.displayPrompt === undefined || isString(value.displayPrompt)) &&
    (value.workingDirectory === undefined ||
      isString(value.workingDirectory)) &&
    (value.modelId === undefined || isRunModelId(value.modelId)) &&
    (value.threadId === undefined ||
      (isString(value.threadId) && isThreadId(value.threadId))) &&
    (value.currentFile === undefined || isString(value.currentFile)) &&
    (value.selection === undefined || isRunSelection(value.selection)) &&
    (value.allowedPublicToolNames === undefined ||
      isStringArray(value.allowedPublicToolNames)) &&
    (value.permissionMode === undefined ||
      isPermissionMode(value.permissionMode)) &&
    (value.planModeRequested === undefined ||
      isBoolean(value.planModeRequested)) &&
    (value.planModeIntensity === undefined ||
      isPlanModeIntensity(value.planModeIntensity)) &&
    (value.planModeDepth === undefined ||
      isPlanModeDepth(value.planModeDepth)) &&
    (value.approvedPlanRef === undefined ||
      isApprovedPlanRef(value.approvedPlanRef)) &&
    (value.approvedPlanRef === undefined || value.threadId !== undefined) &&
    (value.goalModeRequested === undefined ||
      isBoolean(value.goalModeRequested)) &&
    (value.goalRef === undefined || isGoalRef(value.goalRef)) &&
    !(
      value.planModeRequested === true && value.approvedPlanRef !== undefined
    ) &&
    !(value.goalModeRequested === true && value.goalRef !== undefined) &&
    (value.planModeIntensity === undefined ||
      value.planModeRequested === true) &&
    (value.planModeDepth === undefined || value.planModeRequested === true) &&
    (value.planModeRequested !== true ||
      (value.planModeIntensity !== undefined &&
        value.planModeDepth !== undefined)) &&
    (value.reasoningEffort === undefined ||
      isRunReasoningSelection(value.reasoningEffort)) &&
    isRunServiceTierSelection(value) &&
    (value.providerTransitionRecovery === undefined ||
      isRunProviderTransitionRecovery(
        value.providerTransitionRecovery,
        value.modelId,
      )) &&
    (value.subagentModelRouting === undefined ||
      isRunSubagentModelRouting(value.subagentModelRouting)) &&
    (value.attachments === undefined ||
      (Array.isArray(value.attachments) &&
        value.attachments.every(isRunAttachmentInput))) &&
    (value.regenerate === undefined || typeof value.regenerate === 'boolean') &&
    (value.silentPrompt === undefined ||
      typeof value.silentPrompt === 'boolean') &&
    (value.promptOrigin === undefined ||
      value.promptOrigin === 'artifact_frame') &&
    // 알 수 없는 이미지 모델 id는 계약 가드에서 거부한다(fail-closed)
    (value.imageGenerationModel === undefined ||
      isImageGenerationModelId(value.imageGenerationModel)) &&
    // 동영상 모델·설정도 동일 규범 — 미지 id/범위 밖 duration 거부
    (value.videoGenerationModel === undefined ||
      isVideoGenerationModelId(value.videoGenerationModel)) &&
    (value.videoGenerationSettings === undefined ||
      isVideoGenerationSettings(value.videoGenerationSettings))
  );
}

function isRunServiceTierSelection(value: Record<string, unknown>): boolean {
  if (value.serviceTier === undefined) {
    return true;
  }
  if (!isRunServiceTier(value.serviceTier)) {
    return false;
  }
  if (value.modelId === undefined) {
    return value.serviceTier === DEFAULT_RUN_SERVICE_TIER;
  }
  if (!isRunModelId(value.modelId)) {
    return false;
  }
  return (
    resolveRunModelDescriptor(value.modelId)
      .serviceTiers as readonly RunServiceTier[]
  ).includes(value.serviceTier);
}

export function isRunProviderTransitionRecovery(
  value: unknown,
  targetModelId: unknown,
): value is RunProviderTransitionRecovery {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ['sourceModelId', 'sourceReasoningEffort']) ||
    !isRunModelId(value.sourceModelId) ||
    !isRunReasoningEffort(value.sourceReasoningEffort) ||
    !isRunModelId(targetModelId)
  ) {
    return false;
  }
  const source = resolveRunModelDescriptor(value.sourceModelId);
  const target = resolveRunModelDescriptor(targetModelId);
  return (
    source.providerId !== target.providerId &&
    (source.reasoningEfforts as readonly RunReasoningEffort[]).includes(
      value.sourceReasoningEffort,
    )
  );
}

function isRunAttachmentInput(value: unknown): value is RunAttachmentInput {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ['name', 'contentRef', 'mimeType']) &&
    isNonEmptyString(value.name) &&
    isNonEmptyString(value.contentRef) &&
    (value.mimeType === undefined || isString(value.mimeType))
  );
}
