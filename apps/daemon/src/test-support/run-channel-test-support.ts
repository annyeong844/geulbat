import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isRunChannelServerMessage } from '@geulbat/protocol/run-channel';
import type { RunChannelServerMessage } from '@geulbat/protocol/run-channel';
import WebSocket from 'ws';

import { createDaemonContext, type DaemonContext } from '../daemon/context.js';

class FakeSocket {
  readyState: number = WebSocket.OPEN;
  readonly sentFrames: string[] = [];
  readonly closeCalls: Array<{
    code: number | undefined;
    reason: string | undefined;
  }> = [];

  send(data: string | Buffer): void {
    this.sentFrames.push(String(data));
  }

  close(code?: number, reason?: string | Buffer): void {
    this.closeCalls.push({
      code,
      reason:
        reason === undefined
          ? undefined
          : typeof reason === 'string'
            ? reason
            : reason.toString('utf8'),
    });
    this.readyState = WebSocket.CLOSED;
  }
}

type TestSocket = WebSocket & FakeSocket;

export function createRunChannelTestDaemonContext(): DaemonContext {
  return createDaemonContext({
    homeStateRoot: join(tmpdir(), `geulbat-run-channel-test-${randomUUID()}`),
  });
}

export function createTestSocket(): TestSocket {
  return new FakeSocket() as TestSocket;
}

export function clearSentMessages(socket: TestSocket): void {
  socket.sentFrames.length = 0;
}

export function readLastSentMessage(
  socket: TestSocket,
): RunChannelServerMessage | undefined {
  const raw = socket.sentFrames.at(-1);
  return raw ? parseRunChannelServerMessage(raw) : undefined;
}

function parseRunChannelServerMessage(raw: string): RunChannelServerMessage {
  const parsed: unknown = JSON.parse(raw);
  if (!isRunChannelServerMessage(parsed)) {
    throw new Error(`invalid test websocket payload: ${raw}`);
  }
  return parsed;
}
