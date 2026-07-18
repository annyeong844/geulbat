import test from 'node:test';
import assert from 'node:assert/strict';
import { readRunChannelClientMessage } from './validate-run-channel-message.js';

void test('readRunChannelClientMessage accepts valid run.auth payloads', () => {
  const result = readRunChannelClientMessage({
    type: 'run.auth',
    requestId: 'req-auth',
    token: 'geulbat-dev-token',
  });

  assert.deepEqual(result, {
    ok: true,
    message: {
      type: 'run.auth',
      requestId: 'req-auth',
      token: 'geulbat-dev-token',
    },
  });
});

void test('readRunChannelClientMessage rejects empty objects', () => {
  assert.equal(readRunChannelClientMessage({}).ok, false);
});

void test('readRunChannelClientMessage rejects malformed run.start payloads', () => {
  assert.deepEqual(
    readRunChannelClientMessage({
      type: 'run.start',
      requestId: 'req-1',
      request: {},
    }),
    { ok: false, message: 'invalid websocket JSON' },
  );
});

void test('readRunChannelClientMessage accepts valid run.start payloads', () => {
  const result = readRunChannelClientMessage({
    type: 'run.start',
    requestId: 'req-1',
    request: {
      prompt: 'hello',
      displayPrompt: 'Apply artifact to episodes/ch01.md',
      workingDirectory: 'Users/sample/Documents',
      selection: { startLine: 1, endLine: 2, text: 'x' },
      allowedPublicToolNames: ['read_file'],
      permissionMode: 'full_access',
    },
  });

  assert.equal(result.ok, true);
  if (!result.ok) {
    return;
  }
  assert.equal(result.message.type, 'run.start');
});

void test('readRunChannelClientMessage rejects retired allowedToolsHint payloads', () => {
  const result = readRunChannelClientMessage({
    type: 'run.start',
    requestId: 'req-1',
    request: {
      prompt: 'hello',
      allowedToolsHint: ['read_file'],
    },
  });

  assert.deepEqual(result, { ok: false, message: 'invalid websocket JSON' });
});

void test('readRunChannelClientMessage accepts run.interject envelopes without request field validation', () => {
  const result = readRunChannelClientMessage({
    type: 'run.interject',
    requestId: 'req-interject',
    request: {},
  });

  assert.equal(result.ok, true);
  if (!result.ok) {
    return;
  }
  assert.equal(result.message.type, 'run.interject');
});

void test('readRunChannelClientMessage rejects retired project ownership', () => {
  assert.deepEqual(
    readRunChannelClientMessage({
      type: 'run.start',
      requestId: 'req-project',
      request: {
        prompt: 'hello',
        projectId: 'workspace',
      },
    }),
    { ok: false, message: 'invalid websocket JSON' },
  );
});

void test('readRunChannelClientMessage rejects traversal-like threadIds', () => {
  assert.deepEqual(
    readRunChannelClientMessage({
      type: 'run.start',
      requestId: 'req-2',
      request: {
        prompt: 'hello',
        threadId: '../../escape',
      },
    }),
    { ok: false, message: 'invalid websocket JSON' },
  );

  assert.deepEqual(
    readRunChannelClientMessage({
      type: 'run.approve',
      requestId: 'req-3',
      request: {
        callId: 'call-1',
        runId: 'run-1',
        threadId: 'thread/child',
        approved: true,
        grantScope: 'once',
      },
    }),
    { ok: false, message: 'invalid websocket JSON' },
  );
});

void test('readRunChannelClientMessage rejects unknown permission modes and grant scopes', () => {
  assert.deepEqual(
    readRunChannelClientMessage({
      type: 'run.start',
      requestId: 'req-4',
      request: {
        prompt: 'hello',
        permissionMode: 'god_mode',
      },
    }),
    { ok: false, message: 'invalid websocket JSON' },
  );

  assert.deepEqual(
    readRunChannelClientMessage({
      type: 'run.approve',
      requestId: 'req-5',
      request: {
        callId: 'call-1',
        runId: 'run-1',
        threadId: '00000000-0000-4000-8000-000000000001',
        approved: true,
        grantScope: 'forever',
      },
    }),
    { ok: false, message: 'invalid websocket JSON' },
  );
});

void test('readRunChannelClientMessage rejects blank request ids centrally', () => {
  assert.deepEqual(
    readRunChannelClientMessage({
      type: 'run.auth',
      requestId: '   ',
      token: 'geulbat-dev-token',
    }),
    { ok: false, message: 'requestId is required' },
  );
});

void test('readRunChannelClientMessage accepts run.tool envelopes without request field validation', () => {
  const result = readRunChannelClientMessage({
    type: 'run.tool',
    requestId: 'req-tool',
    request: {},
  });

  assert.equal(result.ok, true);
  if (!result.ok) {
    return;
  }
  assert.equal(result.message.type, 'run.tool');
});

void test('readRunChannelClientMessage accepts a valid run event acknowledgement', () => {
  const result = readRunChannelClientMessage({
    type: 'run.event.ack',
    requestId: 'req-event-ack',
    request: {
      runId: 'run-event-ack',
      threadId: '123e4567-e89b-42d3-a456-426614174000',
      seq: 4,
    },
  });

  assert.equal(result.ok, true);
});

void test('readRunChannelClientMessage rejects run.tool envelopes without requestId', () => {
  assert.equal(
    readRunChannelClientMessage({ type: 'run.tool', request: {} }).ok,
    false,
  );
  assert.deepEqual(
    readRunChannelClientMessage({
      type: 'run.tool',
      requestId: '   ',
      request: {},
    }),
    { ok: false, message: 'requestId is required' },
  );
});
