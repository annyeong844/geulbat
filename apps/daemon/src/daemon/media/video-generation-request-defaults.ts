import type {
  GenerateVideoArtifactInput,
  VideoGenerationRequestDefaults,
  VideoGenerationRuntime,
} from './contract.js';

// 요청 스코프 동영상 생성 기본값(video-generation-open §4.3) — 이미지의
// withImageGenerationRequestDefaults와 동형. 싱글턴 런타임의 mutable default
// 를 변경하지 않으므로 동시 run끼리 섞이지 않는다.
//
// 우선순위(§4.1): 툴 args(현재 사용자 턴 명시, D2) > 이 기본값 > env > 내장.
export function withVideoGenerationRequestDefaults(
  runtime: VideoGenerationRuntime,
  defaults: VideoGenerationRequestDefaults,
): VideoGenerationRuntime {
  return {
    generateVideoArtifact(input: GenerateVideoArtifactInput) {
      return runtime.generateVideoArtifact(
        applyVideoGenerationRequestDefaults(input, defaults),
      );
    },
    // 재적용은 대체(compose 아님) — run 시작 시 1회 적용이 계약이다
    withRequestDefaults(next: VideoGenerationRequestDefaults) {
      return withVideoGenerationRequestDefaults(runtime, next);
    },
  };
}

export function applyVideoGenerationRequestDefaults(
  input: GenerateVideoArtifactInput,
  defaults: VideoGenerationRequestDefaults,
): GenerateVideoArtifactInput {
  return {
    ...input,
    request: {
      ...input.request,
      ...(input.request.model === undefined ? { model: defaults.model } : {}),
      ...(input.request.durationSeconds === undefined &&
      defaults.durationSeconds !== undefined
        ? { durationSeconds: defaults.durationSeconds }
        : {}),
      ...(input.request.aspectRatio === undefined &&
      defaults.aspectRatio !== undefined
        ? { aspectRatio: defaults.aspectRatio }
        : {}),
      ...(input.request.resolution === undefined &&
      defaults.resolution !== undefined
        ? { resolution: defaults.resolution }
        : {}),
    },
  };
}
