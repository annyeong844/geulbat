import type {
  GenerateImageArtifactInput,
  ImageGenerationRequestDefaults,
  ImageGenerationRuntime,
} from './contract.js';

// 요청 스코프 이미지 생성 기본값(image-generation-open §4.3) — run 시작 시
// 사용자의 "기본 이미지 모델" 선택을 그 run에만 주입한다. 싱글턴 런타임의
// mutable default를 변경하지 않으므로 동시 run끼리 섞이지 않는다.
//
// 우선순위(§4.1): 툴 args(현재 사용자 턴 명시) > 이 기본값 > env > 내장.
// - input.providerId가 이미 있으면(툴 args) 프로바이더는 건드리지 않는다.
//   같은 프로바이더일 때만 모델 기본값을 채운다(다른 프로바이더를 명시했다면
//   그 프로바이더의 env/내장 모델로 흐른다).
// - 사용 가능 여부는 여기서 판정하지 않는다 — 미연결이면 런타임의 인증
//   수급이 명시적으로 실패한다(§4.2 fail-closed, 자동 폴백 없음).
export function withImageGenerationRequestDefaults(
  runtime: ImageGenerationRuntime,
  defaults: ImageGenerationRequestDefaults,
): ImageGenerationRuntime {
  return {
    generateImageArtifact(input: GenerateImageArtifactInput) {
      return runtime.generateImageArtifact(
        applyImageGenerationRequestDefaults(input, defaults),
      );
    },
    // 재적용은 대체(compose 아님) — run 시작 시 1회 적용이 계약이다
    withRequestDefaults(next: ImageGenerationRequestDefaults) {
      return withImageGenerationRequestDefaults(runtime, next);
    },
  };
}

export function applyImageGenerationRequestDefaults(
  input: GenerateImageArtifactInput,
  defaults: ImageGenerationRequestDefaults,
): GenerateImageArtifactInput {
  const providerId = input.providerId ?? defaults.providerId;
  const applyModelDefault =
    input.request.model === undefined && providerId === defaults.providerId;
  return {
    ...input,
    providerId,
    request: applyModelDefault
      ? { ...input.request, model: defaults.model }
      : input.request,
  };
}
