import { isThreadId, type ThreadId } from './ids.js';
import { isNumber, isRecord, isString } from './runtime-utils.js';

export const ARTIFACT_RENDERERS = [
  'markdown',
  'code',
  'diff',
  'table',
  'html5',
  'js',
  'react_bundle',
  'image',
  'video',
] as const;

export type ArtifactRenderer = (typeof ARTIFACT_RENDERERS)[number];

export const ARTIFACT_START_PREFIX = '<!-- GEULBAT_ARTIFACT ';
export const ARTIFACT_END_MARKER = '<!-- /GEULBAT_ARTIFACT -->';
const ARTIFACT_HEADER_END_MARKER = '-->';

// Artifact ids are daemon-generated persistence keys, not canonical user-facing ids.
// Keep them unbranded until artifact storage has a first-class protocol boundary.
export type ArtifactId = string;

// Artifact-linked run ids are replay/persistence metadata today.
// Keep them unbranded while transcript/history surfaces still carry legacy string truth.
export type ArtifactRunId = string;

export interface ArtifactRef {
  artifactId: ArtifactId;
  version: number;
}

interface ArtifactSourceRefBase {
  workingDirectory: string;
  threadId: ThreadId;
  runId: ArtifactRunId | null;
  messageTimestamp: string | null;
}

export interface ArtifactThreadSourceRef extends ArtifactSourceRefBase {
  kind: 'thread';
  filePath: null;
}

export interface ArtifactThreadFileSourceRef extends ArtifactSourceRefBase {
  kind: 'thread-file';
  filePath: string;
}

export type ArtifactSourceRef =
  | ArtifactThreadSourceRef
  | ArtifactThreadFileSourceRef;

export interface ArtifactRecord {
  artifactId: ArtifactId;
  threadId: ThreadId;
  renderer: ArtifactRenderer;
  title: string | null;
  sourceRef: ArtifactSourceRef | null;
  latestVersion: number;
  persistenceEpoch: number;
  createdAt: string;
  updatedAt: string;
}

export interface ArtifactVersionRecord {
  artifactId: ArtifactId;
  version: number;
  parentVersion: number | null;
  baseVersion: number | null;
  renderer: ArtifactRenderer;
  payload: string;
  digest: string | null;
  contentHash: string;
  createdAt: string;
  createdByRunId: ArtifactRunId;
  previewValidation: ArtifactPreviewValidation;
}

export interface ThreadArtifactVersion extends ArtifactVersionRecord {
  title: string | null;
  persistenceEpoch: number;
  sourceRef: ArtifactSourceRef | null;
}

export type ArtifactPreviewValidation =
  | {
      ok: true;
    }
  | {
      ok: false;
      code: string;
      detail: string;
    };

export function isArtifactRenderer(value: unknown): value is ArtifactRenderer {
  return (
    typeof value === 'string' &&
    (ARTIFACT_RENDERERS as readonly string[]).includes(value)
  );
}

export function isArtifactRef(value: unknown): value is ArtifactRef {
  return (
    isRecord(value) &&
    isString(value.artifactId) &&
    value.artifactId.trim() !== '' &&
    isNumber(value.version) &&
    Number.isInteger(value.version) &&
    value.version > 0
  );
}

export function isArtifactSourceRef(
  value: unknown,
): value is ArtifactSourceRef {
  if (!isRecord(value)) {
    return false;
  }

  const threadId = readRequiredThreadId(value.threadId);
  if (
    'projectId' in value ||
    !isPortableArtifactPath(value.workingDirectory, true) ||
    threadId === null ||
    (value.runId !== null && !isString(value.runId)) ||
    (value.messageTimestamp !== null && !isString(value.messageTimestamp))
  ) {
    return false;
  }

  if (value.kind === 'thread') {
    return value.filePath === null;
  }

  return (
    value.kind === 'thread-file' &&
    isPortableArtifactPath(value.filePath, false)
  );
}

