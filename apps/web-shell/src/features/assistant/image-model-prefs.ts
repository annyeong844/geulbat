// 기본 이미지 모델 설정(image-generation-open §3) — [+] 메뉴 "이미지 ›"
// 서브패널이 소유한다. localStorage에 남고, 구독자(메뉴 행 현재값 표시,
// run 요청 빌더)는 즉시 따라간다. 무선택 상태(null)를 허용한다 — 그때만
// 데몬 env/내장 기본값이 적용된다(§4.2).

import {
  isImageGenerationModelId,
  type ImageGenerationModelId,
} from '@geulbat/protocol/run-contract';

const IMAGE_MODEL_PREF_KEY = 'geulbat.imageGenerationModelDefault';

// S3 게이트(§6): 라이브 검증을 통과한 모델만 선택 가능하다. GPT 이미지 2는
// codex 전송 경로 S3 라이브 검증 통과(2026-07-13, openai_codex_direct 실생성
// E2E PASS)로 활성화됨.
export const VERIFIED_IMAGE_GENERATION_MODEL_IDS: ReadonlySet<ImageGenerationModelId> =
  new Set(['grok-imagine-image', 'grok-imagine-image-quality', 'gpt-image-2']);

let cachedPref: ImageGenerationModelId | null | undefined;
const listeners = new Set<() => void>();

function readStoredPref(): ImageGenerationModelId | null {
  try {
    const raw = globalThis.localStorage?.getItem(IMAGE_MODEL_PREF_KEY);
    // 카탈로그에서 제거된(또는 오염된) 저장값은 무선택으로 취급한다 —
    // 알 수 없는 id를 run 요청에 실으면 계약 가드가 채팅 전체를 거부하므로
    // (fail-closed), 여기서는 "다른 모델로 대체"가 아니라 "선택 없음"으로만
    // 다룬다. 저장값 자체는 지우지 않는다(카탈로그 복귀 시 되살아난다).
    return isImageGenerationModelId(raw) ? raw : null;
  } catch {
    return null;
  }
}

export function getImageGenerationModelPref(): ImageGenerationModelId | null {
  if (cachedPref === undefined) {
    cachedPref = readStoredPref();
  }
  return cachedPref;
}

export function setImageGenerationModelPref(
  value: ImageGenerationModelId | null,
): void {
  cachedPref = value;
  try {
    if (value === null) {
      globalThis.localStorage?.removeItem(IMAGE_MODEL_PREF_KEY);
    } else {
      globalThis.localStorage?.setItem(IMAGE_MODEL_PREF_KEY, value);
    }
  } catch {
    // 저장 불가 환경에서는 세션 내 동작만 유지
  }
  for (const listener of listeners) {
    listener();
  }
}

export function subscribeImageGenerationModelPref(
  listener: () => void,
): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

// SSR/정적 렌더 스냅샷 — 무선택
export function getImageGenerationModelPrefServerSnapshot(): ImageGenerationModelId | null {
  return null;
}
