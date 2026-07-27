import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtemp,
  mkdir,
  readFile as fsReadFile,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  assertRunId,
  assertThreadId,
  type RunId,
  type ThreadId,
} from '@geulbat/protocol/ids';
import { createSymlinkOrSkip } from '../../../test-support/symlink-test.js';
import { createDaemonContext } from '../../context.js';
import {
  operationManifestToJsonValue,
  prepareOperationManifest,
  type OperationManifest,
} from '../../files/operation-manifest.js';
import { readFile } from '../../files/read-file.js';
import {
  countTextLines,
  normalizeTextContent,
} from '../../files/text-content.js';
import { createVersionToken } from '../../files/version-token.js';
import type { JsonValue } from '../../runtime-json.js';
import { isToolObjectParameters, type ToolExecutionContext } from '../types.js';
import { applyPatchTool } from './apply-patch.js';
import { manageFilesTool } from './manage-files.js';

function buildApplyPatchAgentContext(args: {
  stateRoot: string;
  threadId: ThreadId;
  runId: RunId;
  callId: string;
  runtimeServices: ReturnType<typeof createDaemonContext>;
}): ToolExecutionContext {
  return {
    kind: 'agent',
    callId: args.callId,
    signal: undefined,
    runSignal: undefined,
    currentFile: undefined,
    selection: undefined,
    approvalGranted: true,
    computerSessionId: 'session-apply-patch-durable',
    computerFileRoot: args.stateRoot,
    permissionMode: 'full_access',
    stateRoot: args.stateRoot,
    threadId: args.threadId,
    runId: args.runId,
    runOwnerKind: 'root_main',
    workingDirectory: args.stateRoot,
    runState: undefined,
    memoryIndex: args.runtimeServices.memoryIndex,
    runtimeServices: args.runtimeServices,
    emitAgentEvent() {},
  };
}

function buildApplyPatchManifest(args: {
  runId: RunId;
  callId: string;
  targetPath: string;
  relativePath: string;
  content: string;
  expectedVersionToken?: string;
}): OperationManifest {
  const canonicalContent = normalizeTextContent(args.content);
  const isUpdate = args.expectedVersionToken !== undefined;
  return prepareOperationManifest({
    operationId: args.callId,
    manifestRevision: '1',
    operationKind: isUpdate ? 'overwrite' : 'create_file',
    authorityId: 'computer',
    actor: { kind: 'assistant', runId: args.runId },
    targets: [
      {
        role: isUpdate ? 'single' : 'destination',
        path: args.relativePath,
        canonicalTargetId: args.targetPath,
        ...(args.expectedVersionToken === undefined
          ? {}
          : {
              expectedKind: 'file' as const,
              expectedVersionToken: args.expectedVersionToken,
            }),
      },
    ],
    approval: { required: true },
    payloadDigest: {
      kind: 'content',
      digest: createVersionToken(canonicalContent),
    },
    atomicity: 'atomic',
    createdAt: '2026-07-27T00:00:00.000Z',
  });
}

function buildApplyPatchRecoveryState(args: {
  manifest: OperationManifest;
  patch: string;
}): JsonValue {
  return {
    manifest: operationManifestToJsonValue(args.manifest),
    patchDigest: createVersionToken(normalizeTextContent(args.patch)),
  };
}

async function injectApplyPatchInvocation(args: {
  runtimeServices: ReturnType<typeof createDaemonContext>;
  threadId: ThreadId;
  runId: RunId;
  callId: string;
  manifest: OperationManifest;
  patch: string;
}): Promise<void> {
  const recorded =
    await args.runtimeServices.runCheckpoints.recordToolInvocation({
      threadId: args.threadId,
      runId: args.runId,
      invocation: {
        callId: args.callId,
        toolName: applyPatchTool.name,
        recoveryStrategy: 'reconcile_then_replay',
        recoveryState: buildApplyPatchRecoveryState({
          manifest: args.manifest,
          patch: args.patch,
        }),
      },
    });
  assert.equal(recorded.ok, true);
}

void test('apply_patch publishes only the patch text contract', () => {
  const parameters = applyPatchTool.parameters;

  assert.ok(isToolObjectParameters(parameters));
  assert.deepEqual(parameters.required, ['patch']);
  assert.deepEqual(Object.keys(parameters.properties), ['patch']);
  assert.deepEqual(applyPatchTool.exposure, {
    directHot: true,
    sdkVisible: false,
    inCellCallable: false,
    directOnly: true,
    effectClass: 'computerWrite',
  });
});