export function normalizeArtifactSourceRef(
  value: unknown,
): ArtifactSourceRef | null {
  if (!isRecord(value)) {
    return null;
  }

  const threadId = readRequiredThreadId(value.threadId);
  const runId = readNullableString(value.runId);
  const messageTimestamp = readNullableString(value.messageTimestamp);
  if (
    threadId === null ||
    !isPortableArtifactPath(value.workingDirectory, true) ||
    runId === undefined ||
    messageTimestamp === undefined
  ) {
    return null;
  }

  if (value.kind === 'thread') {
    const filePath = readNullableString(value.filePath);
    if (filePath === undefined || filePath !== null) {
      return null;
    }
    return {
      kind: 'thread',
      workingDirectory: value.workingDirectory,
      threadId,
      runId,
      filePath: null,
      messageTimestamp,
    };
  }

  if (value.kind === 'thread-file') {
    if (!isPortableArtifactPath(value.filePath, false)) {
      return null;
    }
    return {
      kind: 'thread-file',
      workingDirectory: value.workingDirectory,
      threadId,
      runId,
      filePath: value.filePath,
      messageTimestamp,
    };
  }

  const legacyFilePath = readNullableString(value.filePath);
  if (legacyFilePath === undefined) {
    return null;
  }
  if (
    legacyFilePath !== null &&
    isPortableArtifactPath(legacyFilePath, false)
  ) {
    return {
      kind: 'thread-file',
      workingDirectory: value.workingDirectory,
      threadId,
      runId,
      filePath: legacyFilePath,
      messageTimestamp,
    };
  }

  return {
    kind: 'thread',
    workingDirectory: value.workingDirectory,
    threadId,
    runId,
    filePath: null,
    messageTimestamp,
  };
}

const WINDOWS_ABSOLUTE_PATH = /^(?:[a-zA-Z]:[\\/]|\\\\)/u;

function isPortableArtifactPath(
  value: unknown,
  allowEmpty: boolean,
): value is string {
  if (!isString(value)) {
    return false;
  }
  if (value === '') {
    return allowEmpty;
  }
  if (
    value.startsWith('/') ||
    value.includes('\\') ||
    WINDOWS_ABSOLUTE_PATH.test(value)
  ) {
    return false;
  }
  return value
    .split('/')
    .every((segment) => segment !== '' && segment !== '.' && segment !== '..');
}

export function isArtifactRecord(value: unknown): value is ArtifactRecord {
  return (
    isRecord(value) &&
    isString(value.artifactId) &&
    value.artifactId.trim() !== '' &&
    !('projectId' in value) &&
    isString(value.threadId) &&
    isThreadId(value.threadId) &&
    isArtifactRenderer(value.renderer) &&
    isNullableString(value.title) &&
    (value.sourceRef === null || isArtifactSourceRef(value.sourceRef)) &&
    isNumber(value.latestVersion) &&
    Number.isInteger(value.latestVersion) &&
    value.latestVersion > 0 &&
    isNumber(value.persistenceEpoch) &&
    Number.isInteger(value.persistenceEpoch) &&
    value.persistenceEpoch >= 0 &&
    isString(value.createdAt) &&
    isString(value.updatedAt)
  );
}

export function isArtifactVersionRecord(
  value: unknown,
): value is ArtifactVersionRecord {
  return (
    isRecord(value) &&
    isString(value.artifactId) &&
    value.artifactId.trim() !== '' &&
    isNumber(value.version) &&
    Number.isInteger(value.version) &&
    value.version > 0 &&
    isNullableInteger(value.parentVersion) &&
    isNullableInteger(value.baseVersion) &&
    isArtifactRenderer(value.renderer) &&
    isString(value.payload) &&
    isNullableString(value.digest) &&
    isString(value.contentHash) &&
    value.contentHash.trim() !== '' &&
    isString(value.createdAt) &&
    isString(value.createdByRunId) &&
    isPreviewValidation(value.previewValidation)
  );
}

export function isThreadArtifactVersion(
  value: unknown,
): value is ThreadArtifactVersion {
  return (
    isArtifactVersionRecord(value) &&
    isRecord(value) &&
    isNullableString(value.title) &&
    isNumber(value.persistenceEpoch) &&
    Number.isInteger(value.persistenceEpoch) &&
    value.persistenceEpoch >= 0 &&
    (value.sourceRef === null || isArtifactSourceRef(value.sourceRef))
  );
}

export function createArtifactRefKey(ref: ArtifactRef): string {
  return `${ref.artifactId}::${ref.version}`;
}

// ── 사용자 draft → 버전 커밋 (phase5 commit path spec §5.2 update contract) ──
// 에디터 </>에서 고친 draft를 같은 artifactId의 새 버전으로 커밋하는 route
// 계약. baseVersion은 낙관적 동시성 — 서버 latestVersion과 불일치하면
// version_conflict(409)로 거절된다.

export const MAX_ARTIFACT_DRAFT_COMMIT_PAYLOAD_LENGTH = 2_000_000;

export interface ArtifactDraftCommitRequest {
  baseVersion: number;
  payload: string;
}

export interface ArtifactDraftCommitResponse {
  ok: true;
  artifact: ThreadArtifactVersion;
  ref: ArtifactRef;
}

