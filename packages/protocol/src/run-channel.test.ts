import assert from 'node:assert/strict';
import test from 'node:test';

import {
  isRunChannelClientMessage,
  isRunChannelServerMessage,
  isRunEventAckEnvelope,
  isRunInterjectEnvelope,
  isRunInterjectFlushEnvelope,
  type RunControlMessage,
} from './run-channel.js';

void test('isRunInterjectEnvelope accepts a well-formed envelope without inspecting request fields', () => {
  assert.equal(
    isRunInterjectEnvelope({
      type: 'run.interject',
      requestId: 'req-1',
      request: { runId: 'run_1', text: '' },
    }),
    true,
  );
  assert.equal(
    isRunInterjectEnvelope({
      type: 'run.interject',
      requestId: 'req-1',
      request: {},
    }),
    true,
  );
});

void test('isRunInterjectEnvelope rejects missing requestId or non-record request', () => {
  assert.equal(
    isRunInterjectEnvelope({ type: 'run.interject', request: {} }),
    false,
  );
  assert.equal(
    isRunInterjectEnvelope({
      type: 'run.interject',
      requestId: 'req-1',
      request: 1,
    }),
    false,
  );
  assert.equal(isRunInterjectEnvelope({ type: 'run.start' }), false);
});

void test('isRunChannelClientMessage accepts a run.interject envelope', () => {
  assert.equal(
    isRunChannelClientMessage({
      type: 'run.interject',
      requestId: 'req-1',
      request: { runId: 'run_1', text: 'hi' },
    }),
    true,
  );
});

void test('run.control interject ack requires integer receivedSeq and bufferDepth', () => {
  const base = {
    type: 'run.control',
    requestId: 'req-1',
    action: 'run.interject',
    ok: true,
  };

  assert.equal(
    isRunChannelServerMessage({
      ...base,
      receivedSeq: 1,
      bufferDepth: 0,
    }),
    true,
  );
  assert.equal(isRunChannelServerMessage(base), false);
  assert.equal(
    isRunChannelServerMessage({
      ...base,
      receivedSeq: 0,
      bufferDepth: 0,
    }),
    false,
  );
  assert.equal(
    isRunChannelServerMessage({
      ...base,
      receivedSeq: 1.5,
      bufferDepth: 0,
    }),
    false,
  );
  assert.equal(
    isRunChannelServerMessage({
      ...base,
      receivedSeq: 1,
      bufferDepth: -1,
    }),
    false,
  );
});

void test('run.control accepts every declared action shape', () => {
  const messages = {
    'run.cancel': {
      type: 'run.control',
      requestId: 'cancel-1',
      action: 'run.cancel',
      ok: true,
    },
    'run.approve': {
      type: 'run.control',
      requestId: 'approve-1',
      action: 'run.approve',
      ok: true,
    },
    'run.interject': {
      type: 'run.control',
      requestId: 'interject-1',
      action: 'run.interject',
      ok: true,
      receivedSeq: 1,
      bufferDepth: 0,
    },
    'run.interject.cancel': {
      type: 'run.control',
      requestId: 'interject-cancel-1',
      action: 'run.interject.cancel',
      ok: true,
      cancelled: false,
    },
    'run.interject.flush': {
      type: 'run.control',
      requestId: 'interject-flush-1',
      action: 'run.interject.flush',
      ok: true,
      flushed: false,
    },
    'run.event.ack': {
      type: 'run.control',
      requestId: 'event-ack-1',
      action: 'run.event.ack',
      ok: true,
      seq: 2,
    },
    'run.tool': {
      type: 'run.control',
      requestId: 'tool-1',
      action: 'run.tool',
      ok: true,
      result: { ok: true, output: '' },
    },
  } satisfies {
    [TAction in RunControlMessage['action']]: Extract<
      RunControlMessage,
      { action: TAction }
    >;
  };

  for (const message of Object.values(messages)) {
    assert.equal(isRunChannelServerMessage(message), true, message.action);
  }
});

