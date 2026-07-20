import { isArtifactRef, type ArtifactRef } from './artifacts.js';
import { isRunId, type RunId } from './ids.js';
import { isRecord, isString } from './wire-value-guards.js';

const THREAD_MESSAGE_PHASES = ['commentary', 'final_answer'] as const;

type ThreadMessagePhase = (typeof THREAD_MESSAGE_PHASES)[number];

// 사용자 메시지에 실린 업로드 첨부 — 바이트는 스레드 첨부 스토어에 있고
// 여기에는 참조와 표시용 정보만 남는다. kind는 모델 전달 형태를 뜻한다
// (image = 이미지 입력 블록, pdf = input_file 블록, text = 본문 텍스트 블록).
export interface ThreadMessageAttachment {
  attachmentId: string;
  name: string;
  mimeType: string;
  kind: 'image' | 'text' | 'pdf';
  byteLength: number;
}

interface UserThreadMessageMetadata {
  hiddenPrompt?: string;
  attachments?: ThreadMessageAttachment[];
  // UI 발 자동 요청(아티팩트 ♻ 등) — 감사용으로만 기록되고 채팅에는
  // 그리지 않는다.
  silent?: boolean;
  // 아티팩트 프레임 발 턴(request_prompt/티어 B 강등) — 채팅에 "아티팩트
  // 발" 귀속으로 렌더된다 (back-channel 설계 가시성 불변식).
  origin?: 'artifact_frame';
  source?: never;
  phase?: never;
  sourceRunId?: never;
  sourceFile?: never;
  artifactRefs?: never;
  activeArtifactRef?: never;
}

interface CommentaryThreadMessageMetadata {
  phase: 'commentary';
  sourceRunId?: RunId;
  sourceFile?: string;
  source?: never;
  hiddenPrompt?: never;
  silent?: never;
  origin?: never;
  artifactRefs?: never;
  activeArtifactRef?: never;
}

export interface FinalAnswerThreadMessageMetadata {
  phase: 'final_answer';
  sourceRunId?: RunId;
  sourceFile?: string;
  artifactRefs?: ArtifactRef[];
  activeArtifactRef?: ArtifactRef;
  source?: never;
  hiddenPrompt?: never;
  silent?: never;
  origin?: never;
}

interface InterjectThreadMessageMetadata {
  source: 'interject';
  sourceRunId?: RunId;
  receivedSeq?: number;
  phase?: never;
  hiddenPrompt?: never;
  silent?: never;
  origin?: never;
  sourceFile?: never;
  artifactRefs?: never;
  activeArtifactRef?: never;
}

export type ThreadMessageMetadata =
  | UserThreadMessageMetadata
  | CommentaryThreadMessageMetadata
  | FinalAnswerThreadMessageMetadata
  | InterjectThreadMessageMetadata;

const USER_METADATA_KEYS = [
  'hiddenPrompt',
  'attachments',
  'silent',
  'origin',
] as const;
const COMMENTARY_METADATA_KEYS = [
  'phase',
  'sourceRunId',
  'sourceFile',
] as const;
const FINAL_ANSWER_METADATA_KEYS = [
  'phase',
  'sourceRunId',
  'sourceFile',
  'artifactRefs',
  'activeArtifactRef',
] as const;
const INTERJECT_METADATA_KEYS = [
  'source',
  'sourceRunId',
  'receivedSeq',
] as const;

export function isThreadMessagePhase(
  value: unknown,
): value is ThreadMessagePhase {
  return (
    typeof value === 'string' &&
    (THREAD_MESSAGE_PHASES as readonly string[]).includes(value)
  );
}

export function isThreadMessageMetadata(
  value: unknown,
): value is ThreadMessageMetadata {
  if (!isRecord(value)) {
    return false;
  }

  if (value.source === 'interject') {
    const hasLegacyIdentity =
      value.sourceRunId === undefined && value.receivedSeq === undefined;
    const hasDurableIdentity =
      isString(value.sourceRunId) &&
      isRunId(value.sourceRunId) &&
      typeof value.receivedSeq === 'number' &&
      Number.isSafeInteger(value.receivedSeq) &&
      value.receivedSeq > 0;
    return (
      hasOnlyMetadataKeys(value, INTERJECT_METADATA_KEYS) &&
      (hasLegacyIdentity || hasDurableIdentity)
    );
  }

  if (value.phase === undefined) {
    return (
      hasOnlyMetadataKeys(value, USER_METADATA_KEYS) &&
      (value.hiddenPrompt !== undefined ||
        value.attachments !== undefined ||
        value.silent !== undefined ||
        value.origin !== undefined) &&
      isOptionalString(value.hiddenPrompt) &&
      isOptionalThreadMessageAttachments(value.attachments) &&
      (value.silent === undefined || typeof value.silent === 'boolean') &&
      (value.origin === undefined || value.origin === 'artifact_frame')
    );
  }

  if (value.phase === 'commentary') {
    return (
      hasOnlyMetadataKeys(value, COMMENTARY_METADATA_KEYS) &&
      isOptionalRunId(value.sourceRunId) &&
      isOptionalString(value.sourceFile)
    );
  }

  return (
    value.phase === 'final_answer' &&
    hasOnlyMetadataKeys(value, FINAL_ANSWER_METADATA_KEYS) &&
    isOptionalRunId(value.sourceRunId) &&
    isOptionalString(value.sourceFile) &&
    isOptionalArtifactRefs(value.artifactRefs) &&
    isOptionalArtifactRef(value.activeArtifactRef)
  );
}

export function readArtifactRefsFromMetadata(
  metadata: ThreadMessageMetadata | undefined,
): ArtifactRef[] {
  return metadata?.artifactRefs ?? [];
}

export function readActiveArtifactRefFromMetadata(
  metadata: ThreadMessageMetadata | undefined,
): ArtifactRef | null {
  return metadata?.activeArtifactRef ?? null;
}

function hasOnlyMetadataKeys(
  value: Record<string, unknown>,
  allowedKeys: readonly string[],
): boolean {
  return Object.keys(value).every((key) => allowedKeys.includes(key));
}

function isOptionalRunId(value: unknown): value is RunId | undefined {
  return value === undefined || (isString(value) && isRunId(value));
}

function isOptionalString(value: unknown): value is string | undefined {
  return value === undefined || isString(value);
}

function isThreadMessageAttachment(
  value: unknown,
): value is ThreadMessageAttachment {
  return (
    isRecord(value) &&
    hasOnlyMetadataKeys(value, [
      'attachmentId',
      'name',
      'mimeType',
      'kind',
      'byteLength',
    ]) &&
    isString(value.attachmentId) &&
    value.attachmentId.length > 0 &&
    isString(value.name) &&
    value.name.length > 0 &&
    isString(value.mimeType) &&
    (value.kind === 'image' || value.kind === 'text' || value.kind === 'pdf') &&
    typeof value.byteLength === 'number' &&
    Number.isFinite(value.byteLength) &&
    value.byteLength >= 0
  );
}

function isOptionalThreadMessageAttachments(
  value: unknown,
): value is ThreadMessageAttachment[] | undefined {
  return (
    value === undefined ||
    (Array.isArray(value) &&
      value.length > 0 &&
      value.every(isThreadMessageAttachment))
  );
}

function isOptionalArtifactRefs(
  value: unknown,
): value is ArtifactRef[] | undefined {
  return (
    value === undefined || (Array.isArray(value) && value.every(isArtifactRef))
  );
}

function isOptionalArtifactRef(
  value: unknown,
): value is ArtifactRef | undefined {
  return value === undefined || isArtifactRef(value);
}
