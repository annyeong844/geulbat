import type { ErrorCode } from '../../error-codes.js';
import {
  isImageGenerationError,
  type GenerateImageArtifactResult,
} from '../../media/contract.js';

// generate_image 툴 출력(모델에게 보이는 텍스트)과 실패 매핑.
// 바이트/base64는 절대 싣지 않는다 — 참조와 요약 메타데이터만 반환한다.

export function stringifyGenerateImageOutput(
  result: GenerateImageArtifactResult,
): string {
  const { artifactVersion, provenance, asset } = result;
  return JSON.stringify({
    ok: true,
    artifactRef: `${artifactVersion.artifactId}@${artifactVersion.version}`,
    renderer: artifactVersion.renderer,
    title: artifactVersion.title,
    mimeType: asset.mimeType,
    byteLength: asset.byteLength,
    digestSha256: asset.digest.value,
    provider: provenance.providerId,
    model: provenance.model,
    ...(provenance.revisedPrompt !== undefined
      ? { revisedPrompt: provenance.revisedPrompt }
      : {}),
    note: 'Image was committed as a thread artifact and is already visible to the user. Do not repeat the image content; reference it briefly.',
  });
}

// 실패 분류(image-generation-open §4.4) — 미연결/토큰거부/레이트리밋/타임아웃/
// 응답검증/커밋을 구분해 표면화한다. 여기서 매핑되는 코드는 executor의
// 안전 코드 목록에 등재되어 있어 큐레이션된 메시지가 삼켜지지 않는다.
export function imageGenerationFailureToolErrorCode(error: unknown): ErrorCode {
  if (!isImageGenerationError(error)) {
    return 'execution_failed';
  }
  if (error.reasonCode === 'provider_not_connected') {
    // 사용자가 고른 프로바이더가 사용 불가 — 자동 폴백 없이 명시적 실패(§4.2)
    return 'image_provider_unavailable';
  }
  if (error.surface === 'provider_auth') {
    return 'llm_auth_failed';
  }
  if (error.surface === 'artifact_commit') {
    return 'artifact_commit_failed';
  }
  if (error.surface === 'candidate_validation') {
    return 'invalid_image_response';
  }
  if (error.reasonCode === 'provider_rate_limited') {
    return 'llm_rate_limited';
  }
  if (error.reasonCode === 'provider_quota_exceeded') {
    return 'quota_exceeded';
  }
  if (error.reasonCode === 'provider_request_timeout') {
    return 'timeout';
  }
  if (
    error.reasonCode === 'provider_response_invalid' ||
    error.reasonCode === 'empty_image_result'
  ) {
    return 'invalid_image_response';
  }
  return 'execution_failed';
}

export function stringifyGenerateImageFailure(
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
