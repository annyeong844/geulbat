export interface PendingInterject {
  text: string;
  receivedSeq: number;
}

export interface RunInterjectBuffer {
  items: PendingInterject[];
  seq: number;
}

// Shared by reference between RunState and ActiveRun; mutation stays on the
// daemon event loop and is only observed at explicit loop checkpoints.
export function createRunInterjectBuffer(): RunInterjectBuffer {
  return { items: [], seq: 0 };
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