export function isArtifactDraftCommitResponse(
  value: unknown,
): value is ArtifactDraftCommitResponse {
  return (
    isRecord(value) &&
    value.ok === true &&
    isThreadArtifactVersion(value.artifact) &&
    isArtifactRef(value.ref)
  );
}

export function isArtifactDraftCommitRequest(
  value: unknown,
): value is ArtifactDraftCommitRequest {
  return (
    isRecord(value) &&
    isNumber(value.baseVersion) &&
    Number.isInteger(value.baseVersion) &&
    value.baseVersion >= 1 &&
    isString(value.payload) &&
    value.payload.length > 0 &&
    value.payload.length <= MAX_ARTIFACT_DRAFT_COMMIT_PAYLOAD_LENGTH
  );
}

// ── image artifact payload ──
// `image` 렌더러의 payload는 원시 바이트가 아니라 JSON 매니페스트다.
// 생성 바이트는 inline base64로 담고, digest/provenance가 커밋 전 필수라는
// P6.5 artifact-media 경계 규칙을 payload 계약 수준에서 강제한다.

export const IMAGE_ARTIFACT_PAYLOAD_SCHEMA_VERSION = 1;

export interface ImageArtifactPayloadDigest {
  algorithm: 'sha256';
  encoding: 'hex';
  value: string;
}

export interface ImageArtifactPayloadProvenance {
  providerId: string;
  model: string;
  capability: 'image_generation';
  prompt: string;
  revisedPrompt?: string;
  generatedAt: string;
}

// 이미지 소스는 두 형태를 허용한다:
// - `inline_base64`: 구형(파일 스토어 이관 전). 기존 스레드 하위호환용으로
//   파서는 계속 읽되, 신규 생성분은 더 이상 만들지 않는다(D-V7).
// - `thread_media`: 신형. 실제 바이트는 media 파일 스토어에 있고 mediaRef로
//   가리켜 스냅샷/와이어에서 base64가 사라진다(동영상과 동일 규범).
export type ImageArtifactSource =
  | { type: 'inline_base64'; dataBase64: string }
  | { type: 'thread_media'; mediaRef: string };

export interface ImageArtifactPayloadV1 {
  schemaVersion: typeof IMAGE_ARTIFACT_PAYLOAD_SCHEMA_VERSION;
  kind: 'generated_image';
  mimeType: string;
  byteLength: number;
  digest: ImageArtifactPayloadDigest;
  source: ImageArtifactSource;
  provenance: ImageArtifactPayloadProvenance;
}

function parseImageArtifactSource(source: unknown): ImageArtifactSource | null {
  if (!isRecord(source)) {
    return null;
  }
  if (source.type === 'inline_base64') {
    return isString(source.dataBase64) && source.dataBase64.length > 0
      ? { type: 'inline_base64', dataBase64: source.dataBase64 }
      : null;
  }
  if (source.type === 'thread_media') {
    return isThreadMediaRef(source.mediaRef)
      ? { type: 'thread_media', mediaRef: source.mediaRef }
      : null;
  }
  return null;
}

// ── video artifact payload ──
// `video` 렌더러의 payload는 JSON 매니페스트이며 **인라인 바이트가 없다**
// (video-generation-open §4.6 규범 — 스냅샷/와이어 비대 방지, D-V7).
// 실제 바이트는 스레드 스코프 media 파일 스토어에 있고 mediaRef로 가리킨다.

export const VIDEO_ARTIFACT_PAYLOAD_SCHEMA_VERSION = 1;

// media 파일명 = <sha256>.<확장자>. 서빙 라우트의 경로 파라미터 가드로도
// 쓰인다(경로 탈출 원천 차단 — 이 패턴 밖은 무조건 거부).
const THREAD_MEDIA_REF_PATTERN = /^[a-f0-9]{64}\.(mp4|webm|png|jpe?g|webp)$/u;

export function isThreadMediaRef(value: unknown): value is string {
  return typeof value === 'string' && THREAD_MEDIA_REF_PATTERN.test(value);
}

export interface VideoArtifactPayloadProvenance {
  providerId: string;
  model: string;
  capability: 'video_generation';
  prompt: string;
  // 소스 이미지 출처 — 투명 캔버스 브리지(text 발상)인지, 스레드 아티팩트
  // 이미지였는지(§7 D-V5). 아티팩트였다면 그 ref 문자열을 남긴다.
  sourceImage: 'blank_canvas' | { artifactRef: string };
  generatedAt: string;
}

