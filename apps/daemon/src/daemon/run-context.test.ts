import test from 'node:test';
import assert from 'node:assert/strict';

import { createRunContext } from './run-context.js';

void test('createRunContext keeps Home state and working-directory context separate', () => {
  const context = createRunContext({
    threadId: '00000000-0000-4000-8000-000000000001',
    stateRoot: '/tmp/home-state',
    workingDirectory: 'Users/sample/Documents',
  });

  assert.deepEqual(context, {
    threadId: '00000000-0000-4000-8000-000000000001',
    stateRoot: '/tmp/home-state',
    workingDirectory: 'Users/sample/Documents',
  });
});

void test('createRunContext defaults only the working directory to the computer root', () => {
  const context = createRunContext({
    threadId: '00000000-0000-4000-8000-000000000002',
    stateRoot: '/tmp/home-state',
  });

  assert.equal(context.workingDirectory, '');
  assert.equal(context.stateRoot, '/tmp/home-state');
});

void test('createRunContext rejects a missing Home state root without a cwd fallback', () => {
  assert.throws(
    () =>
      createRunContext({
        threadId: '00000000-0000-4000-8000-000000000003',
        stateRoot: '   ',
        workingDirectory: 'Users/sample/Documents',
      }),
    /run stateRoot is required/u,
  );
});
