import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { resolveToolApprovalState } from './loop-tool-approval.js';
import { buildAgentToolExecutionContextBase } from './loop-tool-runtime.js';
import { collectPreflight } from '../tools/approval-runtime-policy.js';
import { createApprovalGrantStore } from '../tools/approval-grants.js';
import { createBuiltinToolRegistryStore } from '../tools/builtin/catalog.js';
import { makeApprovalContext } from '../../test-support/approval-runtime.js';
import { makeRunContext } from '../../test-support/run-context.js';
import { testThreadId } from '../../test-support/thread-id.js';

function makePreflightRuntime(args: {
  runId: string;
  runContext: ReturnType<typeof makeRunContext>;
  approvalContext: ReturnType<typeof makeApprovalContext>;
  approvalGrants: ReturnType<typeof createApprovalGrantStore>;
  toolRegistry: ReturnType<typeof createBuiltinToolRegistryStore>;
  computerFileRoot?: string;
}) {
  return {
    approvalContext: args.approvalContext,
    approvalGrants: args.approvalGrants,
    toolRegistry: args.toolRegistry,
    executionContextBase: buildAgentToolExecutionContextBase({
      runContext: args.runContext,
      runId: args.runId,
      approvalContext: args.approvalContext,
      emit: () => {},
      currentFile: undefined,
      selection: undefined,
      signal: undefined,
      runState: undefined,
      ...(args.computerFileRoot === undefined
        ? {}
        : { computerFileRoot: args.computerFileRoot }),
      memoryIndex: undefined,
      agentSpawnRuntime: undefined,
    }),
  };
}

void test('resolveToolApprovalState skips approval for read-only tools', async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'geulbat-approval-'));
  const toolRegistry = createBuiltinToolRegistryStore();

  const result = await resolveToolApprovalState({
    approvalTarget: {
      runId: 'run-read-only',
      threadId: testThreadId(61),
    },
    toolName: 'read_file',
    toolArgs: {
      path: 'draft.md',
    },
    runtime: makePreflightRuntime({
      runId: 'run-read-only',
      runContext: makeRunContext({
        threadId: testThreadId(61),
        stateRoot: workspaceRoot,
      }),
      approvalContext: makeApprovalContext(),
      approvalGrants: createApprovalGrantStore(),
      toolRegistry,
    }),
  });

  assert.deepEqual(result, {
    needsApproval: false,
    approvalGranted: false,
  });
});

void test('resolveToolApprovalState auto-approves write tools in full_access mode', async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'geulbat-approval-'));
  const toolRegistry = createBuiltinToolRegistryStore();

  const result = await resolveToolApprovalState({
    approvalTarget: {
      runId: 'run-full-access',
      threadId: testThreadId(62),
    },
    toolName: 'manage_files',
    toolArgs: {
      operation: 'create',
      path: 'draft.md',
    },
    runtime: makePreflightRuntime({
      runId: 'run-full-access',
      runContext: makeRunContext({
        threadId: testThreadId(62),
        stateRoot: workspaceRoot,
      }),
      approvalContext: makeApprovalContext({
        permissionMode: 'full_access',
      }),
      approvalGrants: createApprovalGrantStore(),
      toolRegistry,
    }),
  });

  assert.deepEqual(result, {
    needsApproval: false,
    approvalGranted: true,
  });
});

void test('resolveToolApprovalState auto-approves computer writes in full_access mode', async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'geulbat-approval-'));
  const computerFileRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-computer-approval-'),
  );
  const toolRegistry = createBuiltinToolRegistryStore();

  const result = await resolveToolApprovalState({
    approvalTarget: {
      runId: 'run-full-access-computer',
      threadId: testThreadId(65),
    },
    toolName: 'write_file',
    toolArgs: {
      root: 'computer',
      path: 'draft.md',
    },
    runtime: makePreflightRuntime({
      runId: 'run-full-access-computer',
      runContext: makeRunContext({
        threadId: testThreadId(65),
        stateRoot: workspaceRoot,
      }),
      approvalContext: makeApprovalContext({
        permissionMode: 'full_access',
      }),
      approvalGrants: createApprovalGrantStore(),
      toolRegistry,
      computerFileRoot,
    }),
  });

  assert.deepEqual(result, {
    needsApproval: false,
    approvalGranted: true,
  });
});

void test('collectPreflight resolves explicit computer paths against the computer root', async () => {
  const computerFileRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-computer-approval-'),
  );
  const computerPath = join(computerFileRoot, 'draft.md');

  await assert.doesNotReject(
    collectPreflight({ computerFileRoot }, { path: computerPath }),
  );
  await assert.rejects(collectPreflight({}, { path: computerPath }));
});

void test('resolveToolApprovalState fails closed when preflight throws', async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'geulbat-approval-'));
  const computerFileRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-computer-approval-'),
  );
  const toolRegistry = createBuiltinToolRegistryStore();

  const result = await resolveToolApprovalState({
    approvalTarget: {
      runId: 'run-preflight-failure',
      threadId: testThreadId(63),
    },
    toolName: 'manage_files',
    toolArgs: {
      operation: 'create',
      path: '../escape.txt',
    },
    runtime: makePreflightRuntime({
      runId: 'run-preflight-failure',
      runContext: makeRunContext({
        threadId: testThreadId(63),
        stateRoot: workspaceRoot,
      }),
      approvalContext: makeApprovalContext(),
      approvalGrants: createApprovalGrantStore(),
      toolRegistry,
      computerFileRoot,
    }),
  });

  assert.deepEqual(result, {
    needsApproval: true,
    approvalGranted: false,
  });
});

void test('resolveToolApprovalState fails closed for unregistered tools', async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'geulbat-approval-'));
  const toolRegistry = createBuiltinToolRegistryStore();

  const result = await resolveToolApprovalState({
    approvalTarget: {
      runId: 'run-unregistered-tool',
      threadId: testThreadId(64),
    },
    toolName: 'totally_unknown_tool',
    toolArgs: {
      path: 'draft.md',
    },
    runtime: makePreflightRuntime({
      runId: 'run-unregistered-tool',
      runContext: makeRunContext({
        threadId: testThreadId(64),
        stateRoot: workspaceRoot,
      }),
      approvalContext: makeApprovalContext(),
      approvalGrants: createApprovalGrantStore(),
      toolRegistry,
    }),
  });

  assert.deepEqual(result, {
    needsApproval: true,
    approvalGranted: false,
  });
});