export interface VideoArtifactPayloadV1 {
  schemaVersion: typeof VIDEO_ARTIFACT_PAYLOAD_SCHEMA_VERSION;
  kind: 'generated_video';
  mimeType: string;
  byteLength: number;
  digest: ImageArtifactPayloadDigest;
  source: { type: 'thread_media'; mediaRef: string };
  durationSeconds?: number;
  provenance: VideoArtifactPayloadProvenance;
}

export function parseVideoArtifactPayload(
  payload: string,
): VideoArtifactPayloadV1 | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    return null;
  }
  if (
    !isRecord(parsed) ||
    parsed.schemaVersion !== VIDEO_ARTIFACT_PAYLOAD_SCHEMA_VERSION ||
    parsed.kind !== 'generated_video' ||
    !isString(parsed.mimeType) ||
    !isNumber(parsed.byteLength) ||
    (parsed.durationSeconds !== undefined && !isNumber(parsed.durationSeconds))
  ) {
    return null;
  }
  const digest = parsed.digest;
  if (
    !isRecord(digest) ||
    digest.algorithm !== 'sha256' ||
    digest.encoding !== 'hex' ||
    !isString(digest.value) ||
    digest.value.length === 0
  ) {
    return null;
  }
  const source = parsed.source;
  if (
    !isRecord(source) ||
    source.type !== 'thread_media' ||
    !isThreadMediaRef(source.mediaRef)
  ) {
    return null;
  }
  const provenance = parsed.provenance;
  if (
    !isRecord(provenance) ||
    provenance.capability !== 'video_generation' ||
    !isString(provenance.providerId) ||
    !isString(provenance.model) ||
    !isString(provenance.prompt) ||
    !isString(provenance.generatedAt)
  ) {
    return null;
  }
  const sourceImage = provenance.sourceImage;
  const parsedSourceImage =
    sourceImage === 'blank_canvas'
      ? ('blank_canvas' as const)
      : isRecord(sourceImage) && isString(sourceImage.artifactRef)
        ? { artifactRef: sourceImage.artifactRef }
        : null;
  if (parsedSourceImage === null) {
    return null;
  }
  return {
    schemaVersion: VIDEO_ARTIFACT_PAYLOAD_SCHEMA_VERSION,
    kind: 'generated_video',
    mimeType: parsed.mimeType,
    byteLength: parsed.byteLength,
    digest: {
      algorithm: 'sha256',
      encoding: 'hex',
      value: digest.value,
    },
    source: { type: 'thread_media', mediaRef: source.mediaRef },
    ...(parsed.durationSeconds !== undefined
      ? { durationSeconds: parsed.durationSeconds }
      : {}),
    provenance: {
      providerId: provenance.providerId,
      model: provenance.model,
      capability: 'video_generation',
      prompt: provenance.prompt,
      sourceImage: parsedSourceImage,
      generatedAt: provenance.generatedAt,
    },
  };
}

export function parseImageArtifactPayload(
  payload: string,
): ImageArtifactPayloadV1 | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    return null;
  }
  if (
    !isRecord(parsed) ||
    parsed.schemaVersion !== IMAGE_ARTIFACT_PAYLOAD_SCHEMA_VERSION ||
    parsed.kind !== 'generated_image' ||
    !isString(parsed.mimeType) ||
    !isNumber(parsed.byteLength)
  ) {
    return null;
  }
  const digest = parsed.digest;
  if (
    !isRecord(digest) ||
    digest.algorithm !== 'sha256' ||
    digest.encoding !== 'hex' ||
    !isString(digest.value) ||
    digest.value.length === 0
  ) {
    return null;
  }
  const source = parseImageArtifactSource(parsed.source);
  if (source === null) {
    return null;
  }
  const provenance = parsed.provenance;
  if (
    !isRecord(provenance) ||
    provenance.capability !== 'image_generation' ||
    !isString(provenance.providerId) ||
    !isString(provenance.model) ||
    !isString(provenance.prompt) ||
    !isString(provenance.generatedAt) ||
    (provenance.revisedPrompt !== undefined &&
      !isString(provenance.revisedPrompt))
  ) {
    return null;
  }
  return {
    schemaVersion: IMAGE_ARTIFACT_PAYLOAD_SCHEMA_VERSION,
    kind: 'generated_image',
    mimeType: parsed.mimeType,
    byteLength: parsed.byteLength,
    digest: {
      algorithm: 'sha256',
      encoding: 'hex',
      value: digest.value,
    },
    source,
    provenance: {
      providerId: provenance.providerId,
      model: provenance.model,
      capability: 'image_generation',
      prompt: provenance.prompt,
      ...(provenance.revisedPrompt !== undefined
        ? { revisedPrompt: provenance.revisedPrompt }
        : {}),
      generatedAt: provenance.generatedAt,
    },
  };
}

