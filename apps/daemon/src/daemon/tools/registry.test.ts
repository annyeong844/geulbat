import assert from 'node:assert/strict';
import test from 'node:test';

import { askUserTool } from './builtin/ask-user.js';
import { listFilesTool } from './builtin/list-files.js';
import { searchFilesTool } from './builtin/search-files.js';
import { writeFileTool } from './builtin/write-file.js';
import { createToolRegistryStore } from './registry.js';
import { isToolObjectParameters, type AnyTool } from './types.js';
import { makeRegistrableTestTool } from '../../test-support/loop-tool-execution-test-support.js';

void test('createToolRegistryStore isolates local registrations across instances', () => {
  const left = createToolRegistryStore({ builtins: [] });
  const right = createToolRegistryStore({ builtins: [] });

  left.registerTool(makeRegistrableTestTool('left_only_tool'));

  assert.ok(left.getTool('left_only_tool'));
  assert.equal(right.getTool('left_only_tool'), undefined);
});

void test('createToolRegistryStore eagerly exposes builtin definitions for explicit name sets', () => {
  const store = createToolRegistryStore({ builtins: [writeFileTool] });

  const definitions = store.buildToolDefinitions({ names: ['write_file'] });

  assert.deepEqual(definitions, [
    {
      type: 'function',
      name: 'write_file',
      description: writeFileTool.description,
      parameters: writeFileTool.parameters,
      strict: false,
    },
  ]);
});

void test('createToolRegistryStore exposes the list_files definition with optional path', () => {
  const store = createToolRegistryStore({ builtins: [listFilesTool] });

  const definitions = store.buildToolDefinitions({ names: ['list_files'] });

  assert.deepEqual(definitions, [
    {
      type: 'function',
      name: 'list_files',
      description: listFilesTool.description,
      parameters: listFilesTool.parameters,
      strict: false,
    },
  ]);
  const parameters = definitions[0]?.parameters;
  assert.ok(parameters);
  assert.ok(isToolObjectParameters(parameters));
  assert.deepEqual(parameters.required, []);
});

void test('createToolRegistryStore keeps strict=true only for fully-required schemas', () => {
  const store = createToolRegistryStore({ builtins: [] });

  store.registerTool({
    ...makeRegistrableTestTool('required_only_tool'),
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
        },
      },
      required: ['path'],
      additionalProperties: false,
    },
  });

  const definitions = store.buildToolDefinitions({
    names: ['required_only_tool'],
  });

  assert.equal(definitions[0]?.strict, true);
});

void test('createToolRegistryStore does not publish strict=true for nested optional properties', () => {
  const store = createToolRegistryStore({ builtins: [askUserTool] });

  const definitions = store.buildToolDefinitions({ names: ['ask_user'] });

  assert.equal(definitions[0]?.strict, false);
});

void test('createToolRegistryStore does not publish strict=true for root oneOf schemas', () => {
  const store = createToolRegistryStore({ builtins: [] });

  store.registerTool({
    ...makeRegistrableTestTool('branch_tool'),
    parameters: {
      oneOf: [
        {
          type: 'object',
          properties: {
            action: {
              type: 'string',
              const: 'create',
            },
          },
          required: ['action'],
          additionalProperties: false,
        },
      ],
    },
  });

  const definitions = store.buildToolDefinitions({
    names: ['branch_tool'],
  });

  assert.equal(definitions[0]?.strict, false);
});

void test('createToolRegistryStore does not publish strict=true for root anyOf schemas', () => {
  const store = createToolRegistryStore({ builtins: [] });

  store.registerTool({
    ...makeRegistrableTestTool('branch_tool'),
    parameters: {
      anyOf: [
        {
          type: 'object',
          properties: {
            old_string: {
              type: 'string',
              const: '',
            },
          },
          required: ['old_string'],
          additionalProperties: false,
        },
      ],
    },
  });

  const definitions = store.buildToolDefinitions({
    names: ['branch_tool'],
  });

  assert.equal(definitions[0]?.strict, false);
});

void test('createToolRegistryStore returns tool snapshots instead of live builtin objects', () => {
  const store = createToolRegistryStore({ builtins: [writeFileTool] });

  const first = store.getTool('write_file');
  assert.ok(first);
  first.requiresApproval = false;
  assert.ok(isToolObjectParameters(first.parameters));
  first.parameters.required.push('__mutated__');

  const again = store.getTool('write_file');
  assert.ok(again);
  assert.equal(again.requiresApproval, true);
  assert.ok(isToolObjectParameters(again.parameters));
  assert.equal(again.parameters.required.includes('__mutated__'), false);
});

