import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { resolveToolApprovalState } from './loop-tool-approval.js';
import { buildAgentToolExecutionContextBase } from './loop-tool-runtime.js';
import {
  collectPreflight,
  isApprovalPreflightCurrent,
} from '../tools/approval-runtime-policy.js';
import { createApprovalGrantStore } from '../tools/approval-grants.js';
import { createBuiltinToolRegistryStore } from '../tools/builtin/catalog.js';
import { makeApprovalContext } from '../../test-support/approval-runtime.js';
import { makeRunContext } from '../../test-support/run-context.js';
import { testThreadId } from '../../test-support/thread-id.js';
import { createSymlinkOrSkip } from '../../test-support/symlink-test.js';

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
      runtimeServices: undefined,
    }),
  };
}

function makeUpdatePatch(path: string): string {
  return [
    '*** Begin Patch',
    `*** Update File: ${path}`,
    '@@',
    '-before',
    '+after',
    '*** End Patch',
    '',
  ].join('\n');
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

void test('resolveToolApprovalState auto-approves apply_patch in full_access mode', async () => {
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
    toolName: 'apply_patch',
    toolArgs: {
      patch: makeUpdatePatch('draft.md'),
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

void test('resolveToolApprovalState records the canonical apply_patch target for basic approval', async (t) => {
  const outerRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-apply-patch-approval-'),
  );
  t.after(() => rm(outerRoot, { recursive: true, force: true }));
  const workspaceRoot = join(outerRoot, 'state');
  const computerFileRoot = join(outerRoot, 'computer');
  const externalRoot = join(outerRoot, 'external');
  await mkdir(workspaceRoot, { recursive: true });
  await mkdir(computerFileRoot, { recursive: true });
  await mkdir(externalRoot, { recursive: true });
  const targetPath = join(externalRoot, 'draft.md');
  const patch = makeUpdatePatch(targetPath);
  const toolRegistry = createBuiltinToolRegistryStore();

  const result = await resolveToolApprovalState({
    approvalTarget: {
      runId: 'run-apply-patch-preflight',
      threadId: testThreadId(66),
    },
    toolName: 'apply_patch',
    toolArgs: { patch },
    runtime: makePreflightRuntime({
      runId: 'run-apply-patch-preflight',
      runContext: makeRunContext({
        threadId: testThreadId(66),
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
    preflight: {
      mutationTargets: [
        {
          argument: 'patch',
          canonicalTargetId: targetPath,
        },
      ],
    },
  });
  assert.ok(result.preflight);
  assert.equal(
    await isApprovalPreflightCurrent(
      'apply_patch',
      { computerFileRoot },
      { patch },
      result.preflight,
    ),
    true,
  );
});

void test('collectPreflight resolves explicit computer paths against the computer root', async () => {
  const computerFileRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-computer-approval-'),
  );
  const computerPath = join(computerFileRoot, 'draft.md');

  assert.deepEqual(
    await collectPreflight(
      'write_file',
      { computerFileRoot },
      { path: computerPath },
    ),
    {
      mutationTargets: [
        {
          argument: 'path',
          canonicalTargetId: computerPath,
        },
      ],
    },
  );
  await assert.rejects(
    collectPreflight('write_file', {}, { path: computerPath }),
  );
});

void test('collectPreflight ignores non-local tool path arguments', async () => {
  assert.equal(
    await collectPreflight(
      'mcp__remote__read_object',
      {},
      { path: '/remote/object-key' },
    ),
    undefined,
  );
});

void test('collectPreflight rejects malformed and multi-file apply_patch input through the canonical parser', async (t) => {
  const computerFileRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-apply-patch-approval-'),
  );
  t.after(() => rm(computerFileRoot, { recursive: true, force: true }));
  await assert.rejects(
    collectPreflight(
      'apply_patch',
      { computerFileRoot },
      { patch: 'not a patch' },
    ),
    /must start with \*\*\* Begin Patch/u,
  );
  await assert.rejects(
    collectPreflight(
      'apply_patch',
      { computerFileRoot },
      {
        patch: [
          '*** Begin Patch',
          '*** Update File: first.md',
          '@@',
          '-before',
          '+after',
          '*** Update File: second.md',
          '@@',
          '-before',
          '+after',
          '*** End Patch',
          '',
        ].join('\n'),
      },
    ),
    /requires exactly one file operation/u,
  );
});

void test('isApprovalPreflightCurrent rejects an apply_patch file symlink swap', async (t) => {
  const outerRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-apply-patch-file-swap-'),
  );
  t.after(() => rm(outerRoot, { recursive: true, force: true }));
  const computerFileRoot = join(outerRoot, 'computer');
  const firstTarget = join(outerRoot, 'first.md');
  const secondTarget = join(outerRoot, 'second.md');
  const linkedFile = join(computerFileRoot, 'draft.md');
  await mkdir(computerFileRoot, { recursive: true });
  await writeFile(firstTarget, 'before\n', 'utf8');
  await writeFile(secondTarget, 'before\n', 'utf8');
  if (!(await createSymlinkOrSkip(t, firstTarget, linkedFile))) {
    return;
  }
  const toolArgs = { patch: makeUpdatePatch('draft.md') };
  const preflight = await collectPreflight(
    'apply_patch',
    { computerFileRoot, workingDirectory: '' },
    toolArgs,
  );
  assert.ok(preflight);

  await rm(linkedFile);
  if (!(await createSymlinkOrSkip(t, secondTarget, linkedFile))) {
    return;
  }

  assert.equal(
    await isApprovalPreflightCurrent(
      'apply_patch',
      { computerFileRoot, workingDirectory: '' },
      toolArgs,
      preflight,
    ),
    false,
  );
});

void test('isApprovalPreflightCurrent rejects an apply_patch parent symlink swap', async (t) => {
  const outerRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-apply-patch-parent-swap-'),
  );
  t.after(() => rm(outerRoot, { recursive: true, force: true }));
  const computerFileRoot = join(outerRoot, 'computer');
  const outsideRoot = join(outerRoot, 'outside');
  const linkedParent = join(computerFileRoot, 'sub');
  await mkdir(linkedParent, { recursive: true });
  await mkdir(outsideRoot, { recursive: true });
  const toolArgs = { patch: makeUpdatePatch('sub/draft.md') };
  const preflight = await collectPreflight(
    'apply_patch',
    { computerFileRoot, workingDirectory: '' },
    toolArgs,
  );
  assert.ok(preflight);

  await rm(linkedParent, { recursive: true, force: true });
  if (!(await createSymlinkOrSkip(t, outsideRoot, linkedParent))) {
    return;
  }

  assert.equal(
    await isApprovalPreflightCurrent(
      'apply_patch',
      { computerFileRoot, workingDirectory: '' },
      toolArgs,
      preflight,
    ),
    false,
  );
});

void test('isApprovalPreflightCurrent rejects a parent symlink swap', async (t) => {
  const outerRoot = await mkdtemp(join(tmpdir(), 'geulbat-approval-swap-'));
  t.after(() => rm(outerRoot, { recursive: true, force: true }));
  const computerFileRoot = join(outerRoot, 'computer');
  const outsideRoot = join(outerRoot, 'outside');
  const linkedParent = join(computerFileRoot, 'sub');
  await mkdir(linkedParent, { recursive: true });
  await mkdir(outsideRoot, { recursive: true });
  const toolArgs = { path: 'sub/draft.md' };
  const preflight = await collectPreflight(
    'manage_files',
    { computerFileRoot, workingDirectory: '' },
    toolArgs,
  );
  assert.ok(preflight);

  await rm(linkedParent, { recursive: true, force: true });
  if (!(await createSymlinkOrSkip(t, outsideRoot, linkedParent))) {
    return;
  }

  assert.equal(
    await isApprovalPreflightCurrent(
      'manage_files',
      { computerFileRoot, workingDirectory: '' },
      toolArgs,
      preflight,
    ),
    false,
  );
});

void test('resolveToolApprovalState fails closed when the Computer coordinate base is unavailable', async () => {
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
      path: 'draft.txt',
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
