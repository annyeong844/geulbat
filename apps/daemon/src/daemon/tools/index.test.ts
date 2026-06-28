import test from 'node:test';
import assert from 'node:assert/strict';

import { createBuiltinToolRegistryStore } from './builtin/catalog.js';
import { isToolObjectParameters } from './types.js';

void test('createBuiltinToolRegistryStore registers the canonical builtin tool set', () => {
  const registry = createBuiltinToolRegistryStore();

  const names = registry.getAllRegisteredToolNames();

  assert.deepEqual(names, [
    'agent_send_input',
    'agent_spawn',
    'agent_stop',
    'agent_wait',
    'browser_navigate',
    'browser_page_load_evidence',
    'browser_text_evidence',
    'exec',
    'list_files',
    'manage_files',
    'patch_file',
    'read_file',
    'read_tool_output',
    'refresh_memory_index',
    'search_files',
    'search_memory_index',
    'todo',
    'wait',
    'web_fetch',
    'write_file',
  ]);

  assert.ok(registry.getTool('read_file'));
  assert.ok(registry.getTool('read_tool_output'));
  assert.ok(registry.getTool('agent_send_input'));
  assert.ok(registry.getTool('agent_spawn'));
  assert.ok(registry.getTool('agent_stop'));
  assert.ok(registry.getTool('agent_wait'));
  assert.ok(registry.getTool('exec'));
  assert.equal(registry.getTool('execute_code'), undefined);
  assert.ok(registry.getTool('browser_navigate'));
  assert.ok(registry.getTool('browser_page_load_evidence'));
  assert.ok(registry.getTool('browser_text_evidence'));
  assert.ok(registry.getTool('list_files'));
  assert.ok(registry.getTool('search_files'));
  assert.ok(registry.getTool('write_file'));
  assert.ok(registry.getTool('patch_file'));
  assert.ok(registry.getTool('manage_files'));
  assert.ok(registry.getTool('todo'));
  assert.ok(registry.getTool('refresh_memory_index'));
  assert.ok(registry.getTool('search_memory_index'));
  assert.ok(registry.getTool('web_fetch'));
  assert.ok(registry.getTool('wait'));
});

void test('getTool returns a snapshot instead of the live registry object', () => {
  const registry = createBuiltinToolRegistryStore();

  const snapshot = registry.getTool('write_file');
  assert.ok(snapshot);

  snapshot.requiresApproval = false;
  assert.ok(isToolObjectParameters(snapshot.parameters));
  snapshot.parameters.required.push('__mutated__');

  const again = registry.getTool('write_file');
  assert.ok(again);
  assert.equal(again.requiresApproval, true);
  assert.ok(isToolObjectParameters(again.parameters));
  assert.equal(again.parameters.required.includes('__mutated__'), false);
});

void test('registry read paths expose eagerly registered builtin tools', () => {
  const registry = createBuiltinToolRegistryStore();
  const names = registry.getAllRegisteredToolNames();

  assert.ok(names.includes('read_file'));
  assert.ok(names.includes('write_file'));
  assert.ok(registry.getToolMeta('manage_files'));
});

void test('agent_spawn advertises subagent launch batching through tool metadata', () => {
  const registry = createBuiltinToolRegistryStore();

  const meta = registry.getToolMeta('agent_spawn');

  assert.ok(meta);
  assert.equal(meta.parallelBatchKind, 'subagent_launch');
});
