import test from 'node:test';
import assert from 'node:assert/strict';

import { createBuiltinToolRegistryStore } from './catalog.js';

void test('builtin registry leaves child-run subagent tools without watchdog timeout', () => {
  const registry = createBuiltinToolRegistryStore();

  assert.equal(registry.getToolMeta('agent_spawn')?.timeoutMs, undefined);
  assert.equal(registry.getToolMeta('agent_send_input')?.timeoutMs, undefined);
  assert.equal(registry.getToolMeta('agent_wait')?.timeoutMs, undefined);
  assert.equal(registry.getToolMeta('agent_stop')?.timeoutMs, undefined);
});

void test('builtin registry leaves PTC exec cell tools without outer watchdog timeout', () => {
  const registry = createBuiltinToolRegistryStore();

  assert.equal(registry.getToolMeta('exec')?.timeoutMs, undefined);
  assert.equal(registry.getToolMeta('wait')?.timeoutMs, undefined);
});

void test('builtin registry leaves tool output reads without watchdog timeout', () => {
  const registry = createBuiltinToolRegistryStore();

  assert.equal(registry.getToolMeta('read_tool_output')?.timeoutMs, undefined);
});

void test('builtin registry leaves file listing without watchdog timeout', () => {
  const registry = createBuiltinToolRegistryStore();

  assert.equal(registry.getToolMeta('list_files')?.timeoutMs, undefined);
});

void test('builtin registry leaves file search without watchdog timeout', () => {
  const registry = createBuiltinToolRegistryStore();

  assert.equal(registry.getToolMeta('search_files')?.timeoutMs, undefined);
});

void test('builtin registry leaves file reads without watchdog timeout', () => {
  const registry = createBuiltinToolRegistryStore();

  assert.equal(registry.getToolMeta('read_file')?.timeoutMs, undefined);
});

void test('builtin registry leaves file mutation tools without watchdog timeout', () => {
  const registry = createBuiltinToolRegistryStore();

  assert.equal(registry.getToolMeta('write_file')?.timeoutMs, undefined);
  assert.equal(registry.getToolMeta('patch_file')?.timeoutMs, undefined);
  assert.equal(registry.getToolMeta('manage_files')?.timeoutMs, undefined);
});

void test('builtin registry leaves todo without watchdog timeout', () => {
  const registry = createBuiltinToolRegistryStore();

  assert.equal(registry.getToolMeta('todo')?.timeoutMs, undefined);
});

void test('builtin registry leaves memory index tools without watchdog timeout', () => {
  const registry = createBuiltinToolRegistryStore();

  assert.equal(
    registry.getToolMeta('search_memory_index')?.timeoutMs,
    undefined,
  );
  assert.equal(
    registry.getToolMeta('refresh_memory_index')?.timeoutMs,
    undefined,
  );
});

void test('builtin registry leaves browser PTC tools without outer watchdog timeout', () => {
  const registry = createBuiltinToolRegistryStore();

  assert.equal(registry.getToolMeta('browser_navigate')?.timeoutMs, undefined);
  assert.equal(
    registry.getToolMeta('browser_page_load_evidence')?.timeoutMs,
    undefined,
  );
  assert.equal(
    registry.getToolMeta('browser_text_evidence')?.timeoutMs,
    undefined,
  );
});

void test('builtin registry leaves web fetch without outer watchdog timeout', () => {
  const registry = createBuiltinToolRegistryStore();

  assert.equal(registry.getToolMeta('web_fetch')?.timeoutMs, undefined);
});
