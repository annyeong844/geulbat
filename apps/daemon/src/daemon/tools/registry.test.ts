import assert from 'node:assert/strict';
import test from 'node:test';

import { listFilesTool } from './builtin/list-files.js';
import { writeFileTool } from './builtin/write-file.js';
import { createToolRegistryStore } from './registry.js';
import { isToolObjectParameters, type AnyTool } from './types.js';

function createTestTool(name: string): AnyTool {
  return {
    name,
    description: 'test tool',
    parameters: {
      type: 'object',
      properties: {},
      required: [],
      additionalProperties: false,
    },
    strict: true,
    sideEffectLevel: 'none',
    mayMutateWorkspaceFiles: false,
    timeoutMs: 1_000,
    requiresApproval: false,
    parseArgs() {
      return { ok: true, value: {} };
    },
    async executeParsed() {
      return { ok: true, output: name };
    },
  };
}

void test('createToolRegistryStore isolates local registrations across instances', () => {
  const left = createToolRegistryStore({ builtins: [] });
  const right = createToolRegistryStore({ builtins: [] });

  left.registerTool(createTestTool('left_only_tool'));

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
    ...createTestTool('required_only_tool'),
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

void test('createToolRegistryStore does not publish strict=true for root oneOf schemas', () => {
  const store = createToolRegistryStore({ builtins: [] });

  store.registerTool({
    ...createTestTool('branch_tool'),
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
    ...createTestTool('branch_tool'),
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