void test('apply_patch declares reconcile-then-replay recovery', () => {
  assert.equal(applyPatchTool.recoveryStrategy, 'reconcile_then_replay');
});

void test('apply_patch checkpoints and reconciles an agent update before returning', async (t) => {
  const stateRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-apply-patch-durable-'),
  );
  t.after(async () => rm(stateRoot, { recursive: true, force: true }));
  const runtimeServices = createDaemonContext({ homeStateRoot: stateRoot });
  const threadId = assertThreadId('123e4567-e89b-42d3-a456-426614174042');
  const runId = assertRunId('run-apply-patch-durable');
  const targetPath = join(stateRoot, 'durable.txt');
  await writeFile(targetPath, 'before\n', 'utf8');
  await runtimeServices.runCheckpoints.startRun({
    threadId,
    runId,
    request: { workingDirectory: stateRoot, permissionMode: 'full_access' },
  });
  const context = buildApplyPatchAgentContext({
    stateRoot,
    threadId,
    runId,
    callId: 'call-apply-patch-durable',
    runtimeServices,
  });

  const result = await applyPatchTool.execute(
    { patch: updatePatch('durable.txt', 'before\n', 'after\n') },
    context,
  );

  assert.equal(result.ok, true);
  assert.equal(await fsReadFile(targetPath, 'utf8'), 'after\n');
  const invocation = (await runtimeServices.runCheckpoints.readThread(threadId))
    ?.toolInvocations[0];
  assert.equal(invocation?.status, 'reconciled');
  if (invocation?.status === 'reconciled') {
    assert.equal(invocation.callId, context.callId);
    assert.deepEqual(invocation.result, result);
  }

  const withoutCheckpoint = await applyPatchTool.execute(
    { patch: updatePatch('durable.txt', 'after\n', 'must not land\n') },
    {
      ...context,
      callId: 'call-apply-patch-without-checkpoint',
      runId: assertRunId('run-apply-patch-without-checkpoint'),
    },
  );
  assert.equal(withoutCheckpoint.ok, false);
  if (!withoutCheckpoint.ok) {
    assert.equal(withoutCheckpoint.errorCode, 'execution_failed');
    assert.match(withoutCheckpoint.error, /durable run checkpoint/);
  }
  assert.equal(await fsReadFile(targetPath, 'utf8'), 'after\n');
});

void test('apply_patch restart recovery replays an add whose effect did not start', async (t) => {
  const stateRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-apply-patch-recovery-'),
  );
  t.after(async () => rm(stateRoot, { recursive: true, force: true }));
  const runtimeServices = createDaemonContext({ homeStateRoot: stateRoot });
  const threadId = assertThreadId('123e4567-e89b-42d3-a456-426614174043');
  const runId = assertRunId('run-apply-patch-add-recovery');
  const callId = 'call-apply-patch-add-recovery';
  const relativePath = 'restart-created.txt';
  const targetPath = join(stateRoot, relativePath);
  const content = 'created after restart\n';
  const patch = addPatch(relativePath, content);
  await runtimeServices.runCheckpoints.startRun({
    threadId,
    runId,
    request: { workingDirectory: stateRoot, permissionMode: 'full_access' },
  });
  await injectApplyPatchInvocation({
    runtimeServices,
    threadId,
    runId,
    callId,
    manifest: buildApplyPatchManifest({
      runId,
      callId,
      targetPath,
      relativePath,
      content,
    }),
    patch,
  });

  const result = await applyPatchTool.execute(
    { patch },
    buildApplyPatchAgentContext({
      stateRoot,
      threadId,
      runId,
      callId,
      runtimeServices,
    }),
  );

  assert.equal(result.ok, true);
  assert.equal(await fsReadFile(targetPath, 'utf8'), content);
  if (result.ok) {
    assert.deepEqual(JSON.parse(result.output), {
      ok: true,
      root: 'computer',
      operation: 'add',
      path: relativePath,
      versionToken: createVersionToken(content),
      totalLines: countTextLines(content),
      linesChanged: countTextLines(content),
    });
  }
  const invocation = (await runtimeServices.runCheckpoints.readThread(threadId))
    ?.toolInvocations[0];
  assert.equal(invocation?.status, 'reconciled');
});

