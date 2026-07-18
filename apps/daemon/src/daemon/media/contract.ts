import type { ThreadArtifactVersion } from '@geulbat/protocol/artifacts';
import type { ThreadId } from '@geulbat/protocol/ids';

// P6.5 artifact-media 소유 계약: 이미지 생성의 데몬-프라이빗 request/candidate
// 형태와 런타임 서비스 인터페이스. 소비자(tools 등)는 이 contract만 import하고,
// 구현은 composition root가 주입한다.

export const IMAGE_GENERATION_PROVIDER_IDS = [
  'openai_codex_direct',
  'grok_oauth',
] as const;

export type ImageGenerationProviderId =
  (typeof IMAGE_GENERATION_PROVIDER_IDS)[number];

export function isImageGenerationProviderId(
  value: unknown,
): value is ImageGenerationProviderId {
  return (
    typeof value === 'string' &&
    (IMAGE_GENERATION_PROVIDER_IDS as readonly string[]).includes(value)
  );
}

export const IMAGE_GENERATION_SIZES = [
  '1024x1024',
  '1024x1536',
  '1536x1024',
] as const;

type ImageGenerationSize = (typeof IMAGE_GENERATION_SIZES)[number];

export const IMAGE_GENERATION_QUALITIES = ['low', 'medium', 'high'] as const;

type ImageGenerationQuality = (typeof IMAGE_GENERATION_QUALITIES)[number];

export interface ImageGenerationRequest {
  prompt: string;
  size?: ImageGenerationSize;
  quality?: ImageGenerationQuality;
  // 요청 스코프 모델 재정의(사용자의 기본 이미지 모델 선택) — 어댑터는
  // 이 값을 env knob·내장 기본값보다 우선 적용한다(§4.1 우선순위).
  model?: string;
}

export type GeneratedImageMimeType = 'image/png' | 'image/jpeg' | 'image/webp';

interface GeneratedImageDigest {
  algorithm: 'sha256';
  encoding: 'hex';
  value: string;
}

export interface GeneratedImageAsset {
  mimeType: GeneratedImageMimeType;
  byteLength: number;
  dataBase64: string;
  digest: GeneratedImageDigest;
}

interface GeneratedImageProvenance {
  providerId: ImageGenerationProviderId;
  model: string;
  capability: 'image_generation';
  prompt: string;
  revisedPrompt?: string;
  generatedAt: string;
}

export interface GeneratedImageCandidate {
  asset: GeneratedImageAsset;
  provenance: GeneratedImageProvenance;
}

// 실패 표면 분리(P6.5 image-oauth-media-sandbox §7): 인증/프로바이더/후보검증/
// 커밋을 구분해 재접속 안내와 진단이 소유자별로 유지되게 한다.
type ImageGenerationFailureSurface =
  | 'provider_auth'
  | 'provider_api'
  | 'candidate_validation'
  | 'artifact_commit';

export class ImageGenerationError extends Error {
  readonly surface: ImageGenerationFailureSurface;
  readonly reasonCode: string;

  constructor(args: {
    surface: ImageGenerationFailureSurface;
    reasonCode: string;
    message: string;
    cause?: unknown;
  }) {
    super(args.message, args.cause !== undefined ? { cause: args.cause } : {});
    this.name = 'ImageGenerationError';
    this.surface = args.surface;
    this.reasonCode = args.reasonCode;
  }
}

export function isImageGenerationError(
  value: unknown,
): value is ImageGenerationError {
  return value instanceof ImageGenerationError;
}

export interface GenerateImageArtifactInput {
  request: ImageGenerationRequest;
  providerId?: ImageGenerationProviderId;
  stateRoot: string;
  workingDirectory: string;
  threadId: ThreadId;
  runId: string;
  signal?: AbortSignal;
}

