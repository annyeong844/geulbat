import test from 'node:test';
import assert from 'node:assert/strict';

import { createRunWorkspaceContext } from './run-workspace-context.js';
import { InvalidProjectIdError } from '@geulbat/protocol/ids';

void test('createRunWorkspaceContext accepts canonical project and thread ids', () => {
  const context = createRunWorkspaceContext({
    threadId: '00000000-0000-4000-8000-000000000001',
    projectId: 'workspace',
    workspaceRoot: '/tmp/workspace',
  });

  assert.equal(context.projectId, 'workspace');
  assert.equal(context.threadId, '00000000-0000-4000-8000-000000000001');
});

void test('createRunWorkspaceContext rejects invalid project ids', () => {
  assert.throws(
    () =>
      createRunWorkspaceContext({
        threadId: '00000000-0000-4000-8000-000000000001',
        projectId: '../escape',
        workspaceRoot: '/tmp/workspace',
      }),
    (error: unknown) =>
      error instanceof InvalidProjectIdError &&
      error.message === 'invalid projectId: ../escape',
  );
});
