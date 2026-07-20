import test from 'node:test';
import assert from 'node:assert/strict';

import { createAgentLoopToolDefinitionPort } from './loop-tool-definitions.js';
import { createBuiltinToolRegistryStore } from '../tools/builtin/catalog.js';
import {
  PTC_EXECUTE_CODE_TOOL_NAME,
  PTC_EXECUTE_CODE_WAIT_TOOL_NAME,
} from '../ptc/runtime/execute-code/execute-code-runtime-contract.js';
import type { RegisteredToolLike } from '../tools/tool-registry-model.js';

void test('default agent surface removes SDK-reachable long-tail tools while keeping the fixed direct surface', () => {
  const registry = createBuiltinToolRegistryStore();
  const port = createAgentLoopToolDefinitionPort(registry);

  const names = port.buildToolDefinitions({}).map((tool) => tool.name);

  assert.deepEqual(names, [
    'agent_send_input',
    'agent_spawn',
    'agent_stop',
    'agent_wait',
    'apply_patch',
    'ask_user',
    'browser_navigate',
    'browser_page_load_evidence',
    'browser_text_evidence',
    PTC_EXECUTE_CODE_TOOL_NAME,
    'exec_command',
    'generate_image',
    'generate_video',
    'list_files',
    'manage_files',
    'read_file',
    'read_tool_output',
    'refresh_memory_index',
    'search_files',
    'skill_search',
    'tool_search',
    'update_plan',
    'visualize',
    PTC_EXECUTE_CODE_WAIT_TOOL_NAME,
    'write_file',
  ]);
});

void test('restricted surfaces without exec and wait retain explicitly allowed long-tail tools', () => {
  const registry = createBuiltinToolRegistryStore();
  const port = createAgentLoopToolDefinitionPort(registry);

  const names = port
    .buildToolDefinitions({
      directRegistryNames: ['fetch_url', 'list_files', 'search_files'],
    })
    .map((tool) => tool.name);

  assert.deepEqual(names, ['fetch_url', 'list_files', 'search_files']);
});

void test('explicit direct surfaces remain exact when execute and wait are present', () => {
  const registry = createBuiltinToolRegistryStore();
  const port = createAgentLoopToolDefinitionPort(registry);

  const names = port
    .buildToolDefinitions({
      directRegistryNames: [
        PTC_EXECUTE_CODE_TOOL_NAME,
        PTC_EXECUTE_CODE_WAIT_TOOL_NAME,
        'list_files',
      ],
    })
    .map((tool) => tool.name);

  assert.deepEqual(names, [
    PTC_EXECUTE_CODE_TOOL_NAME,
    'list_files',
    PTC_EXECUTE_CODE_WAIT_TOOL_NAME,
  ]);
});

void test('adding an SDK-only registry tool leaves the default model tool block byte-stable', () => {
  const registry = createBuiltinToolRegistryStore();
  const port = createAgentLoopToolDefinitionPort(registry);
  const before = JSON.stringify(port.buildToolDefinitions({}));

  registry.registerTool(createSdkOnlyRegistryTool());

  assert.equal(JSON.stringify(port.buildToolDefinitions({})), before);
});

function createSdkOnlyRegistryTool(): RegisteredToolLike {
  return {
    name: 'registry_change_probe',
    description: 'Additive registry-change probe.',
    parameters: {
      type: 'object',
      properties: {},
      required: [],
      additionalProperties: false,
    },
    strict: true,
    sideEffectLevel: 'read',
    mayMutateComputerFiles: false,
    requiresApproval: false,
    exposure: {
      directHot: false,
      sdkVisible: true,
      inCellCallable: true,
      directOnly: false,
      effectClass: 'readOnly',
    },
    parseArgs() {
      return { ok: true, value: {} };
    },
    async executeParsed() {
      return { ok: true, output: '{}' };
    },
  };
}
