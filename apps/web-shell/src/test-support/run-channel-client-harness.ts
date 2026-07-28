import assert from 'node:assert/strict';

import type {
  RunChannelClientMessage,
  RunChannelServerMessage,
} from '@geulbat/protocol/run-channel';

import { RunChannelClient } from '../lib/run-channel/client.js';

// run-channel 클라이언트 테스트 하네스. client.test.ts 안의 지역 하네스였고,
// 제어 응답 상관 테마를 별도 owner 테스트로 분리할 때 두 파일이 같은
// 하네스를 쓰도록 여기로 올렸다. 본문은 이동 전과 동일하다.
export const TEST_COMPUTER_SESSION_ID = 'computer-session-harness';

class ManualScheduler {
  private nextId = 1;
  private tasks = new Map<number, { callback: () => void; delayMs: number }>();

  schedule = (callback: () => void, delayMs: number): number => {
    const id = this.nextId;
    this.nextId += 1;
    this.tasks.set(id, { callback, delayMs });
    return id;
  };

  clear = (handle: unknown): void => {
    if (typeof handle !== 'number') {
      return;
    }
    this.tasks.delete(handle);
  };

  get size(): number {
    return this.tasks.size;
  }

  peekDelay(): number | null {
    const first = this.tasks.values().next().value as
      | { delayMs: number }
      | undefined;
    return first?.delayMs ?? null;
  }

  runNext(): void {
    const first = this.tasks.entries().next().value as
      | [number, { callback: () => void }]
      | undefined;
    assert.ok(first);
    const [id, task] = first;
    this.tasks.delete(id);
    task.callback();
  }
}

type FakeSocketEventMap = {
  open: undefined;
  message: { data: string };
  close: undefined;
  error: undefined;
};

class FakeSocket {
  readyState = 0;
  sent: string[] = [];

  private listeners: Record<
    keyof FakeSocketEventMap,
    Array<{ listener: (event: unknown) => void; once: boolean }>
  > = {
    open: [],
    message: [],
    close: [],
    error: [],
  };

  addEventListener<K extends keyof FakeSocketEventMap>(
    type: K,
    listener: (event: FakeSocketEventMap[K]) => void,
    options?: { once?: boolean },
  ): void {
    this.listeners[type].push({
      listener: listener as (event: unknown) => void,
      once: options?.once === true,
    });
  }

  removeEventListener<K extends keyof FakeSocketEventMap>(
    type: K,
    listener: (event: FakeSocketEventMap[K]) => void,
  ): void {
    this.listeners[type] = this.listeners[type].filter(
      (entry) => entry.listener !== (listener as (event: unknown) => void),
    );
  }

  listenerCount(type: keyof FakeSocketEventMap): number {
    return this.listeners[type].length;
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.readyState = 3;
    this.dispatch('close', undefined);
  }

  emitOpen(): void {
    this.readyState = 1;
    this.dispatch('open', undefined);
  }

  emitMessage(message: RunChannelServerMessage): void {
    this.emitRawMessage(JSON.stringify(message));
  }

  emitRawMessage(data: string): void {
    this.dispatch('message', { data });
  }

  emitError(): void {
    this.dispatch('error', undefined);
  }

  private dispatch<K extends keyof FakeSocketEventMap>(
    type: K,
    event: FakeSocketEventMap[K],
  ): void {
    const snapshot = [...this.listeners[type]];
    this.listeners[type] = this.listeners[type].filter(
      (entry) => entry.once !== true,
    );
    for (const entry of snapshot) {
      entry.listener(event);
    }
  }
}

export function parseAuthRequestId(socket: FakeSocket): string {
  assert.ok(socket.sent.length > 0);
  const authMessage = JSON.parse(
    socket.sent[0] ?? 'null',
  ) as RunChannelClientMessage;
  assert.equal(authMessage.type, 'run.auth');
  return authMessage.requestId;
}

export function createClientHarness(): {
  scheduler: ManualScheduler;
  sockets: FakeSocket[];
  messages: RunChannelServerMessage[];
  client: RunChannelClient;
} {
  const scheduler = new ManualScheduler();
  const sockets: FakeSocket[] = [];
  const messages: RunChannelServerMessage[] = [];
  const client = new RunChannelClient({
    getWebSocketUrl: () => 'ws://example.test/api/ws',
    buildAuthMessage: (requestId) => ({
      type: 'run.auth',
      requestId,
      token: 'test-token',
    }),
    createWebSocket: () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
    scheduleTask: scheduler.schedule,
    clearScheduledTask: scheduler.clear,
  });
  client.subscribe((message) => {
    messages.push(message);
  });
  return { scheduler, sockets, messages, client };
}

export function getSocket(sockets: FakeSocket[], index = 0): FakeSocket {
  const socket = sockets[index];
  assert.ok(socket);
  return socket;
}

export async function connectAuthenticatedClient(harness: {
  sockets: FakeSocket[];
  client: RunChannelClient;
}): Promise<FakeSocket> {
  const connectPromise = harness.client.connect();
  const socket = getSocket(harness.sockets);
  socket.emitOpen();
  socket.emitMessage({
    type: 'run.auth.ok',
    requestId: parseAuthRequestId(socket),
    ok: true,
    computerSessionId: TEST_COMPUTER_SESSION_ID,
  });
  await connectPromise;
  return socket;
}
