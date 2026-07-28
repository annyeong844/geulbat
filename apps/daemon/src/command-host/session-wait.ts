import type { SessionEntry } from './session-core.js';

/**
 * P7.5 spec v4 §4.6 — 유계 대기. 명령은 끝나지 않을 수 있어도 **턴은 반드시
 * 끝나야 한다**. 여기 있는 대기들은 모두 상한을 갖거나 취소로 끝나며, 어느
 * 쪽도 자식 프로세스를 죽이지 않는다: 기다림만 끊는다.
 *
 * 이 모듈은 세션 레지스트리를 보지 않는다. 넘겨받은 `SessionEntry`의 revision·
 * terminal·waiter 집합만 읽는다.
 */

function createYieldTimer(yieldTimeMs: number): {
  promise: Promise<void>;
  cancel(): void;
} {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const promise = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, yieldTimeMs);
    timer.unref?.();
  });
  return {
    promise,
    cancel() {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
    },
  };
}

export async function waitForPromiseOrAbort(
  promise: Promise<void>,
  signal: AbortSignal | undefined,
): Promise<
  { ok: true } | { ok: false; reasonCode: 'wait_aborted'; message: string }
> {
  if (signal?.aborted) {
    return {
      ok: false,
      reasonCode: 'wait_aborted',
      message: 'host command wait was aborted.',
    };
  }
  if (signal === undefined) {
    await promise;
    return { ok: true };
  }
  return await new Promise((resolve) => {
    const onAbort = () => {
      resolve({
        ok: false,
        reasonCode: 'wait_aborted',
        message: 'host command wait was aborted.',
      });
    };
    signal.addEventListener('abort', onAbort, { once: true });
    void promise.then(() => {
      signal.removeEventListener('abort', onAbort);
      resolve({ ok: true });
    });
  });
}

export async function waitForChange(
  entry: SessionEntry,
  args: {
    afterRevision: number;
    yieldTimeMs: number;
    signal: AbortSignal | undefined;
  },
): Promise<
  { ok: true } | { ok: false; reasonCode: 'wait_aborted'; message: string }
> {
  if (entry.revision !== args.afterRevision || entry.terminal !== null) {
    return { ok: true };
  }
  let onChange: (() => void) | undefined;
  const changed = new Promise<void>((resolve) => {
    onChange = resolve;
    entry.outputWaiters.add(onChange);
  });
  const timer = createYieldTimer(args.yieldTimeMs);
  try {
    return await waitForPromiseOrAbort(
      Promise.race([changed, timer.promise]),
      args.signal,
    );
  } finally {
    if (onChange !== undefined) {
      entry.outputWaiters.delete(onChange);
    }
    timer.cancel();
  }
}

export function boundaryPromise(
  entry: SessionEntry,
  yieldTimeMs: number,
): Promise<void> {
  const timer = createYieldTimer(yieldTimeMs);
  return Promise.race([entry.exit, timer.promise]).finally(() => {
    timer.cancel();
  });
}