void test('apply_patch restart recovery refuses a different patch for the same durable call', async (t) => {
  const stateRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-apply-patch-recovery-'),
  );
  t.after(async () => rm(stateRoot, { recursive: true, force: true }));
  const runtimeServices = createDaemonContext({ homeStateRoot: stateRoot });
  const threadId = assertThreadId('123e4567-e89b-42d3-a456-426614174047');
  const runId = assertRunId('run-apply-patch-identity-conflict');
  const callId = 'call-apply-patch-identity-conflict';
  const relativePath = 'restart-identity-conflict.txt';
  const targetPath = join(stateRoot, relativePath);
  const originalContent = 'before\n';
  const recordedContent = 'recorded after\n';
  const conflictingContent = 'different after\n';
  const recordedPatch = updatePatch(
    relativePath,
    originalContent,
    recordedContent,
  );
  await writeFile(targetPath, originalContent, 'utf8');
  const original = await readFile(stateRoot, relativePath);
  await runtimeServices.runCheckpoints.startRun({
    threadId,
    runId,
    request: { workingDirectory: stateRoot, permissionMode: 'full_access' },
  });
  await injectApplyPatchInvocation({
    runtimeServices,
    threadId,
    runId,
    callId,
    manifest: buildApplyPatchManifest({
      runId,
      callId,
      targetPath,
      relativePath,
      content: recordedContent,
      expectedVersionToken: original.versionToken,
    }),
    patch: recordedPatch,
  });

  const result = await applyPatchTool.execute(
    {
      patch: updatePatch(relativePath, originalContent, conflictingContent),
    },
    buildApplyPatchAgentContext({
      stateRoot,
      threadId,
      runId,
      callId,
      runtimeServices,
    }),
  );

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.errorCode, 'execution_failed');
    assert.match(result.error, /recovery manifest is invalid/);
  }
  assert.equal(await fsReadFile(targetPath, 'utf8'), originalContent);
  const invocation = (await runtimeServices.runCheckpoints.readThread(threadId))
    ?.toolInvocations[0];
  assert.equal(invocation?.status, 'in_flight');
});

void test('apply_patch restart recovery replays an update whose original version is unchanged', async (t) => {
  const stateRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-apply-patch-recovery-'),
  );
  t.after(async () => rm(stateRoot, { recursive: true, force: true }));
  const runtimeServices = createDaemonContext({ homeStateRoot: stateRoot });
  const threadId = assertThreadId('123e4567-e89b-42d3-a456-426614174046');
  const runId = assertRunId('run-apply-patch-update-replay');
  const callId = 'call-apply-patch-update-replay';
  const relativePath = 'restart-update-replay.txt';
  const targetPath = join(stateRoot, relativePath);
  const before = 'before\n';
  const after = 'after\n';
  const patch = updatePatch(relativePath, before, after);
  await writeFile(targetPath, before, 'utf8');
  const original = await readFile(stateRoot, relativePath);
  await runtimeServices.runCheckpoints.startRun({
    threadId,
    runId,
    request: { workingDirectory: stateRoot, permissionMode: 'full_access' },
  });
  await injectApplyPatchInvocation({
    runtimeServices,
    threadId,
    runId,
    callId,
    manifest: buildApplyPatchManifest({
      runId,
      callId,
      targetPath,
      relativePath,
      content: after,
      expectedVersionToken: original.versionToken,
    }),
    patch,
  });

  const result = await applyPatchTool.execute(
    { patch },
    buildApplyPatchAgentContext({
      stateRoot,
      threadId,
      runId,
      callId,
      runtimeServices,
    }),
  );

  assert.equal(result.ok, true);
  assert.equal(await fsReadFile(targetPath, 'utf8'), after);
  const invocation = (await runtimeServices.runCheckpoints.readThread(threadId))
    ?.toolInvocations[0];
  assert.equal(invocation?.status, 'reconciled');
  if (invocation?.status === 'reconciled') {
    assert.deepEqual(invocation.result, result);
  }
});

