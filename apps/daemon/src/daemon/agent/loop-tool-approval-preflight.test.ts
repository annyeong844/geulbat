import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  buildAgentToolExecutionContextBase,
  resolveToolApprovalState,
} from './loop-tool-approval.js';
import { createApprovalGrantStore } from '../tools/approval-grants.js';
import { createBuiltinToolRegistryStore } from '../tools/builtin/catalog.js';
import { makeApprovalContext } from '../../test-support/approval-runtime.js';
import { makeRunWorkspaceContext } from '../../test-support/run-workspace-context.js';
import { testProjectId } from '../../test-support/project-id.js';
import { testThreadId } from '../../test-support/thread-id.js';

function makePreflightRuntime(args: {
  runId: string;
  runContext: ReturnType<typeof makeRunWorkspaceContext>;
  approvalContext: ReturnType<typeof makeApprovalContext>;
  approvalGrants: ReturnType<typeof createApprovalGrantStore>;
  toolRegistry: ReturnType<typeof createBuiltinToolRegistryStore>;
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
      runContext: makeRunWorkspaceContext({
        threadId: testThreadId(61),
        projectId: testProjectId('project'),
        workspaceRoot,
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
      runContext: makeRunWorkspaceContext({
        threadId: testThreadId(62),
        projectId: testProjectId('project'),
        workspaceRoot,
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

void test('resolveToolApprovalState fails closed when preflight throws', async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'geulbat-approval-'));
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
      runContext: makeRunWorkspaceContext({
        threadId: testThreadId(63),
        projectId: testProjectId('project'),
        workspaceRoot,
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
      runContext: makeRunWorkspaceContext({
        threadId: testThreadId(64),
        projectId: testProjectId('project'),
        workspaceRoot,
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
