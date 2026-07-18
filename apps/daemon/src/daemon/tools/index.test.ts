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
    'apply_patch',
    'ask_user',
    'browser_navigate',
    'browser_page_load_evidence',
    'browser_text_evidence',
    'exec',
    'exec_command',
    'fetch_url',
    'generate_image',
    'generate_video',
    'list_files',
    'manage_files',
    'read_file',
    'read_tool_output',
    'refresh_memory_index',
    'search_files',
    'search_memory_index',
    'skill_search',
    'tool_search',
    'update_plan',
    'visualize',
    'wait',
    'write_file',
  ]);

  assert.ok(registry.getTool('read_file'));
  assert.ok(registry.getTool('read_tool_output'));
  assert.ok(registry.getTool('agent_send_input'));
  assert.ok(registry.getTool('agent_spawn'));
  assert.ok(registry.getTool('agent_stop'));
  assert.ok(registry.getTool('agent_wait'));
  assert.ok(registry.getTool('exec'));
  assert.ok(registry.getTool('exec_command'));
  assert.equal(registry.getTool('execute_code'), undefined);
  assert.ok(registry.getTool('fetch_url'));
  assert.equal(registry.getTool('web_fetch'), undefined);
  assert.ok(registry.getTool('generate_image'));
  assert.ok(registry.getTool('generate_video'));
  assert.ok(registry.getTool('apply_patch'));
  assert.ok(registry.getTool('ask_user'));
  assert.equal(registry.getTool('patch_file'), undefined);
  assert.ok(registry.getTool('browser_navigate'));
  assert.ok(registry.getTool('browser_page_load_evidence'));
  assert.ok(registry.getTool('browser_text_evidence'));
  assert.ok(registry.getTool('list_files'));
  assert.ok(registry.getTool('search_files'));
  assert.ok(registry.getTool('write_file'));
  assert.ok(registry.getTool('manage_files'));
  assert.ok(registry.getTool('update_plan'));
  assert.ok(registry.getTool('visualize'));
  assert.equal(registry.getTool('todo'), undefined);
  assert.ok(registry.getTool('refresh_memory_index'));
  assert.ok(registry.getTool('search_memory_index'));
  assert.ok(registry.getTool('skill_search'));
  assert.ok(registry.getTool('tool_search'));
  assert.ok(registry.getTool('wait'));
});

void test('getTool returns a snapshot instead of the live registry object', () => {
  const registry = createBuiltinToolRegistryStore();

  const snapshot = registry.getTool('write_file');
  assert.ok(snapshot);

  snapshot.requiresApproval = false;
  assert.ok(snapshot.exposure);
  snapshot.exposure.directHot = false;
  assert.ok(isToolObjectParameters(snapshot.parameters));
  snapshot.parameters.required.push('__mutated__');
  assert.ok(snapshot.catalogSearchMetadata);
  (snapshot.catalogSearchMetadata.searchHints as string[]).push('__mutated__');

  const again = registry.getTool('write_file');
  assert.ok(again);
  assert.equal(again.requiresApproval, true);
  assert.equal(again.exposure?.directHot, true);
  assert.ok(isToolObjectParameters(again.parameters));
  assert.equal(again.parameters.required.includes('__mutated__'), false);
  assert.equal(
    again.catalogSearchMetadata?.searchHints.includes('__mutated__'),
    false,
  );
});

void test('registry read paths expose eagerly registered builtin tools', () => {
  const registry = createBuiltinToolRegistryStore();
  const names = registry.getAllRegisteredToolNames();

  assert.ok(names.includes('read_file'));
  assert.ok(names.includes('write_file'));
  assert.ok(registry.getToolMeta('manage_files'));
  assert.ok(registry.getToolMeta('exec_command'));
});

void test('agent_spawn advertises subagent launch batching through tool metadata', () => {
  const registry = createBuiltinToolRegistryStore();

  const meta = registry.getToolMeta('agent_spawn');

  assert.ok(meta);
  assert.equal(meta.parallelBatchKind, 'subagent_launch');
});
