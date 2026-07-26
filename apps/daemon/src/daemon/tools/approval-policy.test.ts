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
import { createBuiltinToolRegistryStore } from './builtin/catalog.js';
import {
  mcpApprovalClass,
  projectMcpToolName,
} from '../mcp/global-mcp-tool-projection.js';
import type { AnyTool } from './types.js';
import { makeTestTool } from '../../test-support/loop-tool-execution-test-support.js';

// 승인 정책 테스트는 도구의 실행 동작에 관심이 없다. 도구 shape는 공용
// 빌더 하나만 알게 두고, 여기서는 승인 판정에 필요한 값만 채운다 — AnyTool에
// 필드가 늘어도 이 파일은 손대지 않는다.
function makeApprovalPolicyTool(args: {
  name: string;
  sideEffectLevel: AnyTool['sideEffectLevel'];
  requiresApproval: boolean;
}): AnyTool {
  return makeTestTool({
    name: args.name,
    description: 'test',
    sideEffectLevel: args.sideEffectLevel,
    requiresApproval: args.requiresApproval,
    async executeParsed() {
      return { ok: true, output: '' };
    },
  });
}

void test('mutating tools require approval and unknown tools fail closed', () => {
  const toolRegistry = createToolRegistryStore({ builtins: [] });
  toolRegistry.registerTool(
    makeApprovalPolicyTool({
      name: 'write_file',
      sideEffectLevel: 'write',
      requiresApproval: true,
    }),
  );
  toolRegistry.registerTool(
    makeApprovalPolicyTool({
      name: 'apply_patch',
      sideEffectLevel: 'write',
      requiresApproval: true,
    }),
  );
  toolRegistry.registerTool(
    makeApprovalPolicyTool({
      name: 'manage_files',
      sideEffectLevel: 'write',
      requiresApproval: true,
    }),
  );
  toolRegistry.registerTool(
    makeApprovalPolicyTool({
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
    makeApprovalPolicyTool({
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
    makeApprovalPolicyTool({
      name: 'exec_command',
      sideEffectLevel: 'destructive',
      requiresApproval: true,
    }),
  );

  const context = {
    runId: 'run-exec-command',
    computerSessionId: 'exec-command-session',
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
    makeApprovalPolicyTool({
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
        computerSessionId: 'refresh-session',
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
        computerSessionId: 'refresh-session',
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
  const toolRegistry = createToolRegistryStore({ builtins: [] });
  for (const name of ['read_file', 'write_file', 'manage_files']) {
    toolRegistry.registerTool(
      makeApprovalPolicyTool({
        name,
        sideEffectLevel: 'write',
        requiresApproval: true,
      }),
    );
  }

  assert.equal(
    resolveApprovalClass('read_file', undefined, { toolRegistry }),
    'read_file',
  );
  assert.equal(
    resolveApprovalClass('write_file', undefined, { toolRegistry }),
    'write_file:computer',
  );
  assert.equal(
    resolveApprovalClass(
      'manage_files',
      { operation: 'delete' },
      {
        toolRegistry,
      },
    ),
    'manage_files:delete:computer',
  );
  assert.equal(
    resolveApprovalClass(
      'manage_files',
      { operation: 'rename' },
      {
        toolRegistry,
      },
    ),
    'manage_files:rename:computer',
  );
});

void test('every builtin tool resolves to a valid approval class', () => {
  // 이 스위트가 오늘까지 놓친 것: `resolveApprovalClass`의 마지막 줄은 도구
  // 이름을 그대로 클래스로 쓰는데, 그것이 통하는 이유는 내장 도구 이름이
  // 우연히 슬러그이기 때문이지 규칙이 있어서가 아니었다. MCP 투영 이름이
  // 그 가정을 깨자 런이 통째로 죽었다(승인 층까지 가는 테스트가 없었다).
  //
  // 그래서 여기서 카탈로그 전체를 훑는다. 이름이 슬러그이거나 클래스를
  // 선언하거나 둘 중 하나여야 하고, 아니면 이 자리에서 걸린다.
  const toolRegistry = createBuiltinToolRegistryStore();
  const names = toolRegistry.getAllRegisteredToolNames();
  assert.ok(names.length > 0, 'the builtin catalog is not empty');

  const unresolvable = names.filter((name) => {
    try {
      resolveApprovalClass(name, {}, { toolRegistry });
      return false;
    } catch {
      return true;
    }
  });
  assert.deepEqual(
    unresolvable,
    [],
    'a tool whose name is not a slug must declare its approvalClass',
  );
});

void test('a declared approval class wins over the tool name', () => {
  // MCP 투영 이름은 내용 해시라 승인 클래스 문법을 만족하지 못한다. 도구가
  // 스스로 클래스를 선언하면 이름은 승낙의 단위가 아니게 된다.
  const toolRegistry = createToolRegistryStore({ builtins: [] });
  const projectedName = projectMcpToolName('a'.repeat(32), 'placement_probe');
  toolRegistry.registerTool({
    ...makeApprovalPolicyTool({
      name: projectedName,
      sideEffectLevel: 'write',
      requiresApproval: true,
    }),
    approvalClass: mcpApprovalClass('a'.repeat(32)),
  });

  assert.equal(
    resolveApprovalClass(projectedName, {}, { toolRegistry }),
    `mcp:${'a'.repeat(32)}`,
    'the grant is keyed on the server the user chose to install',
  );
});

void test('Computer file mutations retain truthful runtime effect levels', () => {
  const toolRegistry = createToolRegistryStore({ builtins: [] });
  for (const name of ['write_file', 'apply_patch', 'manage_files']) {
    toolRegistry.registerTool(
      makeApprovalPolicyTool({
        name,
        sideEffectLevel: 'write',
        requiresApproval: true,
      }),
    );
  }

  assert.equal(
    resolveApprovalClass('write_file', undefined, { toolRegistry }),
    'write_file:computer',
  );
  assert.equal(
    resolveApprovalClass('apply_patch', undefined, { toolRegistry }),
    'apply_patch:computer',
  );
  assert.equal(
    resolveApprovalClass(
      'manage_files',
      { operation: 'move' },
      {
        toolRegistry,
      },
    ),
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
    computerSessionId: 'root-scope-session',
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

void test('approval grants reuse only within an explicit run or computer session', () => {
  const approvalGrants = createApprovalGrantStore();
  const context = {
    runId: 'run-grant-a',
    computerSessionId: 'computer-session-a',
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

  approvalGrants.clearComputerSession(context.computerSessionId);
  approvalGrants.registerApprovalGrant(context, 'session');
  assert.equal(
    approvalGrants.hasApprovalGrant({ ...context, runId: 'run-grant-b' }),
    true,
  );
  assert.equal(
    approvalGrants.hasApprovalGrant({
      ...context,
      runId: 'run-grant-b',
      computerSessionId: 'computer-session-b',
    }),
    false,
  );
});

void test('full_access auto-approves write and destructive; basic still prompts', () => {
  const approvalGrants = createApprovalGrantStore();
  const computerSessionId = 'approval-session-test';
  const writeContext = {
    runId: 'run-write',
    computerSessionId,
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

  approvalGrants.clearComputerSession(computerSessionId);
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
  // yolo: 효과 수준과 무관하게 전부 자동 승인 (오너 결정 2026-07-23)
  assert.equal(
    shouldAutoApprove(
      { ...writeContext, sideEffectLevel: 'none' as const },
      { approvalGrants },
    ),
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
  approvalGrants.clearComputerSession(computerSessionId);
});

void test('approval policy can read tool metadata from an injected registry', () => {
  const store = createToolRegistryStore({ builtins: [] });
  store.registerTool(
    makeApprovalPolicyTool({
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
