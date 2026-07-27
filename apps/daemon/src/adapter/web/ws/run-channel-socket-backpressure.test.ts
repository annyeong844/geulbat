import assert from 'node:assert/strict';
import test from 'node:test';
import type WebSocket from 'ws';

import { testRunId } from '../../../test-support/run-id.js';
import { testThreadId } from '../../../test-support/thread-id.js';
import { sendMessage, sendToolOutputDelta } from './run-channel-socket.js';

const OPEN = 1;
const THREAD_ID = testThreadId(9001);
const RUN_ID = testRunId(9001);

/**
 * A socket whose send queue never drains.
 *
 * `ws` accepts every frame and reports the unflushed byte count through
 * `bufferedAmount`, so a client that stops reading is modelled by accumulating
 * instead of clearing.
 */
function createBackedUpSocket(readyState = OPEN) {
  const sent: string[] = [];
  const socket = {
    readyState,
    bufferedAmount: 0,
    send(data: string) {
      sent.push(data);
      socket.bufferedAmount += data.length;
    },
  };
  return { socket: socket as unknown as WebSocket, sent };
}

function deltaPayload() {
  return {
    callId: 'call-1',
    tool: 'exec_command',
    stream: 'stdout' as const,
    text: 'x'.repeat(64 * 1024),
  };
}

void test('streaming deltas stop being queued once the client stops draining', () => {
  const { socket, sent } = createBackedUpSocket();

  let delivered = 0;
  let dropped = 0;
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (sendToolOutputDelta(socket, RUN_ID, THREAD_ID, deltaPayload())) {
      delivered += 1;
    } else {
      dropped += 1;
    }
  }

  assert.ok(delivered > 0, 'a draining client must still receive deltas');
  assert.ok(dropped > 0, 'a backed-up client must stop receiving deltas');
  assert.equal(sent.length, delivered);
  // The queue must stop growing rather than absorb every attempt.
  assert.ok(
    socket.bufferedAmount < 200 * deltaPayload().text.length,
    'dropped deltas must not reach the send queue',
  );
});

void test('durable events keep being queued while the client is backed up', () => {
  const { socket } = createBackedUpSocket();

  // Back the socket up past any droppable ceiling first.
  for (let attempt = 0; attempt < 200; attempt += 1) {
    sendToolOutputDelta(socket, RUN_ID, THREAD_ID, deltaPayload());
  }
  assert.equal(
    sendToolOutputDelta(socket, RUN_ID, THREAD_ID, deltaPayload()),
    false,
  );

  // A durable frame must still be handed to the transport: an undelivered
  // durable event becomes `buffered` and is replayed from the journal, so
  // refusing to queue it would drop it from that contract instead.
  assert.equal(
    sendMessage(socket, {
      type: 'run.error',
      status: 500,
      code: 'execution_failed',
      message: 'durable failure must survive backpressure',
    }),
    true,
  );
});

void test('a closed socket reports no delivery for either class', () => {
  const closed = createBackedUpSocket(3);

  assert.equal(
    sendToolOutputDelta(closed.socket, RUN_ID, THREAD_ID, deltaPayload()),
    false,
  );
  assert.equal(
    sendMessage(closed.socket, {
      type: 'run.error',
      status: 500,
      code: 'execution_failed',
      message: 'closed socket',
    }),
    false,
  );
  assert.equal(closed.sent.length, 0);
});
