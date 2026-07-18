// PTC execute_code cell 변경 신호기 — 전역/스레드별 revision 카운터와
// waiter 집합을 소유하는 wait-notify 백본. cell-registry의 모든 mutator가
// bumpRevision으로 변경을 알리고, cell-wait 경로가 wait*로 구독한다.
// 셀 레코드 타입에 의존하지 않는 독립 개념이라 registry 밖으로 분리됐다.
// 스레드 revision 프루닝의 "이 스레드가 비었는가" 판정만 isThreadIdle
// 콜백으로 주입받는다 — 셀 맵의 소유권은 registry에 남는다.

interface PtcExecuteCodeCellRevisionSignal {
  bumpRevision: (threadId?: string) => void;
  getRevision: () => number;
  getThreadRevision: (args: { threadId: string }) => number;
  waitForRevisionChange: (
    afterRevision: number,
    abortSignal?: AbortSignal,
  ) => Promise<number>;
  waitForThreadRevisionChange: (args: {
    threadId: string;
    afterRevision: number;
    abortSignal?: AbortSignal;
  }) => Promise<number>;
  waitUntilAbort: (abortSignal?: AbortSignal) => Promise<number>;
}

export function createPtcExecuteCodeCellRevisionSignal(args: {
  // 활성/보존 셀이 모두 비어 스레드 revision 엔트리를 정리해도 되는지 —
  // waiter 존재 여부는 신호기 내부에서 함께 확인한다.
  isThreadIdle: (threadId: string) => boolean;
}): PtcExecuteCodeCellRevisionSignal {
  const { isThreadIdle } = args;
  let revision = 0;
  const revisionWaiters = new Set<(nextRevision: number) => void>();
  const threadRevisions = new Map<string, number>();
  const threadRevisionWaiters = new Map<
    string,
    Set<(nextRevision: number) => void>
  >();

  function bumpRevision(threadId?: string): void {
    revision += 1;
    const waiters = [...revisionWaiters];
    revisionWaiters.clear();
    for (const waiter of waiters) {
      waiter(revision);
    }
    if (threadId !== undefined) {
      bumpThreadRevision(threadId);
      pruneThreadRevisionIfIdle(threadId);
    }
  }

  function bumpThreadRevision(threadId: string): void {
    const nextRevision = getThreadRevision({ threadId }) + 1;
    threadRevisions.set(threadId, nextRevision);
    const waiters = threadRevisionWaiters.get(threadId);
    if (waiters === undefined) {
      return;
    }
    threadRevisionWaiters.delete(threadId);
    for (const waiter of waiters) {
      waiter(nextRevision);
    }
  }

  function pruneThreadRevisionIfIdle(threadId: string): void {
    if (!isThreadIdle(threadId)) {
      return;
    }
    const waiters = threadRevisionWaiters.get(threadId);
    if (waiters !== undefined && waiters.size > 0) {
      return;
    }
    threadRevisions.delete(threadId);
  }

  function getRevision(): number {
    return revision;
  }

  function getThreadRevision(args: { threadId: string }): number {
    return threadRevisions.get(args.threadId) ?? 0;
  }

  function waitForRevisionChange(
    afterRevision: number,
    abortSignal?: AbortSignal,
  ): Promise<number> {
    if (revision !== afterRevision) {
      return Promise.resolve(revision);
    }

    return new Promise<number>((resolve, reject) => {
      let settled = false;
      const finish = (fn: () => void) => {
        if (settled) {
          return;
        }
        settled = true;
        revisionWaiters.delete(onRevisionChange);
        abortSignal?.removeEventListener('abort', onAbort);
        fn();
      };

      const onAbort = () => {
        finish(() => reject(new Error('PTC execute_code cell wait aborted')));
      };

      const onRevisionChange = (nextRevision: number) => {
        if (nextRevision === afterRevision) {
          return;
        }
        finish(() => resolve(nextRevision));
      };

      if (abortSignal?.aborted) {
        onAbort();
        return;
      }
      revisionWaiters.add(onRevisionChange);
      abortSignal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  function waitForThreadRevisionChange(args: {
    threadId: string;
    afterRevision: number;
    abortSignal?: AbortSignal;
  }): Promise<number> {
    const currentRevision = getThreadRevision({ threadId: args.threadId });
    if (currentRevision !== args.afterRevision) {
      return Promise.resolve(currentRevision);
    }

    return new Promise<number>((resolve, reject) => {
      let settled = false;
      const finish = (fn: () => void) => {
        if (settled) {
          return;
        }
        settled = true;
        const waiters = threadRevisionWaiters.get(args.threadId);
        waiters?.delete(onThreadRevisionChange);
        if (waiters?.size === 0) {
          threadRevisionWaiters.delete(args.threadId);
        }
        args.abortSignal?.removeEventListener('abort', onAbort);
        fn();
      };
      const onAbort = () => {
        finish(() =>
          reject(new Error('PTC execute_code cell thread wait aborted')),
        );
      };
      const onThreadRevisionChange = (nextRevision: number) => {
        if (nextRevision === args.afterRevision) {
          return;
        }
        finish(() => resolve(nextRevision));
      };

      if (args.abortSignal?.aborted) {
        onAbort();
        return;
      }
      const waiters =
        threadRevisionWaiters.get(args.threadId) ??
        new Set<(nextRevision: number) => void>();
      waiters.add(onThreadRevisionChange);
      threadRevisionWaiters.set(args.threadId, waiters);
      args.abortSignal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  function waitUntilAbort(abortSignal?: AbortSignal): Promise<number> {
    return new Promise<number>((_resolve, reject) => {
      const finish = () => {
        abortSignal?.removeEventListener('abort', onAbort);
        reject(new Error('PTC execute_code cell output wait aborted'));
      };
      const onAbort = () => {
        finish();
      };

      if (abortSignal?.aborted) {
        finish();
        return;
      }
      abortSignal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  return {
    bumpRevision,
    getRevision,
    getThreadRevision,
    waitForRevisionChange,
    waitForThreadRevisionChange,
    waitUntilAbort,
  };
}
