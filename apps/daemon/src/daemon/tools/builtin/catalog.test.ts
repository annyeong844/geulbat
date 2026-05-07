import test from 'node:test';
import assert from 'node:assert/strict';

import { createBuiltinToolRegistryStore } from './catalog.js';

void test('builtin registry leaves child-run subagent tools without watchdog timeout', () => {
  const registry = createBuiltinToolRegistryStore();

  assert.equal(registry.getToolMeta('agent_spawn')?.timeoutMs, undefined);
  assert.equal(registry.getToolMeta('agent_send_input')?.timeoutMs, undefined);
  assert.equal(registry.getToolMeta('agent_wait')?.timeoutMs, undefined);
  assert.equal(registry.getToolMeta('agent_stop')?.timeoutMs, 30_000);
});
