import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import type { ThreadId } from '@geulbat/protocol/ids';

import { createProjectRegistryStore } from '../../../daemon/files/project-registry-state.js';
import { writeRunPromptInputRefFromStream } from '../../../daemon/sessions/prompt-input-ref-store.js';
import { testProjectId } from '../../../test-support/project-id.js';
import { readRunStartRequest } from './run-channel-start-request.js';

const WORKSPACE_ROOT = '/tmp/run-channel-start-request';
const WORKSPACE_PROJECT_ROOT = `${WORKSPACE_ROOT}/${testProjectId('workspace')}`;

function createArgs() {
  const projectRegistry = createProjectRegistryStore({
    root: WORKSPACE_ROOT,
  });
  projectRegistry.replaceProjectRegistry([
    { projectId: testProjectId('workspace'), label: 'Workspace' },
  ]);
  return { projectRegistry };
}

void test('readRunStartRequest rejects blank prompts', async () => {
  assert.deepEqual(
    await readRunStartRequest(
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

void test('readRunStartRequest rejects unknown projects', async () => {
  assert.deepEqual(
    await readRunStartRequest(
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

void test('readRunStartRequest rejects malformed thread ids', async () => {
  assert.deepEqual(
    await readRunStartRequest(
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

void test('readRunStartRequest normalizes transcript prompt and permission mode', async () => {
  const result = await readRunStartRequest(
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

void test('readRunStartRequest resolves prompt refs before normalizing transcript prompt', async () => {
  const written = await writeRunPromptInputRefFromStream({
    workspaceRoot: WORKSPACE_PROJECT_ROOT,
    input: Readable.from(['stored prompt']),
  });

  const result = await readRunStartRequest(
    {
      promptRef: written.promptRef,
      displayPrompt: '  visible prompt  ',
      projectId: testProjectId('workspace'),
    },
    createArgs(),
  );

  assert.equal(result.ok, true);
  if (!result.ok) {
    return;
  }
  assert.equal(result.value.prompt, 'stored prompt');
  assert.equal(result.value.transcriptPrompt, 'visible prompt');
  assert.equal(result.value.promptRef?.promptRef, written.promptRef);
});