// 봉투 헤더의 기존 아티팩트 갱신 선언 — 모델이 artifactId+baseVersion을
// 함께 명시하면 커밋 경로가 새 artifactId v1 대신 같은 아티팩트의 다음
// 버전으로 append를 시도한다 (♻ 재작성 등). 대상이 무효하면 커밋 경로가
// 새 아티팩트 생성으로 폴백해 콘텐츠를 잃지 않는다.
export interface ArtifactEnvelopeUpdateTarget {
  artifactId: ArtifactId;
  baseVersion: number;
}

export interface ParsedCanonicalArtifactEnvelope {
  renderer: ArtifactRenderer;
  payload: string;
  digest: string | null;
  updateTarget?: ArtifactEnvelopeUpdateTarget;
}

export function buildArtifactEnvelopeText(args: {
  renderer: ArtifactRenderer;
  digest?: string | null;
  payload: string;
}): string {
  const header: {
    renderer: ArtifactRenderer;
    digest?: string;
  } = {
    renderer: args.renderer,
  };
  if (typeof args.digest === 'string' && args.digest.trim()) {
    header.digest = args.digest.trim();
  }
  return [
    `${ARTIFACT_START_PREFIX}${JSON.stringify(header)} ${ARTIFACT_HEADER_END_MARKER}`,
    args.payload,
    ARTIFACT_END_MARKER,
  ].join('\n');
}

export function parseCanonicalArtifactEnvelopeText(
  value: string,
): ParsedCanonicalArtifactEnvelope | null {
  const trimmed = value.trim();
  if (
    !trimmed.startsWith(ARTIFACT_START_PREFIX) ||
    !trimmed.endsWith(ARTIFACT_END_MARKER)
  ) {
    return null;
  }

  const headerEnd = trimmed.indexOf(ARTIFACT_HEADER_END_MARKER);
  if (headerEnd === -1) {
    return null;
  }

  const headerJson = trimmed
    .slice(ARTIFACT_START_PREFIX.length, headerEnd)
    .trim();
  let parsedHeader: unknown;
  try {
    parsedHeader = JSON.parse(headerJson);
  } catch {
    return null;
  }

  if (!isRecord(parsedHeader) || !isArtifactRenderer(parsedHeader.renderer)) {
    return null;
  }

  const updateTarget = readEnvelopeUpdateTarget(parsedHeader);
  return {
    renderer: parsedHeader.renderer,
    payload: trimmed.slice(
      headerEnd + ARTIFACT_HEADER_END_MARKER.length,
      -ARTIFACT_END_MARKER.length,
    ),
    digest:
      typeof parsedHeader.digest === 'string' && parsedHeader.digest.trim()
        ? parsedHeader.digest.trim()
        : null,
    ...(updateTarget !== null ? { updateTarget } : {}),
  };
}

// artifactId와 baseVersion이 둘 다 유효할 때만 update 선언으로 인정한다 —
// 반쪽짜리 선언은 무시하고 새 아티팩트 생성 경로로 흘려 콘텐츠를 지킨다.
function readEnvelopeUpdateTarget(
  header: Record<string, unknown>,
): ArtifactEnvelopeUpdateTarget | null {
  const artifactId = header.artifactId;
  const baseVersion = header.baseVersion;
  if (
    !isString(artifactId) ||
    artifactId.trim() === '' ||
    !isNumber(baseVersion) ||
    !Number.isInteger(baseVersion) ||
    baseVersion < 1
  ) {
    return null;
  }
  return { artifactId: artifactId.trim(), baseVersion };
}

function isNullableString(value: unknown): value is string | null | undefined {
  return value === null || value === undefined || isString(value);
}

function readNullableString(value: unknown): string | null | undefined {
  if (value === null || value === undefined) {
    return null;
  }
  if (isString(value)) {
    return value;
  }
  return undefined;
}

function readRequiredThreadId(value: unknown): ThreadId | null {
  return isString(value) && isThreadId(value) ? value : null;
}

function isNullableInteger(value: unknown): value is number | null {
  return (
    value === null || (isNumber(value) && Number.isInteger(value) && value > 0)
  );
}

function isPreviewValidation(
  value: unknown,
): value is ArtifactVersionRecord['previewValidation'] {
  return (
    isRecord(value) &&
    ((value.ok === true &&
      value.code === undefined &&
      value.detail === undefined) ||
      (value.ok === false && isString(value.code) && isString(value.detail)))
  );
}
