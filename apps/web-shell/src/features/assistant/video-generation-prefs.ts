// 동영상 생성 설정(video-generation-open §3/D-V3) — [+] 메뉴 "동영상 ›"
// 설정 팝업이 소유한다. 이미지 prefs와 같은 localStorage+구독 패턴이고,
// 모델과 길이를 한 쌍으로 다룬다: 무선택(null) 상태면 run 요청에 아무것도
// 싣지 않는다(데몬 env/내장 기본값 전용 — §4.2).

import {
  isVideoGenerationModelId,
  VIDEO_GENERATION_ASPECT_RATIOS,
  VIDEO_GENERATION_MAX_DURATION_SECONDS,
  VIDEO_GENERATION_MIN_DURATION_SECONDS,
  VIDEO_GENERATION_RESOLUTIONS,
  type VideoGenerationAspectRatio,
  type VideoGenerationModelId,
  type VideoGenerationResolution,
} from '@geulbat/protocol/run-contract';

const VIDEO_MODEL_PREF_KEY = 'geulbat.videoGenerationModelDefault';
const VIDEO_DURATION_PREF_KEY = 'geulbat.videoGenerationDurationSeconds';
const VIDEO_ASPECT_RATIO_PREF_KEY = 'geulbat.videoGenerationAspectRatio';
const VIDEO_RESOLUTION_PREF_KEY = 'geulbat.videoGenerationResolution';

// S3 게이트(§6) — 사용자 결정(2026-07-13)으로 팝업에서 즉시 조작 가능하게
// 오픈. 데몬 런타임은 단위테스트 25종+S0 실측으로 검증됨(라이브 E2E는
// 사용자 서버에서 수행).
export const VERIFIED_VIDEO_GENERATION_MODEL_IDS: ReadonlySet<VideoGenerationModelId> =
  new Set(['grok-imagine-video-1.5']);

export interface VideoGenerationPref {
  model: VideoGenerationModelId;
  durationSeconds?: number;
  aspectRatio?: VideoGenerationAspectRatio;
  resolution?: VideoGenerationResolution;
}

let cachedPref: VideoGenerationPref | null | undefined;
const listeners = new Set<() => void>();

function isValidDurationSeconds(value: number): boolean {
  return (
    Number.isInteger(value) &&
    value >= VIDEO_GENERATION_MIN_DURATION_SECONDS &&
    value <= VIDEO_GENERATION_MAX_DURATION_SECONDS
  );
}

function readStoredPref(): VideoGenerationPref | null {
  try {
    const rawModel = globalThis.localStorage?.getItem(VIDEO_MODEL_PREF_KEY);
    // 카탈로그 밖(또는 오염된) 저장값은 무선택 취급 — 미지 id를 실으면
    // 계약 가드가 채팅 전체를 거부하므로(fail-closed) 여기서는 "선택
    // 없음"으로만 다룬다. 저장값 자체는 지우지 않는다(이미지 prefs 승계).
    if (!isVideoGenerationModelId(rawModel)) {
      return null;
    }
    const rawDuration = globalThis.localStorage?.getItem(
      VIDEO_DURATION_PREF_KEY,
    );
    const durationSeconds =
      rawDuration === null || rawDuration === undefined
        ? undefined
        : Number.parseInt(rawDuration, 10);
    const rawAspectRatio = globalThis.localStorage?.getItem(
      VIDEO_ASPECT_RATIO_PREF_KEY,
    );
    const rawResolution = globalThis.localStorage?.getItem(
      VIDEO_RESOLUTION_PREF_KEY,
    );
    const aspectRatio = VIDEO_GENERATION_ASPECT_RATIOS.find(
      (candidate) => candidate === rawAspectRatio,
    );
    const resolution = VIDEO_GENERATION_RESOLUTIONS.find(
      (candidate) => candidate === rawResolution,
    );
    return {
      model: rawModel,
      ...(durationSeconds !== undefined &&
      isValidDurationSeconds(durationSeconds)
        ? { durationSeconds }
        : {}),
      ...(aspectRatio !== undefined ? { aspectRatio } : {}),
      ...(resolution !== undefined ? { resolution } : {}),
    };
  } catch {
    return null;
  }
}

export function getVideoGenerationPref(): VideoGenerationPref | null {
  if (cachedPref === undefined) {
    cachedPref = readStoredPref();
  }
  return cachedPref;
}

export function setVideoGenerationPref(
  value: VideoGenerationPref | null,
): void {
  cachedPref = value;
  try {
    if (value === null) {
      globalThis.localStorage?.removeItem(VIDEO_MODEL_PREF_KEY);
      globalThis.localStorage?.removeItem(VIDEO_DURATION_PREF_KEY);
      globalThis.localStorage?.removeItem(VIDEO_ASPECT_RATIO_PREF_KEY);
      globalThis.localStorage?.removeItem(VIDEO_RESOLUTION_PREF_KEY);
    } else {
      globalThis.localStorage?.setItem(VIDEO_MODEL_PREF_KEY, value.model);
      if (value.durationSeconds === undefined) {
        globalThis.localStorage?.removeItem(VIDEO_DURATION_PREF_KEY);
      } else {
        globalThis.localStorage?.setItem(
          VIDEO_DURATION_PREF_KEY,
          String(value.durationSeconds),
        );
      }
      if (value.aspectRatio === undefined) {
        globalThis.localStorage?.removeItem(VIDEO_ASPECT_RATIO_PREF_KEY);
      } else {
        globalThis.localStorage?.setItem(
          VIDEO_ASPECT_RATIO_PREF_KEY,
          value.aspectRatio,
        );
      }
      if (value.resolution === undefined) {
        globalThis.localStorage?.removeItem(VIDEO_RESOLUTION_PREF_KEY);
      } else {
        globalThis.localStorage?.setItem(
          VIDEO_RESOLUTION_PREF_KEY,
          value.resolution,
        );
      }
    }
  } catch {
    // 저장 불가 환경에서는 세션 내 동작만 유지
  }
  for (const listener of listeners) {
    listener();
  }
}

export function subscribeVideoGenerationPref(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

// SSR/정적 렌더 스냅샷 — 무선택
export function getVideoGenerationPrefServerSnapshot(): VideoGenerationPref | null {
  return null;
}
