import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import { iterateWebSocketEvents } from './responses-websocket-stream.js';

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function createFakeSocket(): EventEmitter {
  return new EventEmitter();
}

void test('iterateWebSocketEvents yields parsed frames and completes on response.completed', async () => {
  const socket = createFakeSocket();
  const iterator = iterateWebSocketEvents(socket);

  const firstFrame = iterator.next();
  socket.emit(
    'message',
    Buffer.from(
      JSON.stringify({ type: 'response.output_text.delta', delta: 'a' }),
    ),
  );
  assert.deepEqual(await firstFrame, {
    done: false,
    value: { type: 'response.output_text.delta', delta: 'a' },
  });

  const completionFrame = iterator.next();
  socket.emit(
    'message',
    Buffer.from(JSON.stringify({ type: 'response.completed' })),
  );
  assert.deepEqual(await completionFrame, {
    done: false,
    value: { type: 'response.completed' },
  });

  assert.deepEqual(await iterator.next(), { done: true, value: undefined });
});

void test('iterateWebSocketEvents waits for the selected completion event type', async () => {
  const socket = createFakeSocket();
  const iterator = iterateWebSocketEvents(socket, undefined, [
    'response.completed',
  ]);

  const doneFrame = iterator.next();
  socket.emit(
    'message',
    Buffer.from(JSON.stringify({ type: 'response.done' })),
  );
  assert.deepEqual(await doneFrame, {
    done: false,
    value: { type: 'response.done' },
  });

  const completionFrame = iterator.next();
  socket.emit(
    'message',
    Buffer.from(JSON.stringify({ type: 'response.completed' })),
  );
  assert.deepEqual(await completionFrame, {
    done: false,
    value: { type: 'response.completed' },
  });
  assert.deepEqual(await iterator.next(), { done: true, value: undefined });
});

void test('iterateWebSocketEvents preserves websocket frame order when decode timings differ', async () => {
  const socket = createFakeSocket();
  const iterator = iterateWebSocketEvents(socket);
  const firstPayload = createDeferred<ArrayBuffer>();

  const firstFrame = iterator.next();
  socket.emit('message', {
    arrayBuffer: async () => firstPayload.promise,
  });
  socket.emit(
    'message',
    Buffer.from(JSON.stringify({ type: 'response.completed' })),
  );

  firstPayload.resolve(
    new TextEncoder().encode(
      JSON.stringify({ type: 'response.output_text.delta', delta: 'a' }),
    ).buffer,
  );

  assert.deepEqual(await firstFrame, {
    done: false,
    value: { type: 'response.output_text.delta', delta: 'a' },
  });
  assert.deepEqual(await iterator.next(), {
    done: false,
    value: { type: 'response.completed' },
  });
  assert.deepEqual(await iterator.next(), { done: true, value: undefined });
});

void test('iterateWebSocketEvents surfaces blob-like decode failures instead of swallowing them', async () => {
  const socket = createFakeSocket();
  const iterator = iterateWebSocketEvents(socket);

  const nextFrame = iterator.next();
  socket.emit('message', {
    arrayBuffer: async () => {
      throw new Error('decode failed');
    },
  });

  await assert.rejects(
    nextFrame,
    /invalid provider websocket frame: decode failed/,
  );
});

void test('iterateWebSocketEvents rejects blob-like frames whose reader does not return an ArrayBuffer', async () => {
  const socket = createFakeSocket();
  const iterator = iterateWebSocketEvents(socket);

  const nextFrame = iterator.next();
  socket.emit('message', {
    arrayBuffer: async () =>
      new TextEncoder().encode(JSON.stringify({ type: 'response.completed' })),
  });

  await assert.rejects(
    nextFrame,
    /invalid provider websocket frame: arrayBuffer\(\) did not return an ArrayBuffer/,
  );
});

void test('iterateWebSocketEvents surfaces websocket error events', async () => {
  const socket = createFakeSocket();
  const iterator = iterateWebSocketEvents(socket);

  const nextFrame = iterator.next();
  const failure = new Error('socket broke');
  socket.emit('error', failure);

  await assert.rejects(nextFrame, (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal(error.message, failure.message);
    assert.equal(Reflect.get(error, 'llmCode'), 'llm_connection_lost');
    return true;
  });
});

void test('iterateWebSocketEvents rejects when the socket closes before completion', async () => {
  const socket = createFakeSocket();
  const iterator = iterateWebSocketEvents(socket);

  const nextFrame = iterator.next();
  socket.emit('close', {
    code: 1006,
    reason: 'abnormal close',
  });

  await assert.rejects(nextFrame, /WebSocket closed 1006 abnormal close/);
});

void test('iterateWebSocketEvents rejects when the caller aborts the stream', async () => {
  const socket = createFakeSocket();
  const controller = new AbortController();
  const iterator = iterateWebSocketEvents(socket, controller.signal);

  const nextFrame = iterator.next();
  controller.abort();

  await assert.rejects(nextFrame, /Request was aborted/);
});