void test('createToolRegistryStore caches immutable execution and metadata views', () => {
  const store = createToolRegistryStore({ builtins: [] });
  store.registerTool({
    ...makeRegistrableTestTool('cached_execution_tool'),
    streamsArgsDelta: true,
    resultProjection: {
      exactDurableRecovery: true,
      modelProjection: 'runtime_summary',
      snapshotFailure: 'inline',
    },
  });

  const executionHandle = store.getToolExecutionHandle('cached_execution_tool');
  assert.ok(executionHandle);
  assert.strictEqual(
    store.getToolExecutionHandle('cached_execution_tool'),
    executionHandle,
  );
  assert.equal(Object.isFrozen(executionHandle), true);
  assert.equal('parameters' in executionHandle, false);
  assert.equal(executionHandle.abortSettlement, 'immediate');

  const meta = store.getToolMeta('cached_execution_tool');
  assert.ok(meta);
  assert.strictEqual(store.getToolMeta('cached_execution_tool'), meta);
  assert.equal(Object.isFrozen(meta), true);
  assert.equal(Object.isFrozen(meta.exposure), true);
  assert.equal(Object.isFrozen(meta.resultProjection), true);
  assert.equal(meta.streamsArgsDelta, true);
  assert.deepEqual(meta.resultProjection, {
    exactDurableRecovery: true,
    modelProjection: 'runtime_summary',
    snapshotFailure: 'inline',
  });
});

void test('createToolRegistryStore derives write settlement and preserves explicit read settlement', () => {
  const store = createToolRegistryStore({ builtins: [searchFilesTool] });
  store.registerTool({
    ...makeRegistrableTestTool('settled_write_tool'),
    sideEffectLevel: 'write',
  });

  assert.equal(
    store.getToolExecutionHandle('settled_write_tool')?.abortSettlement,
    'await_execution',
  );
  assert.equal(
    store.getToolExecutionHandle('search_files')?.abortSettlement,
    'await_execution',
  );
});

void test('createToolRegistryStore keeps one captured identity while later snapshots see replacements', async () => {
  const store = createToolRegistryStore({ builtins: [] });
  let originalExecutions = 0;
  let replacementExecutions = 0;
  store.registerTool({
    ...makeRegistrableTestTool('replaceable_tool'),
    description: 'original tool',
    async executeParsed() {
      originalExecutions += 1;
      return { ok: true, output: 'original' };
    },
  });
  const captured = store.captureSnapshot();
  const capturedHandle = captured.getToolExecutionHandle('replaceable_tool');
  assert.equal(Object.isFrozen(captured), true);
  assert.ok(capturedHandle);

  assert.equal(store.unregisterTool('replaceable_tool'), true);
  store.registerTool({
    ...makeRegistrableTestTool('replaceable_tool'),
    description: 'replacement tool',
    sideEffectLevel: 'write',
    requiresApproval: true,
    async executeParsed() {
      replacementExecutions += 1;
      return { ok: true, output: 'replacement' };
    },
  });

  assert.equal(
    captured.buildToolDefinitions()[0]?.description,
    'original tool',
  );
  assert.equal(
    captured.getToolMeta('replaceable_tool')?.sideEffectLevel,
    'none',
  );
  assert.equal(
    captured.getToolMeta('replaceable_tool')?.requiresApproval,
    false,
  );
  const parsed = capturedHandle.parseArgs({});
  assert.equal(parsed.ok, true);
  assert.equal(
    (
      await capturedHandle.executeParsed(
        parsed.ok ? parsed.value : {},
        undefined,
      )
    ).output,
    'original',
  );

  const later = captured.captureSnapshot();
  assert.equal(
    later.buildToolDefinitions()[0]?.description,
    'replacement tool',
  );
  assert.equal(later.getToolMeta('replaceable_tool')?.sideEffectLevel, 'write');
  assert.equal(later.getToolMeta('replaceable_tool')?.requiresApproval, true);
  assert.equal(originalExecutions, 1);
  assert.equal(replacementExecutions, 0);
});

void test('createToolRegistryStore preserves receiver-aware tool methods in snapshots', async () => {
  let parseReceiver: unknown;
  let executeReceiver: unknown;
  const receiverAwareTool: AnyTool = {
    ...makeRegistrableTestTool('receiver_aware_tool'),
    parseArgs() {
      parseReceiver = this;
      return { ok: true, value: {} };
    },
    async executeParsed() {
      executeReceiver = this;
      return { ok: true, output: 'receiver-aware' };
    },
  };
  const store = createToolRegistryStore({ builtins: [receiverAwareTool] });

  const snapshot = store.getTool('receiver_aware_tool');
  assert.ok(snapshot);
  const parsed = snapshot.parseArgs({});
  assert.equal(parsed.ok, true);
  const executed = await snapshot.executeParsed(
    {},
    {
      callId: 'call-registry-receiver-test',
    },
  );

  assert.equal(executed.ok, true);
  assert.equal(parseReceiver, receiverAwareTool);
  assert.equal(executeReceiver, receiverAwareTool);
});

void test('createToolRegistryStore unregisters one dynamic tool without affecting siblings', () => {
  const store = createToolRegistryStore({ builtins: [writeFileTool] });
  store.registerTool(makeRegistrableTestTool('dynamic_tool'));

  assert.equal(store.unregisterTool('dynamic_tool'), true);
  assert.equal(store.unregisterTool('dynamic_tool'), false);
  assert.equal(store.getTool('dynamic_tool'), undefined);
  assert.ok(store.getTool('write_file'));
});
