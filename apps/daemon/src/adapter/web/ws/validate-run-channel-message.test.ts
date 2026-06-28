import test from 'node:test';
import assert from 'node:assert/strict';
import { createProjectRegistryStore } from '../../../daemon/files/project-registry-state.js';
import { testProjectId } from '../../../test-support/project-id.js';
import { readRunChannelClientMessage } from './validate-run-channel-message.js';

function createValidationArgs() {
  const projectRegistry = createProjectRegistryStore({
    root: '/tmp/run-channel-validate',
  });
  projectRegistry.replaceProjectRegistry([
    { projectId: testProjectId('workspace'), label: 'Workspace' },
  ]);
  return { projectRegistry };
}

void test('readRunChannelClientMessage accepts valid run.auth payloads', () => {
  const args = createValidationArgs();
  const result = readRunChannelClientMessage(
    {
      type: 'run.auth',
      requestId: 'req-auth',
      token: 'geulbat-dev-token',
    },
    args,
  );

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
  assert.equal(
    readRunChannelClientMessage({}, createValidationArgs()).ok,
    false,
  );
});

void test('readRunChannelClientMessage rejects malformed run.start payloads', () => {
  assert.deepEqual(
    readRunChannelClientMessage(
      {
        type: 'run.start',
        requestId: 'req-1',
        request: {},
      },
      createValidationArgs(),
    ),
    { ok: false, message: 'invalid websocket JSON' },
  );
});

void test('readRunChannelClientMessage accepts valid run.start payloads', () => {
  const args = createValidationArgs();
  const result = readRunChannelClientMessage(
    {
      type: 'run.start',
      requestId: 'req-1',
      request: {
        prompt: 'hello',
        displayPrompt: 'Apply artifact to episodes/ch01.md',
        projectId: 'workspace',
        selection: { startLine: 1, endLine: 2, text: 'x' },
        allowedToolsHint: ['read_file'],
        permissionMode: 'full_access',
      },
    },
    args,
  );

  assert.equal(result.ok, true);
  if (!result.ok) {
    return;
  }
  assert.equal(result.message.type, 'run.start');
});

void test('readRunChannelClientMessage accepts run.interject envelopes without request field validation', () => {
  const result = readRunChannelClientMessage(
    {
      type: 'run.interject',
      requestId: 'req-interject',
      request: {},
    },
    createValidationArgs(),
  );

  assert.equal(result.ok, true);
  if (!result.ok) {
    return;
  }
  assert.equal(result.message.type, 'run.interject');
});

void test('readRunChannelClientMessage rejects unknown project ids after protocol shape validation', () => {
  assert.deepEqual(
    readRunChannelClientMessage(
      {
        type: 'run.start',
        requestId: 'req-project',
        request: {
          prompt: 'hello',
          projectId: 'unknown-project',
        },
      },
      createValidationArgs(),
    ),
    { ok: false, message: 'invalid websocket JSON' },
  );
});

void test('readRunChannelClientMessage rejects traversal-like threadIds', () => {
  assert.deepEqual(
    readRunChannelClientMessage(
      {
        type: 'run.start',
        requestId: 'req-2',
        request: {
          prompt: 'hello',
          projectId: 'workspace',
          threadId: '../../escape',
        },
      },
      createValidationArgs(),
    ),
    { ok: false, message: 'invalid websocket JSON' },
  );

  assert.deepEqual(
    readRunChannelClientMessage(
      {
        type: 'run.approve',
        requestId: 'req-3',
        request: {
          callId: 'call-1',
          runId: 'run-1',
          threadId: 'thread/child',
          approved: true,
          grantScope: 'once',
        },
      },
      createValidationArgs(),
    ),
    { ok: false, message: 'invalid websocket JSON' },
  );
});

void test('readRunChannelClientMessage rejects unknown permission modes and grant scopes', () => {
  assert.deepEqual(
    readRunChannelClientMessage(
      {
        type: 'run.start',
        requestId: 'req-4',
        request: {
          prompt: 'hello',
          projectId: 'workspace',
          permissionMode: 'god_mode',
        },
      },
      createValidationArgs(),
    ),
    { ok: false, message: 'invalid websocket JSON' },
  );

  assert.deepEqual(
    readRunChannelClientMessage(
      {
        type: 'run.approve',
        requestId: 'req-5',
        request: {
          callId: 'call-1',
          runId: 'run-1',
          threadId: '00000000-0000-4000-8000-000000000001',
          approved: true,
          grantScope: 'forever',
        },
      },
      createValidationArgs(),
    ),
    { ok: false, message: 'invalid websocket JSON' },
  );
});

void test('readRunChannelClientMessage rejects blank request ids centrally', () => {
  assert.deepEqual(
    readRunChannelClientMessage(
      {
        type: 'run.auth',
        requestId: '   ',
        token: 'geulbat-dev-token',
      },
      createValidationArgs(),
    ),
    { ok: false, message: 'requestId is required' },
  );
});
