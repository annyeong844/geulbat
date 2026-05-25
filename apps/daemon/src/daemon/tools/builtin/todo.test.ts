import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { todoTool } from './todo.js';
import { testThreadId } from '../../../test-support/thread-id.js';

void test('todo persists task state per thread across separate executions', async () => {
  const threadId = testThreadId(1);
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'geulbat-todo-'));
  const ctx = {
    callId: 'call_1',
    workspaceRoot,
    threadId,
  };

  const added = await todoTool.execute(
    {
      action: 'add',
      text: '프로젝트 구조 확인 후 hello.txt 읽기',
    },
    ctx,
  );
  assert.equal(added.ok, true);

  const updated = await todoTool.execute(
    {
      action: 'update',
      id: '1',
      status: 'in_progress',
    },
    {
      ...ctx,
      callId: 'call_2',
    },
  );
  assert.equal(updated.ok, true);

  const listed = await todoTool.execute(
    {
      action: 'list',
    },
    {
      ...ctx,
      callId: 'call_3',
    },
  );
  assert.equal(listed.ok, true);
  assert.match(listed.output, /"status":"in_progress"/);
});

void test('todo isolates task state by thread', async () => {
  const firstThreadId = testThreadId(2);
  const secondThreadId = testThreadId(3);
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'geulbat-todo-'));

  const added = await todoTool.execute(
    {
      action: 'add',
      text: 'thread-1 task',
    },
    {
      callId: 'call_1',
      workspaceRoot,
      threadId: firstThreadId,
    },
  );
  assert.equal(added.ok, true);

  const listedOtherThread = await todoTool.execute(
    {
      action: 'list',
    },
    {
      callId: 'call_2',
      workspaceRoot,
      threadId: secondThreadId,
    },
  );
  assert.equal(listedOtherThread.ok, true);
  assert.match(listedOtherThread.output, /"total":0/);
});

void test('todo surfaces invalid persisted state instead of silently resetting it', async () => {
  const threadId = testThreadId(4);
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'geulbat-todo-'));
  const stateDir = join(workspaceRoot, '.geulbat', 'tool-state', 'todo');
  await mkdir(stateDir, { recursive: true });
  await writeFile(join(stateDir, `${threadId}.json`), '{not json', 'utf8');

  const listed = await todoTool.execute(
    {
      action: 'list',
    },
    {
      callId: 'call-invalid',
      workspaceRoot,
      threadId,
    },
  );

  assert.equal(listed.ok, false);
  assert.equal(listed.errorCode, 'execution_failed');
});

void test('todo rejects structurally invalid persisted state instead of partially healing it', async () => {
  const threadId = testThreadId(41);
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'geulbat-todo-'));
  const stateDir = join(workspaceRoot, '.geulbat', 'tool-state', 'todo');
  await mkdir(stateDir, { recursive: true });
  await writeFile(
    join(stateDir, `${threadId}.json`),
    JSON.stringify({
      nextId: 0,
      items: [
        {
          id: '1',
          text: 'task',
          status: 'blocked',
          createdAt: Date.now(),
        },
      ],
    }),
    'utf8',
  );

  const listed = await todoTool.execute(
    { action: 'list' },
    {
      callId: 'call-invalid-shape',
      workspaceRoot,
      threadId,
    },
  );

  assert.equal(listed.ok, false);
  assert.equal(listed.errorCode, 'execution_failed');
});

void test('todo rejects invalid status values instead of casting them into TodoItem status', async () => {
  const threadId = testThreadId(5);
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'geulbat-todo-'));
  const added = await todoTool.execute(
    {
      action: 'add',
      text: 'task',
    },
    {
      callId: 'call-add',
      workspaceRoot,
      threadId,
    },
  );
  assert.equal(added.ok, true);

  const updated = await todoTool.execute(
    {
      action: 'update',
      id: '1',
      status: 'blocked',
    },
    {
      callId: 'call-update',
      workspaceRoot,
      threadId,
    },
  );

  assert.equal(updated.ok, false);
  assert.equal(updated.errorCode, 'invalid_args');
  assert.match(updated.error ?? '', /status must be one of/);
});

void test('todo rejects missing action at the parser boundary', async () => {
  const threadId = testThreadId(6);
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'geulbat-todo-'));

  const result = await todoTool.execute(
    {
      text: 'task without action',
    },
    {
      callId: 'call-missing-action',
      workspaceRoot,
      threadId,
    },
  );

  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'invalid_args');
  assert.match(result.error ?? '', /action must be one of/);
});

void test('todo rejects unexpected keys instead of silently dropping them', async () => {
  const threadId = testThreadId(7);
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'geulbat-todo-'));

  const result = await todoTool.execute(
    {
      action: 'list',
      extra: true,
    },
    {
      callId: 'call-extra',
      workspaceRoot,
      threadId,
    },
  );

  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'invalid_args');
  assert.match(result.error ?? '', /unexpected keys: extra\./);
});

void test('todo rejects invalid action at the parser boundary', async () => {
  const threadId = testThreadId(8);
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'geulbat-todo-'));

  const result = await todoTool.execute(
    {
      action: 'archive',
    },
    {
      callId: 'call-invalid-action',
      workspaceRoot,
      threadId,
    },
  );

  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'invalid_args');
  assert.match(result.error ?? '', /action must be one of/);
});
