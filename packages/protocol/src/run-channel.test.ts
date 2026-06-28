import assert from 'node:assert/strict';
import test from 'node:test';

import {
  isRunChannelClientMessage,
  isRunChannelServerMessage,
  isRunInterjectEnvelope,
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

void test('run.control cancel ack still passes without interject fields', () => {
  assert.equal(
    isRunChannelServerMessage({
      type: 'run.control',
      requestId: 'req-1',
      action: 'run.cancel',
      ok: true,
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
