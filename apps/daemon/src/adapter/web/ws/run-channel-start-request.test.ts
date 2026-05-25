import test from 'node:test';
import assert from 'node:assert/strict';
import type { ThreadId } from '@geulbat/protocol/ids';

import { createProjectRegistryStore } from '../../../daemon/files/project-registry-state.js';
import { testProjectId } from '../../../test-support/project-id.js';
import { readRunStartRequest } from './run-channel-start-request.js';

function createArgs() {
  const projectRegistry = createProjectRegistryStore({
    root: '/tmp/run-channel-start-request',
  });
  projectRegistry.replaceProjectRegistry([
    { projectId: testProjectId('workspace'), label: 'Workspace' },
  ]);
  return { projectRegistry };
}

void test('readRunStartRequest rejects blank prompts', () => {
  assert.deepEqual(
    readRunStartRequest(
      {
        prompt: '   ',
        projectId: testProjectId('workspace'),
      },
      createArgs(),
    ),
    {
      ok: false,
      status: 400,
      code: 'bad_request',
      message: 'prompt is required',
    },
  );
});

void test('readRunStartRequest rejects unknown projects', () => {
  assert.deepEqual(
    readRunStartRequest(
      {
        prompt: 'hello',
        projectId: 'missing-project' as ReturnType<typeof testProjectId>,
      },
      createArgs(),
    ),
    {
      ok: false,
      status: 404,
      code: 'not_found',
      message: 'unknown projectId: missing-project',
    },
  );
});

void test('readRunStartRequest rejects malformed thread ids', () => {
  assert.deepEqual(
    readRunStartRequest(
      {
        prompt: 'hello',
        projectId: testProjectId('workspace'),
        threadId: '../bad-thread' as unknown as ThreadId,
      },
      createArgs(),
    ),
    {
      ok: false,
      status: 400,
      code: 'bad_request',
      message: 'invalid threadId',
    },
  );
});

void test('readRunStartRequest normalizes transcript prompt and permission mode', () => {
  const result = readRunStartRequest(
    {
      prompt: 'hello',
      displayPrompt: '  shown prompt  ',
      projectId: testProjectId('workspace'),
      permissionMode: 'full_access',
    },
    createArgs(),
  );

  assert.equal(result.ok, true);
  if (!result.ok) {
    return;
  }
  assert.equal(result.value.prompt, 'hello');
  assert.equal(result.value.transcriptPrompt, 'shown prompt');
  assert.equal(result.value.projectId, testProjectId('workspace'));
  assert.equal(result.value.permissionMode, 'full_access');
});
