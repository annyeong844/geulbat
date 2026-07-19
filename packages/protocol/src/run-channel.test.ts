import assert from 'node:assert/strict';
import test from 'node:test';

import {
  isRunAuthMessage,
  isRunCancelMessage,
  isRunChannelServerMessage,
  isRunEventAckEnvelope,
  isRunInterjectEnvelope,
  isRunInterjectFlushEnvelope,
  isRunToolEnvelope,
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
      traceId: 'future-diagnostic-field',
    }),
    true,
  );
});

void test('client authorization and mutation requests reject unknown intent fields', () => {
  assert.equal(
    isRunAuthMessage({
      type: 'run.auth',
      requestId: 'auth-1',
      token: 'token',
    }),
    true,
  );
  assert.equal(
    isRunAuthMessage({
      type: 'run.auth',
      requestId: 'auth-1',
      token: 'token',
      audience: 'future-daemon',
    }),
    false,
  );
  assert.equal(
    isRunCancelMessage({
      type: 'run.cancel',
      requestId: 'cancel-1',
      request: { runId: 'run-1', force: true },
    }),
    false,
  );
});

void test('opaque client envelopes remain additive before full request decoding', () => {
  assert.equal(
    isRunToolEnvelope({
      type: 'run.tool',
      requestId: 'tool-1',
      request: {},
      traceId: 'future-diagnostic-field',
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
  assert.equal(
    isRunEventAckEnvelope({
      ...message,
      request: { ...message.request, futureCursor: 2 },
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

void test('run.tool failures use the owned daemon and frame-bridge error-code set', () => {
  const base = {
    type: 'run.control',
    requestId: 'tool-1',
    action: 'run.tool',
    ok: true,
  };

  assert.equal(
    isRunChannelServerMessage({
      ...base,
      result: {
        ok: false,
        errorCode: 'unavailable',
        error: 'tool bridge unavailable',
      },
    }),
    true,
  );
  assert.equal(
    isRunChannelServerMessage({
      ...base,
      result: {
        ok: false,
        errorCode: 'approval_required',
        error: 'approval required',
      },
    }),
    true,
  );
  assert.equal(
    isRunChannelServerMessage({
      ...base,
      result: {
        ok: false,
        errorCode: 'future_tool_failure',
        error: 'unknown failure',
      },
    }),
    false,
  );
});

void test('server projections accept additive informational fields', () => {
  assert.equal(
    isRunChannelServerMessage({
      type: 'run.control',
      requestId: 'cancel-1',
      action: 'run.cancel',
      ok: true,
      diagnosticTraceId: 'trace-1',
    }),
    true,
  );
  assert.equal(
    isRunChannelServerMessage({
      type: 'run.error',
      requestId: 'error-1',
      code: 'internal',
      message: 'boom',
      status: 500,
      retryable: false,
    }),
    true,
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
