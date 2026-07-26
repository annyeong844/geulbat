import { AsyncLocalStorage } from 'node:async_hooks';

// 데몬이 지금 **누구의 일을** 하고 있는가.
//
// 예외는 소유자를 달고 오지 않는다. 스택은 어디서 터졌는지 말해주지만 "어느
// run의, 어느 도구 때문이었는지"는 말해주지 않는다. 그래서 프로세스가 죽을 때
// 귀속의 근거가 되는 것은 이 스코프 하나다 — 이것이 비어 있다면 그 죽음은
// 데몬 자신의 이유다.
//
// 여기는 관찰만 한다: 스코프는 실패를 잡지도, 바꾸지도, 삼키지도 않는다.

export interface DaemonActivity {
  runId?: string;
  threadId?: string;
  toolName?: string;
  callId?: string;
}

const storage = new AsyncLocalStorage<DaemonActivity>();

/**
 * 중첩은 덮어쓰기가 아니라 **병합**이다. run 안에서 도구가 도는 것이 정상이고,
 * 그때 필요한 답은 "어느 run의 어느 도구"이지 둘 중 하나가 아니다.
 */
export function withActivityScope<T>(
  activity: DaemonActivity,
  run: () => T,
): T {
  return storage.run(mergeActivity(storage.getStore(), activity), run);
}

export function currentActivity(): DaemonActivity | undefined {
  const store = storage.getStore();
  return store === undefined || Object.keys(store).length === 0
    ? undefined
    : store;
}

function mergeActivity(
  base: DaemonActivity | undefined,
  next: DaemonActivity,
): DaemonActivity {
  // 명시되지 않은 항은 바깥 스코프의 답을 지우지 않는다.
  const merged: DaemonActivity = { ...base };
  if (next.runId !== undefined) {
    merged.runId = next.runId;
  }
  if (next.threadId !== undefined) {
    merged.threadId = next.threadId;
  }
  if (next.toolName !== undefined) {
    merged.toolName = next.toolName;
  }
  if (next.callId !== undefined) {
    merged.callId = next.callId;
  }
  return merged;
}
