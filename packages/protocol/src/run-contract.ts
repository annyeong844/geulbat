import type { RunId, ThreadId } from './ids.js';
import { isPermissionMode, type PermissionMode } from './run-approval.js';
import { isThreadId } from './ids.js';
import type { ProviderAuthProviderId } from './provider-auth.js';
import { isNumber, isRecord, isString } from './runtime-utils.js';

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

export function isRunReasoningEffort(
  value: unknown,
): value is RunReasoningEffort {
  return (RUN_REASONING_EFFORTS as readonly unknown[]).includes(value);
}

export const RUN_MODEL_CATALOG = [
  {
    id: 'gpt-5.6-sol',
    label: 'GPT-5.6 Sol',
    providerId: 'openai_codex_direct',
    reasoningEfforts: RUN_REASONING_EFFORTS,
    defaultReasoningEffort: 'medium',
  },
  {
    id: 'gpt-5.6-terra',
    label: 'GPT-5.6 Terra',
    providerId: 'openai_codex_direct',
    reasoningEfforts: RUN_REASONING_EFFORTS,
    defaultReasoningEffort: 'medium',
  },
  {
    id: 'gpt-5.6-luna',
    label: 'GPT-5.6 Luna',
    providerId: 'openai_codex_direct',
    reasoningEfforts: RUN_REASONING_EFFORTS,
    defaultReasoningEffort: 'medium',
  },
  {
    id: 'grok-4.5',
    label: 'Grok 4.5',
    providerId: 'grok_oauth',
    reasoningEfforts: ['low', 'medium', 'high'],
    defaultReasoningEffort: 'high',
  },
] as const satisfies readonly {
  id: string;
  label: string;
  providerId: ProviderAuthProviderId;
  reasoningEfforts: readonly RunReasoningEffort[];
  defaultReasoningEffort: RunReasoningEffort;
}[];

export type RunModelDescriptor = (typeof RUN_MODEL_CATALOG)[number];
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

export type ImageGenerationModelDescriptor =
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

export type VideoGenerationModelDescriptor =
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

export const SUBAGENT_MODEL_SELECTION_SOURCES = [
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

export interface RunRequest {
  prompt: string;
  displayPrompt?: string;
  threadId?: ThreadId;
  // Computer-root-relative preferred working directory. The daemon admits it
  // against the current computer file scope before starting the run.
  workingDirectory?: string;
  modelId?: RunModelId;
  currentFile?: string;
  selection?: { startLine: number; endLine: number; text: string };
  allowedPublicToolNames?: string[];
  permissionMode?: PermissionMode;
  reasoningEffort?: RunReasoningEffort;
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

export type RunPromptRefRequest = Omit<RunRequest, 'prompt'> & {
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

export type RunSelection = NonNullable<RunRequest['selection']>;

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(isString);
}

function isNonEmptyString(value: unknown): value is string {
  return isString(value) && value.length > 0;
}

function hasOnlyKeys(
  value: Record<string, unknown>,
  allowedKeys: readonly string[],
): boolean {
  return Object.keys(value).every((key) => allowedKeys.includes(key));
}

export function isSubagentModelSelectionSource(
  value: unknown,
): value is SubagentModelSelectionSource {
  return (SUBAGENT_MODEL_SELECTION_SOURCES as readonly unknown[]).includes(
    value,
  );
}

export function isRunSubagentModelChoice(
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

export function isRunSelection(value: unknown): value is RunSelection {
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

export function isRunPromptRefRequest(
  value: unknown,
): value is RunPromptRefRequest {
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
      'reasoningEffort',
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
    (value.reasoningEffort === undefined ||
      isRunReasoningEffort(value.reasoningEffort)) &&
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

export function isRunAttachmentInput(
  value: unknown,
): value is RunAttachmentInput {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ['name', 'contentRef', 'mimeType']) &&
    isNonEmptyString(value.name) &&
    isNonEmptyString(value.contentRef) &&
    (value.mimeType === undefined || isString(value.mimeType))
  );
}
