import test from 'node:test';
import assert from 'node:assert/strict';

import { createBuiltinToolRegistryStore } from './catalog.js';

void test('builtin registry leaves child-run subagent tools without watchdog timeout', () => {
  const registry = createBuiltinToolRegistryStore();

  assertToolHasNoWatchdogTimeout(registry, 'agent_spawn');
  assertToolHasNoWatchdogTimeout(registry, 'agent_send_input');
  assertToolHasNoWatchdogTimeout(registry, 'agent_wait');
  assertToolHasNoWatchdogTimeout(registry, 'agent_stop');
});

void test('builtin registry leaves PTC exec cell tools without outer watchdog timeout', () => {
  const registry = createBuiltinToolRegistryStore();

  assertToolHasNoWatchdogTimeout(registry, 'exec');
  assertToolHasNoWatchdogTimeout(registry, 'wait');
});

void test('builtin registry leaves tool output reads without watchdog timeout', () => {
  const registry = createBuiltinToolRegistryStore();

  assertToolHasNoWatchdogTimeout(registry, 'read_tool_output');
});

void test('builtin registry leaves file listing without watchdog timeout', () => {
  const registry = createBuiltinToolRegistryStore();

  assertToolHasNoWatchdogTimeout(registry, 'list_files');
});

void test('builtin registry leaves file search without watchdog timeout', () => {
  const registry = createBuiltinToolRegistryStore();

  assertToolHasNoWatchdogTimeout(registry, 'search_files');
});

void test('builtin registry leaves file reads without watchdog timeout', () => {
  const registry = createBuiltinToolRegistryStore();

  assertToolHasNoWatchdogTimeout(registry, 'read_file');
});

void test('builtin registry leaves file mutation tools without watchdog timeout', () => {
  const registry = createBuiltinToolRegistryStore();

  assertToolHasNoWatchdogTimeout(registry, 'write_file');
  assertToolHasNoWatchdogTimeout(registry, 'patch_file');
  assertToolHasNoWatchdogTimeout(registry, 'manage_files');
});

void test('builtin registry leaves todo without watchdog timeout', () => {
  const registry = createBuiltinToolRegistryStore();

  assertToolHasNoWatchdogTimeout(registry, 'todo');
});

void test('builtin registry leaves memory index tools without watchdog timeout', () => {
  const registry = createBuiltinToolRegistryStore();

  assertToolHasNoWatchdogTimeout(registry, 'search_memory_index');
  assertToolHasNoWatchdogTimeout(registry, 'refresh_memory_index');
});

void test('builtin registry leaves browser PTC tools without outer watchdog timeout', () => {
  const registry = createBuiltinToolRegistryStore();

  assertToolHasNoWatchdogTimeout(registry, 'browser_navigate');
  assertToolHasNoWatchdogTimeout(registry, 'browser_page_load_evidence');
  assertToolHasNoWatchdogTimeout(registry, 'browser_text_evidence');
});

void test('builtin registry leaves web fetch without outer watchdog timeout', () => {
  const registry = createBuiltinToolRegistryStore();

  assertToolHasNoWatchdogTimeout(registry, 'web_fetch');
});

function assertToolHasNoWatchdogTimeout(
  registry: ReturnType<typeof createBuiltinToolRegistryStore>,
  toolName: string,
): void {
  const meta = registry.getToolMeta(toolName);
  assert.ok(meta, `${toolName} tool must be registered`);
  assert.equal(meta.timeoutMs, undefined);
}
