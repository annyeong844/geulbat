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
    mayMutateComputerFiles: false,
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
      name: 'apply_patch',
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
  assert.equal(shouldRequireApproval('write_file', policyOptions), true);
  assert.equal(shouldRequireApproval('apply_patch', policyOptions), true);
  assert.equal(shouldRequireApproval('manage_files', policyOptions), true);
  assert.equal(shouldRequireApproval('read_file', policyOptions), false);
  assert.equal(shouldRequireApproval('unknown_tool', policyOptions), true);
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

void test('exec_command keeps destructive approval semantics', () => {
  const toolRegistry = createToolRegistryStore({ builtins: [] });
  const approvalGrants = createApprovalGrantStore();
  toolRegistry.registerTool(
    makeTestTool({
      name: 'exec_command',
      sideEffectLevel: 'destructive',
      requiresApproval: true,
    }),
  );

  const context = {
    runId: 'run-exec-command',
    sessionId: 'exec-command-session',
    approvalClass: toApprovalClass('exec_command'),
    sideEffectLevel: 'destructive' as const,
    permissionMode: 'full_access' as const,
  };

  assert.equal(
    resolveRuntimeSideEffectLevel('exec_command', {}, { toolRegistry }),
    'destructive',
  );
  assert.equal(shouldRequireApproval('exec_command', { toolRegistry }), true);
  // full_access: destructive도 자동 승인 (2026-07-12 소유자 결정)
  assert.equal(shouldAutoApprove(context, { approvalGrants }), true);
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
    shouldRequireApproval('refresh_memory_index', {
      toolRegistry,
    }),
    true,
  );
  assert.equal(
    shouldAutoApprove(
      {
        runId: 'run-refresh',
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

void test('approval classes scope file mutations to Computer and split manage_files by operation', () => {
  assert.equal(resolveApprovalClass('read_file'), 'read_file');
  assert.equal(resolveApprovalClass('write_file'), 'write_file:computer');
  assert.equal(
    resolveApprovalClass('manage_files', { operation: 'delete' }),
    'manage_files:delete:computer',
  );
  assert.equal(
    resolveApprovalClass('manage_files', { operation: 'rename' }),
    'manage_files:rename:computer',
  );
});

void test('Computer file mutations retain truthful runtime effect levels', () => {
  const toolRegistry = createToolRegistryStore({ builtins: [] });
  for (const name of ['write_file', 'apply_patch', 'manage_files']) {
    toolRegistry.registerTool(
      makeTestTool({
        name,
        sideEffectLevel: 'write',
        requiresApproval: true,
      }),
    );
  }

  assert.equal(resolveApprovalClass('write_file'), 'write_file:computer');
  assert.equal(resolveApprovalClass('apply_patch'), 'apply_patch:computer');
  assert.equal(
    resolveApprovalClass('manage_files', {
      operation: 'move',
    }),
    'manage_files:move:computer',
  );
  assert.equal(
    resolveRuntimeSideEffectLevel('write_file', {}, { toolRegistry }),
    'write',
  );
  assert.equal(
    resolveRuntimeSideEffectLevel('apply_patch', {}, { toolRegistry }),
    'write',
  );
  assert.equal(
    resolveRuntimeSideEffectLevel(
      'manage_files',
      { operation: 'create' },
      { toolRegistry },
    ),
    'write',
  );
  assert.equal(
    resolveRuntimeSideEffectLevel(
      'manage_files',
      { operation: 'delete' },
      { toolRegistry },
    ),
    'destructive',
  );
});

void test('legacy unscoped grants do not authorize Computer mutation classes', () => {
  const approvalGrants = createApprovalGrantStore();
  const legacyUnscopedContext = {
    runId: 'run-root-scope',
    sessionId: 'root-scope-session',
    approvalClass: toApprovalClass('write_file'),
    sideEffectLevel: 'write' as const,
    permissionMode: 'basic' as const,
  };
  const computerContext = {
    ...legacyUnscopedContext,
    approvalClass: toApprovalClass('write_file:computer'),
  };

  approvalGrants.registerApprovalGrant(legacyUnscopedContext, 'session');
  assert.equal(
    shouldAutoApprove(legacyUnscopedContext, { approvalGrants }),
    true,
  );
  assert.equal(shouldAutoApprove(computerContext, { approvalGrants }), false);
});

void test('approval grants reuse only within an explicit run or connection session', () => {
  const approvalGrants = createApprovalGrantStore();
  const context = {
    runId: 'run-grant-a',
    sessionId: 'connection-session-a',
    approvalClass: toApprovalClass('write_file:computer'),
    sideEffectLevel: 'write' as const,
    permissionMode: 'basic' as const,
  };

  approvalGrants.registerApprovalGrant(context, 'run');
  assert.equal(approvalGrants.hasApprovalGrant(context), true);
  assert.equal(
    approvalGrants.hasApprovalGrant({ ...context, runId: 'run-grant-b' }),
    false,
  );

  approvalGrants.clearApprovalSession(context.sessionId);
  approvalGrants.registerApprovalGrant(context, 'session');
  assert.equal(
    approvalGrants.hasApprovalGrant({ ...context, runId: 'run-grant-b' }),
    true,
  );
  assert.equal(
    approvalGrants.hasApprovalGrant({
      ...context,
      runId: 'run-grant-b',
      sessionId: 'connection-session-b',
    }),
    false,
  );
});

void test('full_access auto-approves write and destructive; basic still prompts', () => {
  const approvalGrants = createApprovalGrantStore();
  const sessionId = 'approval-session-test';
  const writeContext = {
    runId: 'run-write',
    sessionId,
    approvalClass: toApprovalClass('write_file:computer'),
    sideEffectLevel: 'write' as const,
    permissionMode: 'full_access' as const,
  };
  const destructiveContext = {
    ...writeContext,
    runId: 'run-delete',
    approvalClass: toApprovalClass('manage_files:delete:computer'),
    sideEffectLevel: 'destructive' as const,
  };

  approvalGrants.clearApprovalSession(sessionId);
  assert.equal(
    shouldAutoApprove(writeContext, {
      approvalGrants,
    }),
    true,
  );
  // 전체 액세스 = 전부 자동 (2026-07-12 소유자 결정) — 매 호출 재확인 제거
  assert.equal(
    shouldAutoApprove(destructiveContext, {
      approvalGrants,
    }),
    true,
  );

  // basic 모드는 grant 없이는 여전히 승인창
  assert.equal(
    shouldAutoApprove(
      { ...destructiveContext, permissionMode: 'basic' as const },
      { approvalGrants },
    ),
    false,
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
    shouldRequireApproval('local_registry_read_tool', {
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
