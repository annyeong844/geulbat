export interface PendingInterject {
  text: string;
  receivedSeq: number;
}

export interface RunInterjectBuffer {
  items: PendingInterject[];
  seq: number;
  // 즉시 반영 요청 — 에이전트 루프가 현재 라운드의 남은 도구 호출을
  // 건너뛰고 다음 소비 지점으로 빨리 가도록 하는 1회성 신호
  flushRequested: boolean;
}

// Shared by reference between RunState and ActiveRun; mutation stays on the
// daemon event loop and is only observed at explicit loop checkpoints.
export function createRunInterjectBuffer(): RunInterjectBuffer {
  return { items: [], seq: 0, flushRequested: false };
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
): void {
  buffer.items.unshift(...interjects);
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
  }
  return true;
}

// 큐가 비어 있으면 플러시할 것이 없으므로 false를 돌려준다(경합은 정상).
export function requestInterjectFlush(buffer: RunInterjectBuffer): boolean {
  if (buffer.items.length === 0) {
    return false;
  }
  buffer.flushRequested = true;
  return true;
}

export function isInterjectFlushRequested(buffer: RunInterjectBuffer): boolean {
  return buffer.flushRequested;
}

export function clearInterjectFlushRequest(buffer: RunInterjectBuffer): void {
  buffer.flushRequested = false;
}
