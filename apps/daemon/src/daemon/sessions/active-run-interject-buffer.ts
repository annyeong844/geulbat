export interface PendingInterject {
  text: string;
  receivedSeq: number;
}

export interface RunInterjectBuffer {
  items: PendingInterject[];
  seq: number;
  accepting: boolean;
  // 즉시 반영 요청 — 에이전트 루프가 현재 라운드의 남은 도구 호출을
  // 건너뛰고 다음 소비 지점으로 빨리 가도록 하는 1회성 신호
  flushRequested: boolean;
  subscribeFlush(listener: () => void): () => void;
}

const interjectFlushListeners = new WeakMap<
  RunInterjectBuffer,
  Set<() => void>
>();

// 아직 어떤 라운드에도 전달되지 않은 즉시 반영 신호.
//
// `flushRequested`는 소비 1회까지 남아 있어야 한다(남은 도구 호출 건너뛰기가
// 그것을 읽는다). 하지만 라운드 중단은 요청 1건당 **한 번만** 일어나야 한다.
// 둘을 같은 플래그로 다루면, 라운드마다 새로 구독하는 에이전트 루프가 구독
// 즉시 중단 신호를 다시 받아 사용자가 누르지 않은 라운드까지 끊는다.
const undeliveredFlushInterrupts = new WeakSet<RunInterjectBuffer>();

// 듣는 라운드가 없으면 신호를 보관한다 — 라운드 사이에 도착한 요청은 다음
// 라운드가 구독할 때 전달되어야 한다.
function deliverFlushInterrupt(buffer: RunInterjectBuffer): void {
  if (!undeliveredFlushInterrupts.has(buffer)) {
    return;
  }
  const listeners = interjectFlushListeners.get(buffer);
  if (listeners === undefined || listeners.size === 0) {
    return;
  }
  undeliveredFlushInterrupts.delete(buffer);
  for (const listener of [...listeners]) {
    listener();
  }
}

function subscribeInterjectFlush(
  buffer: RunInterjectBuffer,
  listener: () => void,
): () => void {
  let listeners = interjectFlushListeners.get(buffer);
  if (listeners === undefined) {
    listeners = new Set();
    interjectFlushListeners.set(buffer, listeners);
  }
  listeners.add(listener);
  deliverFlushInterrupt(buffer);
  return () => {
    listeners?.delete(listener);
    if (listeners?.size === 0) {
      interjectFlushListeners.delete(buffer);
    }
  };
}

// Shared by reference between RunState and ActiveRun; mutation stays on the
// daemon event loop and is only observed at explicit loop checkpoints.
export function createRunInterjectBuffer(): RunInterjectBuffer {
  const buffer: RunInterjectBuffer = {
    items: [],
    seq: 0,
    accepting: true,
    flushRequested: false,
    subscribeFlush(listener) {
      return subscribeInterjectFlush(buffer, listener);
    },
  };
  return buffer;
}

export function pushPendingInterject(
  buffer: RunInterjectBuffer,
  text: string,
): { receivedSeq: number; bufferDepth: number } {
  buffer.seq += 1;
  buffer.items.push({ text, receivedSeq: buffer.seq });
  return { receivedSeq: buffer.seq, bufferDepth: buffer.items.length };
}

export function takePendingInterject(
  buffer: RunInterjectBuffer,
): PendingInterject[] {
  return buffer.items.splice(0);
}

export function hasPendingInterject(buffer: RunInterjectBuffer): boolean {
  return buffer.items.length > 0;
}

export function restorePendingInterjectFront(
  buffer: RunInterjectBuffer,
  interjects: PendingInterject[],
  lastReceivedSeq?: number,
): void {
  buffer.items.unshift(...interjects);
  buffer.seq = Math.max(
    buffer.seq,
    lastReceivedSeq ?? 0,
    ...interjects.map((interject) => interject.receivedSeq),
  );
}

export function closeInterjectBuffer(buffer: RunInterjectBuffer): void {
  buffer.accepting = false;
}

export function peekPendingInterject(
  buffer: RunInterjectBuffer,
): PendingInterject | undefined {
  return buffer.items[0];
}

export function dropPendingInterjectFront(
  buffer: RunInterjectBuffer,
): PendingInterject | undefined {
  return buffer.items.shift();
}

export function removePendingInterjectBySeq(
  buffer: RunInterjectBuffer,
  receivedSeq: number,
): boolean {
  const index = buffer.items.findIndex(
    (item) => item.receivedSeq === receivedSeq,
  );
  if (index < 0) {
    return false;
  }
  buffer.items.splice(index, 1);
  if (buffer.items.length === 0) {
    buffer.flushRequested = false;
    undeliveredFlushInterrupts.delete(buffer);
  }
  return true;
}

// 큐가 비어 있으면 플러시할 것이 없으므로 false를 돌려준다(경합은 정상).
export function requestInterjectFlush(buffer: RunInterjectBuffer): boolean {
  if (buffer.items.length === 0 || buffer.flushRequested) {
    return false;
  }
  buffer.flushRequested = true;
  undeliveredFlushInterrupts.add(buffer);
  deliverFlushInterrupt(buffer);
  return true;
}

export function isInterjectFlushRequested(buffer: RunInterjectBuffer): boolean {
  return buffer.flushRequested;
}

export function clearInterjectFlushRequest(buffer: RunInterjectBuffer): void {
  buffer.flushRequested = false;
  // 요청이 목적을 다했으면 아직 전달되지 않은 중단 신호도 버린다.
  undeliveredFlushInterrupts.delete(buffer);
}