void test('run event acknowledgement requires exact run, thread, and cursor identity', () => {
  const message = {
    type: 'run.event.ack',
    requestId: 'event-ack-1',
    request: {
      runId: 'run-event-ack',
      threadId: '123e4567-e89b-42d3-a456-426614174000',
      seq: 2,
    },
  };

  assert.equal(isRunEventAckEnvelope(message), true);
  assert.equal(isRunChannelClientMessage(message), true);
  assert.equal(
    isRunEventAckEnvelope({
      ...message,
      request: { ...message.request, seq: -1 },
    }),
    false,
  );
  assert.equal(
    isRunEventAckEnvelope({
      ...message,
      request: { ...message.request, threadId: '../thread' },
    }),
    false,
  );
});

void test('run.control rejects missing or mistyped action payload fields', () => {
  const messages = [
    {
      type: 'run.control',
      requestId: 'interject-cancel-1',
      action: 'run.interject.cancel',
      ok: true,
    },
    {
      type: 'run.control',
      requestId: 'interject-cancel-2',
      action: 'run.interject.cancel',
      ok: true,
      cancelled: 'yes',
    },
    {
      type: 'run.control',
      requestId: 'tool-1',
      action: 'run.tool',
      ok: true,
    },
    {
      type: 'run.control',
      requestId: 'tool-2',
      action: 'run.tool',
      ok: true,
      result: { ok: true, output: 1 },
    },
  ];

  for (const message of messages) {
    assert.equal(
      isRunChannelServerMessage(message),
      false,
      JSON.stringify(message),
    );
  }
});

void test('run.control rejects undeclared actions', () => {
  assert.equal(
    isRunChannelServerMessage({
      type: 'run.control',
      requestId: 'req-1',
      action: 'run.future',
      ok: true,
    }),
    false,
  );
});

void test('isRunChannelServerMessage rejects run.error messages with unknown error codes', () => {
  assert.equal(
    isRunChannelServerMessage({
      type: 'run.error',
      requestId: 'req-1',
      code: 'internal',
      message: 'boom',
      status: 500,
    }),
    true,
  );

  assert.equal(
    isRunChannelServerMessage({
      type: 'run.error',
      requestId: 'req-1',
      code: 'totally_new_error',
      message: 'boom',
      status: 500,
    }),
    false,
  );
});

void test('run.error rejects legacy interject-only no_active_run code', () => {
  assert.equal(
    isRunChannelServerMessage({
      type: 'run.error',
      requestId: 'req-1',
      code: 'no_active_run',
      message: 'failed',
      status: 404,
    }),
    false,
  );
});

void test('isRunInterjectFlushEnvelope accepts a well-formed envelope and rejects malformed ones', () => {
  assert.equal(
    isRunInterjectFlushEnvelope({
      type: 'run.interject.flush',
      requestId: 'req-1',
      request: { runId: 'run_1' },
    }),
    true,
  );
  assert.equal(
    isRunInterjectFlushEnvelope({ type: 'run.interject.flush', request: {} }),
    false,
  );
  assert.equal(
    isRunInterjectFlushEnvelope({
      type: 'run.interject.flush',
      requestId: 'req-1',
      request: 1,
    }),
    false,
  );
  assert.equal(isRunInterjectFlushEnvelope({ type: 'run.interject' }), false);
});

void test('isRunChannelClientMessage accepts a run.interject.flush envelope', () => {
  assert.equal(
    isRunChannelClientMessage({
      type: 'run.interject.flush',
      requestId: 'req-1',
      request: { runId: 'run_1' },
    }),
    true,
  );
});

void test('run.control interject flush ack requires a boolean flushed field', () => {
  assert.equal(
    isRunChannelServerMessage({
      type: 'run.control',
      requestId: 'req-1',
      action: 'run.interject.flush',
      ok: true,
      flushed: true,
    }),
    true,
  );
  assert.equal(
    isRunChannelServerMessage({
      type: 'run.control',
      requestId: 'req-1',
      action: 'run.interject.flush',
      ok: true,
    }),
    false,
  );
  assert.equal(
    isRunChannelServerMessage({
      type: 'run.control',
      requestId: 'req-1',
      action: 'run.interject.flush',
      ok: true,
      flushed: 'yes',
    }),
    false,
  );
});
