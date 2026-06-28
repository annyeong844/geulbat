import assert from 'node:assert/strict';
import test from 'node:test';

import {
  isRunPromptInputRefResponse,
  isRunRequest,
  isRunStartRequest,
} from './run-contract.js';

const VALID_THREAD_ID = '11111111-1111-4111-8111-111111111111';

void test('isRunRequest requires a canonical project id', () => {
  assert.equal(
    isRunRequest({
      prompt: 'hello',
      projectId: 'workspace',
      threadId: VALID_THREAD_ID,
    }),
    true,
  );

  assert.equal(
    isRunRequest({
      prompt: 'hello',
      projectId: '../escape',
      threadId: VALID_THREAD_ID,
    }),
    false,
  );
});

void test('isRunStartRequest accepts exactly one prompt input source', () => {
  assert.equal(
    isRunStartRequest({
      promptRef: 'run-prompt-input:11111111-1111-4111-8111-111111111111',
      projectId: 'workspace',
      threadId: VALID_THREAD_ID,
    }),
    true,
  );

  assert.equal(
    isRunStartRequest({
      prompt: 'hello',
      promptRef: 'run-prompt-input:11111111-1111-4111-8111-111111111111',
      projectId: 'workspace',
      threadId: VALID_THREAD_ID,
    }),
    false,
  );
});

void test('isRunStartRequest rejects prompt refs with invalid project ids', () => {
  assert.equal(
    isRunStartRequest({
      promptRef: 'run-prompt-input:11111111-1111-4111-8111-111111111111',
      projectId: '../escape',
      threadId: VALID_THREAD_ID,
    }),
    false,
  );
});

void test('isRunPromptInputRefResponse validates upload responses', () => {
  assert.equal(
    isRunPromptInputRefResponse({
      ok: true,
      promptRef: 'run-prompt-input:11111111-1111-4111-8111-111111111111',
      byteLength: 12,
    }),
    true,
  );

  assert.equal(
    isRunPromptInputRefResponse({
      ok: true,
      promptRef: 'run-prompt-input:11111111-1111-4111-8111-111111111111',
    }),
    false,
  );
});
