import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createBuiltinToolRegistryStore } from './catalog.js';
import { updatePlanTool } from './update-plan.js';
import { testThreadId } from '../../../test-support/thread-id.js';

void test('update_plan publishes whole-plan parameters without legacy todo actions', () => {
  const parameters = updatePlanTool.parameters;
  assert.equal(updatePlanTool.name, 'update_plan');
  assert.ok('type' in parameters);
  assert.equal(parameters.type, 'object');
  assert.deepEqual(parameters.required, ['plan']);
  assert.deepEqual(Object.keys(parameters.properties), ['explanation', 'plan']);
  assert.equal(JSON.stringify(parameters).includes('"action"'), false);
  assert.equal(JSON.stringify(parameters).includes('"todo"'), false);
});

void test('builtin registry exposes update_plan without a live todo alias', () => {
  const registry = createBuiltinToolRegistryStore();

  assert.ok(registry.getTool('update_plan'));
  assert.equal(registry.getTool('todo'), undefined);
  assert.equal(
    registry.getAllRegisteredToolNames().includes('update_plan'),
    true,
  );
  assert.equal(registry.getAllRegisteredToolNames().includes('todo'), false);
});

void test('update_plan persists the supplied ordered plan per thread', async () => {
  const threadId = testThreadId(1);
  const stateRoot = await mkdtemp(join(tmpdir(), 'geulbat-update-plan-'));
  const ctx = {
    callId: 'call_1',
    stateRoot,
    threadId,
  };

  const updated = await updatePlanTool.execute(
    {
      explanation: 'split the work into inspection and implementation',
      plan: [
        { step: 'Inspect current tool names', status: 'completed' },
        { step: 'Rename the planning tool', status: 'in_progress' },
        { step: 'Run focused checks', status: 'pending' },
      ],
    },
    ctx,
  );

  assert.equal(updated.ok, true);
  assert.match(updated.output, /"total":3/);
  assert.match(updated.output, /"status":"in_progress"/);

  const persisted = await readFile(
    join(
      stateRoot,
      '.geulbat',
      'tool-state',
      'update-plan',
      `${threadId}.json`,
    ),
    'utf8',
  );
  assert.match(persisted, /Inspect current tool names/);
  assert.match(persisted, /Rename the planning tool/);
});

void test('update_plan replaces prior thread plan without changing other threads', async () => {
  const firstThreadId = testThreadId(2);
  const secondThreadId = testThreadId(3);
  const stateRoot = await mkdtemp(join(tmpdir(), 'geulbat-update-plan-'));

  const first = await updatePlanTool.execute(
    {
      plan: [{ step: 'thread one task', status: 'pending' }],
    },
    {
      callId: 'call_1',
      stateRoot,
      threadId: firstThreadId,
    },
  );
  assert.equal(first.ok, true);

  const second = await updatePlanTool.execute(
    {
      plan: [{ step: 'thread two task', status: 'completed' }],
    },
    {
      callId: 'call_2',
      stateRoot,
      threadId: secondThreadId,
    },
  );
  assert.equal(second.ok, true);

  const firstPersisted = await readFile(
    join(
      stateRoot,
      '.geulbat',
      'tool-state',
      'update-plan',
      `${firstThreadId}.json`,
    ),
    'utf8',
  );
  const secondPersisted = await readFile(
    join(
      stateRoot,
      '.geulbat',
      'tool-state',
      'update-plan',
      `${secondThreadId}.json`,
    ),
    'utf8',
  );
  assert.match(firstPersisted, /thread one task/);
  assert.doesNotMatch(firstPersisted, /thread two task/);
  assert.match(secondPersisted, /thread two task/);
});

void test('update_plan surfaces invalid persisted state instead of overwriting it', async () => {
  const threadId = testThreadId(4);
  const stateRoot = await mkdtemp(join(tmpdir(), 'geulbat-update-plan-'));
  const stateDir = join(stateRoot, '.geulbat', 'tool-state', 'update-plan');
  await mkdir(stateDir, { recursive: true });
  await writeFile(join(stateDir, `${threadId}.json`), '{not json', 'utf8');

  const result = await updatePlanTool.execute(
    {
      plan: [{ step: 'new plan', status: 'pending' }],
    },
    {
      callId: 'call-invalid',
      stateRoot,
      threadId,
    },
  );

  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'execution_failed');
  assert.match(
    await readFile(join(stateDir, `${threadId}.json`), 'utf8'),
    /\{not json/u,
  );
});

void test('update_plan rejects invalid status values at the parser boundary', async () => {
  const threadId = testThreadId(5);
  const stateRoot = await mkdtemp(join(tmpdir(), 'geulbat-update-plan-'));

  const result = await updatePlanTool.execute(
    {
      plan: [{ step: 'task', status: 'blocked' }],
    },
    {
      callId: 'call-invalid-status',
      stateRoot,
      threadId,
    },
  );

  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'invalid_args');
  assert.match(result.error ?? '', /status must be one of/);
});

void test('update_plan rejects missing plan at the parser boundary', async () => {
  const threadId = testThreadId(6);
  const stateRoot = await mkdtemp(join(tmpdir(), 'geulbat-update-plan-'));

  const result = await updatePlanTool.execute(
    {
      explanation: 'missing plan',
    },
    {
      callId: 'call-missing-plan',
      stateRoot,
      threadId,
    },
  );

  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'invalid_args');
  assert.match(result.error ?? '', /plan.*required/);
});

void test('update_plan rejects unexpected keys instead of silently dropping them', async () => {
  const threadId = testThreadId(7);
  const stateRoot = await mkdtemp(join(tmpdir(), 'geulbat-update-plan-'));

  const result = await updatePlanTool.execute(
    {
      plan: [],
      action: 'list',
    },
    {
      callId: 'call-extra',
      stateRoot,
      threadId,
    },
  );

  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'invalid_args');
  assert.match(result.error ?? '', /unexpected keys: action\./);
});

void test('update_plan requires thread context with Home state available', async () => {
  const stateRoot = await mkdtemp(join(tmpdir(), 'geulbat-update-plan-'));

  const result = await updatePlanTool.execute(
    {
      plan: [],
    },
    {
      callId: 'call-no-thread',
      stateRoot,
    },
  );

  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'execution_failed');
  assert.match(
    result.error ?? '',
    /thread and Home state context.*update_plan/,
  );
});