void test('apply_patch restart recovery restores an update completed before result persistence', async (t) => {
  const stateRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-apply-patch-recovery-'),
  );
  t.after(async () => rm(stateRoot, { recursive: true, force: true }));
  const runtimeServices = createDaemonContext({ homeStateRoot: stateRoot });
  const threadId = assertThreadId('123e4567-e89b-42d3-a456-426614174044');
  const runId = assertRunId('run-apply-patch-update-recovery');
  const callId = 'call-apply-patch-update-recovery';
  const relativePath = 'restart-updated.txt';
  const targetPath = join(stateRoot, relativePath);
  const before = 'before\n';
  const after = 'after\nextra\n';
  const patch = updatePatch(relativePath, before, after);
  await writeFile(targetPath, before, 'utf8');
  const original = await readFile(stateRoot, relativePath);
  await runtimeServices.runCheckpoints.startRun({
    threadId,
    runId,
    request: { workingDirectory: stateRoot, permissionMode: 'full_access' },
  });
  await injectApplyPatchInvocation({
    runtimeServices,
    threadId,
    runId,
    callId,
    manifest: buildApplyPatchManifest({
      runId,
      callId,
      targetPath,
      relativePath,
      content: after,
      expectedVersionToken: original.versionToken,
    }),
    patch,
  });
  await writeFile(targetPath, after, 'utf8');

  const result = await applyPatchTool.execute(
    { patch },
    buildApplyPatchAgentContext({
      stateRoot,
      threadId,
      runId,
      callId,
      runtimeServices,
    }),
  );

  assert.equal(result.ok, true);
  assert.equal(await fsReadFile(targetPath, 'utf8'), after);
  if (result.ok) {
    assert.deepEqual(JSON.parse(result.output), {
      ok: true,
      root: 'computer',
      operation: 'update',
      path: relativePath,
      versionToken: createVersionToken(after),
      totalLines: countTextLines(after),
      linesChanged: 1,
    });
  }
  const invocation = (await runtimeServices.runCheckpoints.readThread(threadId))
    ?.toolInvocations[0];
  assert.equal(invocation?.status, 'reconciled');
  if (invocation?.status === 'reconciled') {
    assert.deepEqual(invocation.result, result);
  }
});

void test('apply_patch restart recovery rejects a stale replacement without patching it', async (t) => {
  const stateRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-apply-patch-recovery-'),
  );
  t.after(async () => rm(stateRoot, { recursive: true, force: true }));
  const runtimeServices = createDaemonContext({ homeStateRoot: stateRoot });
  const threadId = assertThreadId('123e4567-e89b-42d3-a456-426614174045');
  const runId = assertRunId('run-apply-patch-stale-recovery');
  const callId = 'call-apply-patch-stale-recovery';
  const relativePath = 'restart-stale.txt';
  const targetPath = join(stateRoot, relativePath);
  const before = 'before\n';
  const after = 'after\n';
  const replacement = 'replacement from another writer\n';
  const patch = updatePatch(relativePath, before, after);
  await writeFile(targetPath, before, 'utf8');
  const original = await readFile(stateRoot, relativePath);
  await runtimeServices.runCheckpoints.startRun({
    threadId,
    runId,
    request: { workingDirectory: stateRoot, permissionMode: 'full_access' },
  });
  await injectApplyPatchInvocation({
    runtimeServices,
    threadId,
    runId,
    callId,
    manifest: buildApplyPatchManifest({
      runId,
      callId,
      targetPath,
      relativePath,
      content: after,
      expectedVersionToken: original.versionToken,
    }),
    patch,
  });
  await writeFile(targetPath, replacement, 'utf8');

  const result = await applyPatchTool.execute(
    { patch },
    buildApplyPatchAgentContext({
      stateRoot,
      threadId,
      runId,
      callId,
      runtimeServices,
    }),
  );

  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'conflict_stale_write');
  assert.equal(await fsReadFile(targetPath, 'utf8'), replacement);
  const invocation = (await runtimeServices.runCheckpoints.readThread(threadId))
    ?.toolInvocations[0];
  assert.equal(invocation?.status, 'reconciled');
  if (invocation?.status === 'reconciled') {
    assert.deepEqual(invocation.result, result);
  }
});

void test('apply_patch rejects the removed legacy root selector', async () => {
  const result = await applyPatchTool.execute(
    {
      root: 'computer',
      patch: [
        '*** Begin Patch',
        '*** Add File: created.txt',
        '+hello',
        '*** End Patch',
        '',
      ].join('\n'),
    },
    { callId: 'call-apply-patch-legacy-root', computerFileRoot: '/computer' },
  );

  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'invalid_args');
  assert.match(result.error ?? '', /root/u);
});

