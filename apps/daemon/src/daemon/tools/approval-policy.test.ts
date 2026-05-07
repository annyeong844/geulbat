import test from 'node:test';
import assert from 'node:assert/strict';
import { toApprovalClass } from '@geulbat/protocol/run-approval';
import {
  resolveRuntimeSideEffectLevel,
  resolveApprovalClass,
  shouldAutoApprove,
  shouldRequireApproval,
} from './approval-runtime-policy.js';
import { createApprovalGrantStore } from './approval-grants.js';
import { createToolRegistryStore } from './registry.js';
import type { AnyTool } from './types.js';
import { testThreadId } from '../../test-support/thread-id.js';

function makeTestTool(args: {
  name: string;
  sideEffectLevel: AnyTool['sideEffectLevel'];
  requiresApproval: boolean;
}): AnyTool {
  return {
    name: args.name,
    description: 'test',
    parameters: {
      type: 'object',
      properties: {},
      required: [],
      additionalProperties: false,
    },
    strict: true,
    sideEffectLevel: args.sideEffectLevel,
    timeoutMs: 1000,
    requiresApproval: args.requiresApproval,
    parseArgs() {
      return { ok: true, value: {} };
    },
    async executeParsed() {
      return { ok: true, output: '' };
    },
  };
}

void test('mutating tools require approval and unknown tools fail closed', () => {
  const toolRegistry = createToolRegistryStore({ builtins: [] });
  toolRegistry.registerTool(
    makeTestTool({
      name: 'write_file',
      sideEffectLevel: 'write',
      requiresApproval: true,
    }),
  );
  toolRegistry.registerTool(
    makeTestTool({
      name: 'patch_file',
      sideEffectLevel: 'write',
      requiresApproval: true,
    }),
  );
  toolRegistry.registerTool(
    makeTestTool({
      name: 'manage_files',
      sideEffectLevel: 'write',
      requiresApproval: true,
    }),
  );
  toolRegistry.registerTool(
    makeTestTool({
      name: 'read_file',
      sideEffectLevel: 'none',
      requiresApproval: false,
    }),
  );

  const policyOptions = { toolRegistry };
  assert.equal(
    shouldRequireApproval('write_file', undefined, policyOptions),
    true,
  );
  assert.equal(
    shouldRequireApproval('patch_file', undefined, policyOptions),
    true,
  );
  assert.equal(
    shouldRequireApproval('manage_files', undefined, policyOptions),
    true,
  );
  assert.equal(
    shouldRequireApproval('read_file', undefined, policyOptions),
    false,
  );
  assert.equal(
    shouldRequireApproval('unknown_tool', undefined, policyOptions),
    true,
  );
});

void test('manage_files delete upgrades runtime side effect to destructive', () => {
  const toolRegistry = createToolRegistryStore({ builtins: [] });
  toolRegistry.registerTool(
    makeTestTool({
      name: 'manage_files',
      sideEffectLevel: 'write',
      requiresApproval: true,
    }),
  );

  assert.equal(
    resolveRuntimeSideEffectLevel(
      'manage_files',
      { operation: 'delete' },
      { toolRegistry },
    ),
    'destructive',
  );
  assert.equal(
    resolveRuntimeSideEffectLevel(
      'manage_files',
      { operation: 'rename' },
      { toolRegistry },
    ),
    'write',
  );
});

void test('refresh_memory_index truthfully reports write effect and uses approval policy', () => {
  const toolRegistry = createToolRegistryStore({ builtins: [] });
  const approvalGrants = createApprovalGrantStore();
  toolRegistry.registerTool(
    makeTestTool({
      name: 'refresh_memory_index',
      sideEffectLevel: 'write',
      requiresApproval: true,
    }),
  );

  assert.equal(
    resolveRuntimeSideEffectLevel(
      'refresh_memory_index',
      {},
      {
        toolRegistry,
      },
    ),
    'write',
  );
  assert.equal(
    shouldRequireApproval('refresh_memory_index', undefined, {
      toolRegistry,
    }),
    true,
  );
  assert.equal(
    shouldAutoApprove(
      {
        runId: 'run-refresh',
        threadId: testThreadId(9),
        sessionId: 'refresh-session',
        approvalClass: toApprovalClass('refresh_memory_index'),
        sideEffectLevel: 'write',
        permissionMode: 'basic',
      },
      {
        approvalGrants,
      },
    ),
    false,
  );
  assert.equal(
    shouldAutoApprove(
      {
        runId: 'run-refresh',
        threadId: testThreadId(9),
        sessionId: 'refresh-session',
        approvalClass: toApprovalClass('refresh_memory_index'),
        sideEffectLevel: 'write',
        permissionMode: 'full_access',
      },
      {
        approvalGrants,
      },
    ),
    true,
  );
});

void test('approval class v1 uses tool name by default and splits manage_files by operation', () => {
  assert.equal(resolveApprovalClass('write_file'), 'write_file');
  assert.equal(
    resolveApprovalClass('manage_files', { operation: 'delete' }),
    'manage_files:delete',
  );
  assert.equal(
    resolveApprovalClass('manage_files', { operation: 'rename' }),
    'manage_files:rename',
  );
});

void test('full_access auto-approves write but not destructive without explicit grant', () => {
  const approvalGrants = createApprovalGrantStore();
  const threadId = testThreadId(10);
  const sessionId = 'approval-session-test';
  const writeContext = {
    runId: 'run-write',
    threadId,
    sessionId,
    approvalClass: toApprovalClass('write_file'),
    sideEffectLevel: 'write' as const,
    permissionMode: 'full_access' as const,
  };
  const destructiveContext = {
    ...writeContext,
    runId: 'run-delete',
    approvalClass: toApprovalClass('manage_files:delete'),
    sideEffectLevel: 'destructive' as const,
  };

  approvalGrants.clearApprovalSession(sessionId);
  assert.equal(
    shouldAutoApprove(writeContext, {
      approvalGrants,
    }),
    true,
  );
  assert.equal(
    shouldAutoApprove(destructiveContext, {
      approvalGrants,
    }),
    false,
  );

  approvalGrants.registerApprovalGrant(destructiveContext, 'run');
  assert.equal(
    shouldAutoApprove(destructiveContext, {
      approvalGrants,
    }),
    true,
  );
  approvalGrants.clearApprovalSession(sessionId);
});

void test('approval policy can read tool metadata from an injected registry', () => {
  const store = createToolRegistryStore({ builtins: [] });
  store.registerTool(
    makeTestTool({
      name: 'local_registry_read_tool',
      sideEffectLevel: 'none',
      requiresApproval: false,
    }),
  );

  assert.equal(
    shouldRequireApproval('local_registry_read_tool', undefined, {
      toolRegistry: store,
    }),
    false,
  );
  assert.equal(
    resolveRuntimeSideEffectLevel(
      'local_registry_read_tool',
      {},
      {
        toolRegistry: store,
      },
    ),
    'none',
  );
});
