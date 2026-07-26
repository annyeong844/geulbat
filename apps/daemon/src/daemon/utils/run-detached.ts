import { createLogger, type Logger } from '@geulbat/structured-logger/logger';

import { currentActivity } from './activity-scope.js';
import { getErrorMessage } from './error.js';

// 호출자를 기다리게 하지 않는 일(분리 실행)의 단일 출구.
//
// `void somethingAsync()`는 거절을 아무도 받지 않는 상태를 만든다. Node는 그
// 거절을 프로세스 종료로 승격하므로, 한 하위 시스템의 실패가 데몬 전체를
// 죽인다. 데몬은 **자기 이유로만** 죽어야 하므로 남의 실패는 그 소유자에서
// 끝나야 한다.
//
// 삼키는 것이 아니다: 실패는 label과 활동 소유자를 달고 반드시 남는다.
// 기다려야 하는 일이라면 애초에 이 함수가 아니라 `await`가 답이다.

const detachedLogger = createLogger('detached');

export function runDetached(
  /** 무엇을 하던 일인지 — 실패가 남을 때 이것이 소유자 이름이 된다. */
  label: string,
  work: () => PromiseLike<unknown>,
  deps?: { logger?: Pick<Logger, 'error'> },
): void {
  const logger = deps?.logger ?? detachedLogger;
  let started: PromiseLike<unknown>;
  try {
    started = work();
  } catch (error: unknown) {
    // 동기 throw도 같은 실패다 — 시작조차 못 한 일이 조용히 사라지지 않는다.
    report(logger, label, error);
    return;
  }
  Promise.resolve(started).then(undefined, (error: unknown) => {
    report(logger, label, error);
  });
}

function report(
  logger: Pick<Logger, 'error'>,
  label: string,
  error: unknown,
): void {
  // 마지막 방어선이므로 보고 자체가 새로운 미처리 거절이 되어서는 안 된다.
  try {
    logger.error('detached work failed:', {
      label,
      owner: currentActivity() ?? 'daemon',
      message: getErrorMessage(error),
      ...(error instanceof Error && error.stack !== undefined
        ? { stack: error.stack }
        : {}),
    });
  } catch {
    // 로거가 죽으면 남길 곳이 없다. 그래도 프로세스는 이 실패로 죽지 않는다.
  }
}