void test('apply_patch rejects unexpected keys instead of silently dropping them', async () => {
  const computerFileRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-apply-patch-'),
  );

  const result = await applyPatchTool.execute(
    {
      patch: updatePatch('hello.txt', 'hello\n', 'updated\n'),
      extra: true,
    },
    { callId: 'call-apply-patch-extra', computerFileRoot },
  );

  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'invalid_args');
  assert.match(result.error ?? '', /unexpected keys: extra\./);
});

void test('apply_patch rejects malformed patch blocks', async () => {
  const computerFileRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-apply-patch-'),
  );

  const result = await applyPatchTool.execute(
    { patch: '*** Update File: hello.txt\n@@\n-hello\n+updated\n' },
    { callId: 'call-apply-patch-malformed', computerFileRoot },
  );

  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'invalid_args');
  assert.match(result.error ?? '', /must start with \*\*\* Begin Patch/);
});

void test('apply_patch applies one update hunk with exact context', async () => {
  const computerFileRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-apply-patch-'),
  );
  await writeFile(
    join(computerFileRoot, 'hello.txt'),
    'hello\nworld\n',
    'utf8',
  );

  const result = await applyPatchTool.execute(
    { patch: updatePatch('hello.txt', 'world\n', 'geulbat\n') },
    { callId: 'call-apply-patch-update', computerFileRoot },
  );

  assert.equal(result.ok, true);
  assert.equal(
    await fsReadFile(join(computerFileRoot, 'hello.txt'), 'utf8'),
    'hello\ngeulbat\n',
  );
});

void test('apply_patch atomically updates a file through a symlink', async (t) => {
  const computerFileRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-apply-patch-symlink-'),
  );
  const targetPath = join(computerFileRoot, '.env');
  const linkedPath = join(computerFileRoot, 'settings.txt');
  await writeFile(targetPath, 'MODE=old\n', 'utf8');
  if (!(await createSymlinkOrSkip(t, targetPath, linkedPath))) {
    return;
  }

  const result = await applyPatchTool.execute(
    { patch: updatePatch('settings.txt', 'MODE=old\n', 'MODE=new\n') },
    { callId: 'call-apply-patch-symlink', computerFileRoot },
  );

  assert.equal(result.ok, true);
  assert.equal(await fsReadFile(targetPath, 'utf8'), 'MODE=new\n');
  assert.equal(await fsReadFile(linkedPath, 'utf8'), 'MODE=new\n');
});

void test('apply_patch applies multiple hunks in one file operation', async () => {
  const computerFileRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-apply-patch-'),
  );
  await writeFile(
    join(computerFileRoot, 'hello.txt'),
    'alpha\nbravo\ncharlie\n',
    'utf8',
  );

  const result = await applyPatchTool.execute(
    {
      patch: [
        '*** Begin Patch',
        '*** Update File: hello.txt',
        '@@ first',
        '-alpha',
        '+ALPHA',
        '@@ second',
        '-charlie',
        '+CHARLIE',
        '*** End Patch',
        '',
      ].join('\n'),
    },
    { callId: 'call-apply-patch-multi-hunk', computerFileRoot },
  );

  assert.equal(result.ok, true);
  assert.equal(
    await fsReadFile(join(computerFileRoot, 'hello.txt'), 'utf8'),
    'ALPHA\nbravo\nCHARLIE\n',
  );
});

void test('apply_patch rejects hunk context that appears more than once', async () => {
  const computerFileRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-apply-patch-'),
  );
  await writeFile(
    join(computerFileRoot, 'hello.txt'),
    'hello\nhello\n',
    'utf8',
  );

  const result = await applyPatchTool.execute(
    { patch: updatePatch('hello.txt', 'hello\n', 'updated\n') },
    { callId: 'call-apply-patch-duplicate', computerFileRoot },
  );

  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'invalid_args');
  assert.match(result.error ?? '', /matched 2 times/);
});

