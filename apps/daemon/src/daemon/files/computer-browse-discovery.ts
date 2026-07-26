import { createLogger } from '@geulbat/structured-logger/logger';

import type { ComputerFileScope } from './computer-file-scope.js';

// 브라우즈 위치 발견의 공통 수명 주기 — OS 무관. 부팅은 명령 실행 없이
// 즉시 끝나고, 이 루프가 백그라운드에서 발견을 실행해 성공하는 순간 스코프
// 객체를 제자리 갱신한다(라우트는 같은 객체를 참조하므로 다음 요청부터
// 반영). 실패는 동결되지 않고 백오프로 재시도된다 — "일시 실패 = 영구
// 기능 상실"이라는 구조적 결함의 제거가 이 모듈의 존재 이유다.

const logger = createLogger('computer-browse-discovery');

const DEFAULT_RETRY_DELAYS_MS: readonly number[] = [
  0, 5_000, 15_000, 60_000, 300_000,
];
// 300초 간격까지 늘어난 뒤에도 계속 시도하되, 영원히 로그를 쌓지 않도록
// 상한을 둔다 — 20회면 약 80분. 그 뒤에도 실패라면 이 머신에서 발견
// 명령 자체가 불가능한 상태이고, 다음 데몬 부팅에서 다시 시작한다.
const DEFAULT_MAX_ATTEMPTS = 20;

interface ComputerBrowseDiscoveryResult {
  browseShortcuts: Array<{ label: string; path: string }>;
  complete: boolean;
}

export async function runComputerBrowseDiscoveryLoop(args: {
  scope: ComputerFileScope;
  discover: () => Promise<ComputerBrowseDiscoveryResult>;
  retryDelaysMs?: readonly number[];
  maxAttempts?: number;
  wait?: (delayMs: number) => Promise<void>;
}): Promise<void> {
  const delays = args.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;
  const maxAttempts = args.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const wait = args.wait ?? waitWithUnrefTimer;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const delayMs = delays[Math.min(attempt, delays.length - 1)] ?? 0;
    if (delayMs > 0) {
      await wait(delayMs);
    }
    try {
      const result = await args.discover();
      // 발견이 불완전해도 그 회차에 확보된 위치(드라이브·XDG 등)는 즉시
      // 반영한다 — 갱신은 항상 전체 교체라 부분 성공이 섞여 쌓이지 않는다.
      args.scope.browseShortcuts.splice(
        0,
        args.scope.browseShortcuts.length,
        ...result.browseShortcuts,
      );
      if (result.complete) {
        if (attempt > 0) {
          logger.info(
            `browse-location discovery converged after ${attempt + 1} attempts`,
          );
        }
        return;
      }
      logger.warn(
        `browse-location discovery incomplete (attempt ${attempt + 1}/${maxAttempts}); retrying`,
      );
    } catch (error: unknown) {
      logger.warn(
        `browse-location discovery attempt ${attempt + 1}/${maxAttempts} failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
  logger.warn(
    'browse-location discovery did not converge; keeping command-free locations until the next daemon start',
  );
}

function waitWithUnrefTimer(delayMs: number): Promise<void> {
  return new Promise((resolveWait) => {
    const timer = setTimeout(resolveWait, delayMs);
    timer.unref();
  });
}
