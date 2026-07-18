import type { ErrorCode } from '../../error-codes.js';
import {
  isImageGenerationError,
  type GenerateVideoArtifactResult,
} from '../../media/contract.js';
import { imageGenerationFailureToolErrorCode } from './image-generation-result.js';

// generate_video 툴 출력(모델에게 보이는 텍스트)과 실패 매핑 —
// generate_image와 같은 규범: 바이트/base64는 절대 싣지 않는다.

export function stringifyGenerateVideoOutput(
  result: GenerateVideoArtifactResult,
): string {
  const { artifactVersion, provenance, media } = result;
  return JSON.stringify({
    ok: true,
    artifactRef: `${artifactVersion.artifactId}@${artifactVersion.version}`,
    renderer: artifactVersion.renderer,
    title: artifactVersion.title,
    mimeType: media.mimeType,
    byteLength: media.byteLength,
    digestSha256: media.digestSha256,
    durationSeconds: media.durationSeconds,
    provider: provenance.providerId,
    model: provenance.model,
    sourceImage:
      provenance.sourceImage === 'blank_canvas'
        ? 'blank_canvas'
        : provenance.sourceImage.artifactRef,
    note: 'Video was committed as a thread artifact and is already playable for the user. Do not repeat the video content; reference it briefly.',
  });
}

// 실패 분류(§4.4) — 소스 아티팩트 가드는 모델이 넘긴 인자 문제이므로
// invalid_args로 구분하고, 나머지는 이미지 매핑을 그대로 재사용한다
// (오류 클래스·표면 체계를 공유하기 때문).
export function videoGenerationFailureToolErrorCode(error: unknown): ErrorCode {
  if (
    isImageGenerationError(error) &&
    (error.reasonCode === 'source_artifact_ref_invalid' ||
      error.reasonCode === 'source_artifact_not_found' ||
      error.reasonCode === 'source_artifact_not_image' ||
      error.reasonCode === 'source_artifact_payload_invalid')
  ) {
    return 'invalid_args';
  }
  return imageGenerationFailureToolErrorCode(error);
}

export function stringifyGenerateVideoFailure(
  error: unknown,
  fallbackMessage: string,
): { message: string; output: string } {
  const message = isImageGenerationError(error)
    ? `${error.surface}/${error.reasonCode}: ${error.message}`
    : fallbackMessage;
  return {
    message,
    output: JSON.stringify({ ok: false, error: message }),
  };
}