void test('apply_patch adds a new file', async () => {
  const computerFileRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-apply-patch-'),
  );

  const result = await applyPatchTool.execute(
    {
      patch: [
        '*** Begin Patch',
        '*** Add File: created.txt',
        '+hello',
        '+world',
        '*** End Patch',
        '',
      ].join('\n'),
    },
    { callId: 'call-apply-patch-add', computerFileRoot },
  );

  assert.equal(result.ok, true);
  assert.equal(
    await fsReadFile(join(computerFileRoot, 'created.txt'), 'utf8'),
    'hello\nworld\n',
  );
});

void test('apply_patch adds and updates files in ComputerFileScope', async () => {
  const computerFileRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-computer-apply-patch-'),
  );

  const added = await applyPatchTool.execute(
    {
      patch: [
        '*** Begin Patch',
        '*** Add File: created.txt',
        '+hello',
        '*** End Patch',
        '',
      ].join('\n'),
    },
    {
      callId: 'call-computer-apply-patch-add',
      computerFileRoot,
    },
  );

  assert.equal(added.ok, true);
  assert.equal(JSON.parse(added.output).root, 'computer');
  assert.equal(
    await fsReadFile(join(computerFileRoot, 'created.txt'), 'utf8'),
    'hello\n',
  );

  const updated = await applyPatchTool.execute(
    {
      patch: updatePatch('created.txt', 'hello\n', 'updated\n'),
    },
    {
      callId: 'call-computer-apply-patch-update',
      computerFileRoot,
    },
  );

  assert.equal(updated.ok, true);
  assert.equal(JSON.parse(updated.output).root, 'computer');
  assert.equal(
    await fsReadFile(join(computerFileRoot, 'created.txt'), 'utf8'),
    'updated\n',
  );
});

void test('apply_patch adds a new file without forcing a final newline', async () => {
  const computerFileRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-apply-patch-'),
  );

  const result = await applyPatchTool.execute(
    {
      patch: [
        '*** Begin Patch',
        '*** Add File: no-newline.txt',
        '+hello',
        '*** End of File',
        '*** End Patch',
        '',
      ].join('\n'),
    },
    { callId: 'call-apply-patch-add-no-newline', computerFileRoot },
  );

  assert.equal(result.ok, true);
  assert.equal(
    await fsReadFile(join(computerFileRoot, 'no-newline.txt'), 'utf8'),
    'hello',
  );
});

void test('apply_patch rejects adding over an existing file', async () => {
  const computerFileRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-apply-patch-'),
  );
  await writeFile(join(computerFileRoot, 'hello.txt'), 'hello\n', 'utf8');

  const result = await applyPatchTool.execute(
    {
      patch: [
        '*** Begin Patch',
        '*** Add File: hello.txt',
        '+updated',
        '*** End Patch',
        '',
      ].join('\n'),
    },
    { callId: 'call-apply-patch-existing-add', computerFileRoot },
  );

  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'invalid_args');
  assert.match(result.error ?? '', /already exists/);
});

void test('apply_patch rejects Delete File sections without removing files or directories', async () => {
  const computerFileRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-apply-patch-'),
  );
  await mkdir(join(computerFileRoot, 'delete-me'), { recursive: true });
  await writeFile(
    join(computerFileRoot, 'delete-me', 'kept.txt'),
    'kept\n',
    'utf8',
  );

  const result = await applyPatchTool.execute(
    {
      patch: [
        '*** Begin Patch',
        '*** Delete File: delete-me',
        '*** End Patch',
        '',
      ].join('\n'),
    },
    { callId: 'call-apply-patch-delete', computerFileRoot },
  );

  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'invalid_args');
  assert.match(result.error ?? '', /Delete File is not supported/);
  assert.equal(
    (await stat(join(computerFileRoot, 'delete-me'))).isDirectory(),
    true,
  );
  assert.equal(
    await fsReadFile(join(computerFileRoot, 'delete-me', 'kept.txt'), 'utf8'),
    'kept\n',
  );
});

void test('apply_patch rejects more than one file operation in one call', async () => {
  const computerFileRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-apply-patch-'),
  );

  const result = await applyPatchTool.execute(
    {
      patch: [
        '*** Begin Patch',
        '*** Add File: first.txt',
        '+first',
        '*** Add File: second.txt',
        '+second',
        '*** End Patch',
        '',
      ].join('\n'),
    },
    { callId: 'call-apply-patch-multi-file', computerFileRoot },
  );

  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'invalid_args');
  assert.match(result.error ?? '', /exactly one file operation/);
});

