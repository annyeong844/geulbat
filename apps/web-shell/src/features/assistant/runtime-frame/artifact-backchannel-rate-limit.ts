// 아티팩트 프레임 back-channel 레이트리밋 (설계 구현순서 7, 보안 체크리스트
// "레이트리밋/디바운스 (scopeHandle 단위)"). 신뢰할 수 없는 프레임 코드가
// prompt/interject/tool 요청을 루프로 난사하는 것을 부모 번역 층 경계에서
// 차단한다. daemon 쪽 auth-failure-rate-limit과 같은 고정 윈도우 카운터 —
// 프레임 인스턴스(scopeHandle) 단위로 센다.
//
// 레인 분리: 프롬프트류(request_prompt/request_interject — 턴을 만든다)는
// 도구 호출(read-only 왕복)보다 훨씬 낮은 상한을 갖는다. 티어 B 강등도
// 턴을 만들므로 prompt 레인 예산을 소모한다.

export type ArtifactBackchannelLane = 'prompt' | 'tool';

const LANE_LIMITS: Record<
  ArtifactBackchannelLane,
  { windowMs: number; limit: number }
> = {
  prompt: { windowMs: 10_000, limit: 3 },
  tool: { windowMs: 10_000, limit: 10 },
};

// 유령 프레임이 윈도우 맵을 무한히 키우지 못하게 하는 상한 — 초과 시
// 만료가 가장 이른 윈도우부터 밀어낸다.
const MAX_BACKCHANNEL_WINDOWS = 1024;

interface BackchannelWindow {
  count: number;
  resetAt: number;
}

const backchannelWindows = new Map<string, BackchannelWindow>();

export function tryConsumeArtifactBackchannelBudget(
  scopeHandle: string,
  lane: ArtifactBackchannelLane,
  now = Date.now(),
): boolean {
  pruneExpiredBackchannelWindows(now);
  const { windowMs, limit } = LANE_LIMITS[lane];
  const key = `${lane}:${scopeHandle}`;
  const existing = backchannelWindows.get(key);

  if (!existing || now >= existing.resetAt) {
    backchannelWindows.set(key, { count: 1, resetAt: now + windowMs });
    pruneBackchannelWindowsToCap(key);
    return true;
  }

  if (existing.count >= limit) {
    return false;
  }
  existing.count += 1;
  return true;
}

export function resetArtifactBackchannelRateLimitForTests(): void {
  backchannelWindows.clear();
}

export function getArtifactBackchannelWindowCountForTests(): number {
  return backchannelWindows.size;
}

function pruneExpiredBackchannelWindows(now: number): void {
  for (const [key, window] of backchannelWindows) {
    if (now >= window.resetAt) {
      backchannelWindows.delete(key);
    }
  }
}

function pruneBackchannelWindowsToCap(protectedKey: string): void {
  if (backchannelWindows.size <= MAX_BACKCHANNEL_WINDOWS) {
    return;
  }

  const candidates = [...backchannelWindows.entries()]
    .filter(([key]) => key !== protectedKey)
    .sort((left, right) => left[1].resetAt - right[1].resetAt);

  let candidateIndex = 0;
  while (
    backchannelWindows.size > MAX_BACKCHANNEL_WINDOWS &&
    candidateIndex < candidates.length
  ) {
    const entry = candidates[candidateIndex];
    candidateIndex += 1;
    if (!entry) {
      break;
    }
    backchannelWindows.delete(entry[0]);
  }
}