export interface GenerateImageArtifactResult {
  artifactVersion: ThreadArtifactVersion;
  provenance: GeneratedImageProvenance;
  asset: Pick<GeneratedImageAsset, 'mimeType' | 'byteLength' | 'digest'>;
}

// run 시작 시 적용되는 요청 스코프 기본값(image-generation-open §4.3) —
// 사용자의 "기본 이미지 모델" 선택. providerId는 모델이 함축한다.
export interface ImageGenerationRequestDefaults {
  providerId: ImageGenerationProviderId;
  model: string;
}

// 생성→검증→후보→데몬 커밋까지를 하나의 데몬-프라이빗 경로로 소유한다.
// 프로바이더 성공은 커밋 성공이 아니며, 이 메서드가 반환해야 durable 상태다.
export interface ImageGenerationRuntime {
  generateImageArtifact(
    input: GenerateImageArtifactInput,
  ): Promise<GenerateImageArtifactResult>;
  // 요청 스코프 기본값을 적용한 파생 런타임을 돌려준다 — 원본(싱글턴)은
  // 불변이므로 동시 run끼리 섞이지 않는다. 소비자(adapter)는 media 구현을
  // import하지 않고 이 메서드만 호출한다(경계 규칙).
  withRequestDefaults(
    defaults: ImageGenerationRequestDefaults,
  ): ImageGenerationRuntime;
}

// ── video generation (video-generation-open §4.5) ──
// v1은 grok 단일 프로바이더·단일 모델(1.5)이며, 소스 이미지가 없으면
// 런타임이 투명 캔버스를 주입해 text 발상을 흡수한다(D-V5 브리지).
// 오류는 ImageGenerationError를 공유한다(§4.4 — 분류 7종 재사용).

export interface VideoGenerationRequest {
  prompt: string;
  // 현재 턴 명시(D2) 운반 — 미지정이면 요청 스코프 기본값 > env > 내장 5초
  durationSeconds?: number;
  // 요청 스코프 모델 재정의(§4.1 사다리) — v1 카탈로그는 1.5뿐이다
  model?: string;
  // 설정 팝업이 소유하는 상세 옵션(S3 무과금 프로브로 실측한 폐쇄 집합).
  // 미지정이면 프로바이더 기본(모델이 결정)에 맡긴다.
  aspectRatio?: string;
  resolution?: string;
}

export interface GenerateVideoArtifactInput {
  request: VideoGenerationRequest;
  // "artifactId@version" — 이 스레드의 이미지 아티팩트를 움직인다(§4.3).
  // 생략하면 투명 캔버스 브리지(text 발상).
  sourceArtifactRef?: string;
  stateRoot: string;
  workingDirectory: string;
  threadId: ThreadId;
  runId: string;
  signal?: AbortSignal;
}

export interface GeneratedVideoProvenance {
  providerId: 'grok_oauth';
  model: string;
  capability: 'video_generation';
  prompt: string;
  sourceImage: 'blank_canvas' | { artifactRef: string };
  generatedAt: string;
}

export interface GenerateVideoArtifactResult {
  artifactVersion: ThreadArtifactVersion;
  provenance: GeneratedVideoProvenance;
  media: {
    mimeType: string;
    byteLength: number;
    digestSha256: string;
    mediaRef: string;
    durationSeconds: number;
  };
}

// run 시작 시 적용되는 요청 스코프 기본값 — 사용자의 동영상 모델·설정 선택
export interface VideoGenerationRequestDefaults {
  model: string;
  durationSeconds?: number;
  aspectRatio?: string;
  resolution?: string;
}

export interface VideoGenerationRuntime {
  generateVideoArtifact(
    input: GenerateVideoArtifactInput,
  ): Promise<GenerateVideoArtifactResult>;
  // 이미지 런타임과 같은 계약(§4.3) — 파생 런타임 반환, 싱글턴 불변
  withRequestDefaults(
    defaults: VideoGenerationRequestDefaults,
  ): VideoGenerationRuntime;
}