void test('apply_patch rejects old source paths after manage_files rename', async () => {
  const computerFileRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-apply-patch-'),
  );
  await writeFile(
    join(computerFileRoot, 'hello.txt'),
    'hello\nworld\n',
    'utf8',
  );
  await readFile(computerFileRoot, 'hello.txt');

  const renameResult = await manageFilesTool.execute(
    {
      operation: 'rename',
      path: 'hello.txt',
      destination: 'renamed.txt',
    },
    { callId: 'call-manage-rename-apply-patch', computerFileRoot },
  );
  assert.equal(renameResult.ok, true);

  const result = await applyPatchTool.execute(
    { patch: updatePatch('hello.txt', 'world\n', 'updated\n') },
    { callId: 'call-apply-patch-rename', computerFileRoot },
  );

  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'not_found');
});

void test('apply_patch updates a file without requiring a final newline', async () => {
  const computerFileRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-apply-patch-'),
  );
  await writeFile(join(computerFileRoot, 'hello.txt'), 'old', 'utf8');

  const result = await applyPatchTool.execute(
    {
      patch: [
        '*** Begin Patch',
        '*** Update File: hello.txt',
        '@@',
        '-old',
        '+new',
        '*** End of File',
        '*** End Patch',
        '',
      ].join('\n'),
    },
    { callId: 'call-apply-patch-update-no-newline', computerFileRoot },
  );

  assert.equal(result.ok, true);
  assert.equal(
    await fsReadFile(join(computerFileRoot, 'hello.txt'), 'utf8'),
    'new',
  );
});

void test('apply_patch rejects old source paths after manage_files move', async () => {
  const computerFileRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-apply-patch-'),
  );
  await mkdir(join(computerFileRoot, 'src'), { recursive: true });
  await writeFile(
    join(computerFileRoot, 'src', 'hello.txt'),
    'hello\nworld\n',
    'utf8',
  );
  await readFile(computerFileRoot, 'src/hello.txt');

  const moveResult = await manageFilesTool.execute(
    {
      operation: 'move',
      path: 'src/hello.txt',
      destination: 'dst/hello.txt',
    },
    { callId: 'call-manage-move-apply-patch', computerFileRoot },
  );
  assert.equal(moveResult.ok, true);

  const result = await applyPatchTool.execute(
    { patch: updatePatch('src/hello.txt', 'world\n', 'updated\n') },
    { callId: 'call-apply-patch-move', computerFileRoot },
  );

  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'not_found');
});

void test('apply_patch rejects deleted source paths after manage_files delete', async () => {
  const computerFileRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-apply-patch-'),
  );
  await writeFile(
    join(computerFileRoot, 'hello.txt'),
    'hello\nworld\n',
    'utf8',
  );
  await readFile(computerFileRoot, 'hello.txt');

  const deleteResult = await manageFilesTool.execute(
    { operation: 'delete', path: 'hello.txt' },
    { callId: 'call-manage-delete-apply-patch', computerFileRoot },
  );
  assert.equal(deleteResult.ok, true);

  const result = await applyPatchTool.execute(
    { patch: updatePatch('hello.txt', 'world\n', 'updated\n') },
    { callId: 'call-apply-patch-deleted', computerFileRoot },
  );

  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'not_found');
});

function updatePatch(path: string, oldText: string, newText: string): string {
  const oldLines = oldText.endsWith('\n')
    ? oldText.slice(0, -1).split('\n')
    : oldText.split('\n');
  const newLines = newText.endsWith('\n')
    ? newText.slice(0, -1).split('\n')
    : newText.split('\n');
  return [
    '*** Begin Patch',
    `*** Update File: ${path}`,
    '@@',
    ...oldLines.map((line) => `-${line}`),
    ...newLines.map((line) => `+${line}`),
    '*** End Patch',
    '',
  ].join('\n');
}

function addPatch(path: string, content: string): string {
  const lines = content.endsWith('\n')
    ? content.slice(0, -1).split('\n')
    : content.split('\n');
  return [
    '*** Begin Patch',
    `*** Add File: ${path}`,
    ...lines.map((line) => `+${line}`),
    ...(content.endsWith('\n') ? [] : ['*** End of File']),
    '*** End Patch',
    '',
  ].join('\n');
}
