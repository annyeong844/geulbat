import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtemp,
  mkdir,
  readFile as fsReadFile,
  rename,
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
import { createDaemonContext } from '../../context.js';
import {
  operationManifestToJsonValue,
  prepareOperationManifest,
  type OperationManifest,
} from '../../files/operation-manifest.js';
import { readFile } from '../../files/read-file.js';
import { normalizePath } from '../../files/normalize-path.js';
import {
  countTextLines,
  normalizeTextContent,
} from '../../files/text-content.js';
import { createVersionToken } from '../../files/version-token.js';
import { createFileStateCache } from '../../utils/file-state-cache.js';
import { createSymlinkOrSkip } from '../../../test-support/symlink-test.js';
import type { ToolExecutionContext } from '../types.js';
import { manageFilesTool } from './manage-files.js';
import { writeFileTool } from './write-file.js';

function buildWriteFileAgentContext(args: {
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
    computerSessionId: 'session-write-file-durable',
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

function buildWriteFileManifest(args: {
  runId: RunId;
  callId: string;
  targetPath: string;
  relativePath: string;
  content: string;
  expectedVersionToken?: string;
}): OperationManifest {
  const canonicalContent = normalizeTextContent(args.content);
  const isOverwrite = args.expectedVersionToken !== undefined;
  return prepareOperationManifest({
    operationId: args.callId,
    manifestRevision: '1',
    operationKind: isOverwrite ? 'overwrite' : 'create_file',
    authorityId: 'computer',
    actor: { kind: 'assistant', runId: args.runId },
    targets: [
      {
        role: isOverwrite ? 'single' : 'destination',
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

async function injectWriteFileInvocation(args: {
  runtimeServices: ReturnType<typeof createDaemonContext>;
  threadId: ThreadId;
  runId: RunId;
  callId: string;
  manifest: OperationManifest;
}): Promise<void> {
  const recorded =
    await args.runtimeServices.runCheckpoints.recordToolInvocation({
      threadId: args.threadId,
      runId: args.runId,
      invocation: {
        callId: args.callId,
        toolName: writeFileTool.name,
        recoveryStrategy: 'reconcile_then_replay',
        recoveryState: operationManifestToJsonValue(args.manifest),
      },
    });
  assert.equal(recorded.ok, true);
}

void test('write_file declares reconcile-then-replay recovery', () => {
  assert.equal(writeFileTool.recoveryStrategy, 'reconcile_then_replay');
});

void test('write_file checkpoints and reconciles an agent write before returning', async (t) => {
  const stateRoot = await mkdtemp(join(tmpdir(), 'geulbat-write-durable-'));
  t.after(async () => rm(stateRoot, { recursive: true, force: true }));
  const runtimeServices = createDaemonContext({ homeStateRoot: stateRoot });
  const threadId = assertThreadId('123e4567-e89b-42d3-a456-426614174032');
  const runId = assertRunId('run-write-file-durable');
  await runtimeServices.runCheckpoints.startRun({
    threadId,
    runId,
    request: { workingDirectory: stateRoot, permissionMode: 'full_access' },
  });
  const context = buildWriteFileAgentContext({
    stateRoot,
    threadId,
    runId,
    callId: 'call-write-file-durable',
    runtimeServices,
  });

  const result = await writeFileTool.execute(
    { path: 'durable.txt', content: 'durable\n' },
    context,
  );

  assert.equal(result.ok, true);
  assert.equal(
    await fsReadFile(join(stateRoot, 'durable.txt'), 'utf8'),
    'durable\n',
  );
  const invocation = (await runtimeServices.runCheckpoints.readThread(threadId))
    ?.toolInvocations[0];
  assert.equal(invocation?.status, 'reconciled');
  if (invocation?.status === 'reconciled') {
    assert.equal(invocation.callId, context.callId);
    assert.deepEqual(invocation.result, result);
  }

  const missingCheckpointPath = join(stateRoot, 'must-not-be-written.txt');
  const withoutCheckpoint = await writeFileTool.execute(
    { path: 'must-not-be-written.txt', content: 'no checkpoint\n' },
    {
      ...context,
      callId: 'call-write-file-without-checkpoint',
      runId: assertRunId('run-write-file-without-checkpoint'),
    },
  );
  assert.equal(withoutCheckpoint.ok, false);
  if (!withoutCheckpoint.ok) {
    assert.equal(withoutCheckpoint.errorCode, 'execution_failed');
    assert.match(withoutCheckpoint.error, /durable run checkpoint/);
  }
  await assert.rejects(() => stat(missingCheckpointPath));
});

void test('write_file restart recovery replays a create whose effect did not start', async (t) => {
  const stateRoot = await mkdtemp(join(tmpdir(), 'geulbat-write-recovery-'));
  t.after(async () => rm(stateRoot, { recursive: true, force: true }));
  const runtimeServices = createDaemonContext({ homeStateRoot: stateRoot });
  const threadId = assertThreadId('123e4567-e89b-42d3-a456-426614174033');
  const runId = assertRunId('run-write-file-create-recovery');
  const callId = 'call-write-file-create-recovery';
  const relativePath = 'restart-created.txt';
  const content = 'created after restart\n';
  await runtimeServices.runCheckpoints.startRun({
    threadId,
    runId,
    request: { workingDirectory: stateRoot, permissionMode: 'full_access' },
  });
  await injectWriteFileInvocation({
    runtimeServices,
    threadId,
    runId,
    callId,
    manifest: buildWriteFileManifest({
      runId,
      callId,
      targetPath: join(stateRoot, relativePath),
      relativePath,
      content,
    }),
  });

  const result = await writeFileTool.execute(
    { path: relativePath, content },
    buildWriteFileAgentContext({
      stateRoot,
      threadId,
      runId,
      callId,
      runtimeServices,
    }),
  );

  assert.equal(result.ok, true);
  assert.equal(
    await fsReadFile(join(stateRoot, relativePath), 'utf8'),
    content,
  );
  const invocation = (await runtimeServices.runCheckpoints.readThread(threadId))
    ?.toolInvocations[0];
  assert.equal(invocation?.status, 'reconciled');
  if (result.ok) {
    assert.deepEqual(JSON.parse(result.output), {
      root: 'computer',
      path: relativePath,
      ok: true,
      versionToken: createVersionToken(content),
      totalLines: countTextLines(content),
      mode: 'created',
    });
  }
});

void test('write_file restart recovery restores a create completed before result persistence', async (t) => {
  const stateRoot = await mkdtemp(join(tmpdir(), 'geulbat-write-recovery-'));
  t.after(async () => rm(stateRoot, { recursive: true, force: true }));
  const runtimeServices = createDaemonContext({ homeStateRoot: stateRoot });
  const threadId = assertThreadId('123e4567-e89b-42d3-a456-426614174036');
  const runId = assertRunId('run-write-file-create-completed-recovery');
  const callId = 'call-write-file-create-completed-recovery';
  const relativePath = 'restart-create-completed.txt';
  const targetPath = join(stateRoot, relativePath);
  const content = 'created before restart\n';
  await runtimeServices.runCheckpoints.startRun({
    threadId,
    runId,
    request: { workingDirectory: stateRoot, permissionMode: 'full_access' },
  });
  await injectWriteFileInvocation({
    runtimeServices,
    threadId,
    runId,
    callId,
    manifest: buildWriteFileManifest({
      runId,
      callId,
      targetPath,
      relativePath,
      content,
    }),
  });
  await writeFile(targetPath, content, 'utf8');

  const result = await writeFileTool.execute(
    { path: relativePath, content },
    buildWriteFileAgentContext({
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
    assert.equal(JSON.parse(result.output).mode, 'created');
  }
  const invocation = (await runtimeServices.runCheckpoints.readThread(threadId))
    ?.toolInvocations[0];
  assert.equal(invocation?.status, 'reconciled');
  if (invocation?.status === 'reconciled') {
    assert.deepEqual(invocation.result, result);
  }
});

void test('write_file restart recovery restores a completed overwrite without replaying it', async (t) => {
  const stateRoot = await mkdtemp(join(tmpdir(), 'geulbat-write-recovery-'));
  t.after(async () => rm(stateRoot, { recursive: true, force: true }));
  const runtimeServices = createDaemonContext({ homeStateRoot: stateRoot });
  const threadId = assertThreadId('123e4567-e89b-42d3-a456-426614174034');
  const runId = assertRunId('run-write-file-overwrite-recovery');
  const callId = 'call-write-file-overwrite-recovery';
  const relativePath = 'restart-overwritten.txt';
  const targetPath = join(stateRoot, relativePath);
  const content = 'completed before restart\r\nsecond line\r\n';
  const committedContent = normalizeTextContent(content);
  await writeFile(targetPath, 'original\n', 'utf8');
  const original = await readFile(stateRoot, relativePath);
  await runtimeServices.runCheckpoints.startRun({
    threadId,
    runId,
    request: { workingDirectory: stateRoot, permissionMode: 'full_access' },
  });
  await injectWriteFileInvocation({
    runtimeServices,
    threadId,
    runId,
    callId,
    manifest: buildWriteFileManifest({
      runId,
      callId,
      targetPath,
      relativePath,
      content,
      expectedVersionToken: original.versionToken,
    }),
  });
  await writeFile(targetPath, committedContent, 'utf8');

  const result = await writeFileTool.execute(
    {
      path: relativePath,
      content,
      versionToken: original.versionToken,
    },
    buildWriteFileAgentContext({
      stateRoot,
      threadId,
      runId,
      callId,
      runtimeServices,
    }),
  );

  assert.equal(result.ok, true);
  assert.equal(await fsReadFile(targetPath, 'utf8'), committedContent);
  if (result.ok) {
    assert.deepEqual(JSON.parse(result.output), {
      root: 'computer',
      path: relativePath,
      ok: true,
      versionToken: createVersionToken(committedContent),
      totalLines: countTextLines(committedContent),
      mode: 'overwritten',
    });
  }
  const invocation = (await runtimeServices.runCheckpoints.readThread(threadId))
    ?.toolInvocations[0];
  assert.equal(invocation?.status, 'reconciled');
});

void test('write_file restart recovery rejects a stale replacement without overwriting it', async (t) => {
  const stateRoot = await mkdtemp(join(tmpdir(), 'geulbat-write-recovery-'));
  t.after(async () => rm(stateRoot, { recursive: true, force: true }));
  const runtimeServices = createDaemonContext({ homeStateRoot: stateRoot });
  const threadId = assertThreadId('123e4567-e89b-42d3-a456-426614174035');
  const runId = assertRunId('run-write-file-stale-recovery');
  const callId = 'call-write-file-stale-recovery';
  const relativePath = 'restart-stale.txt';
  const targetPath = join(stateRoot, relativePath);
  const replacement = 'replacement from another writer\n';
  await writeFile(targetPath, 'original\n', 'utf8');
  const original = await readFile(stateRoot, relativePath);
  await runtimeServices.runCheckpoints.startRun({
    threadId,
    runId,
    request: { workingDirectory: stateRoot, permissionMode: 'full_access' },
  });
  await injectWriteFileInvocation({
    runtimeServices,
    threadId,
    runId,
    callId,
    manifest: buildWriteFileManifest({
      runId,
      callId,
      targetPath,
      relativePath,
      content: 'interrupted update\n',
      expectedVersionToken: original.versionToken,
    }),
  });
  await writeFile(targetPath, replacement, 'utf8');

  const result = await writeFileTool.execute(
    {
      path: relativePath,
      content: 'interrupted update\n',
      versionToken: original.versionToken,
    },
    buildWriteFileAgentContext({
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

void test('write_file rejects overwriting an existing file without a versionToken', async () => {
  const computerFileRoot = await mkdtemp(join(tmpdir(), 'geulbat-write-tool-'));
  await writeFile(join(computerFileRoot, 'hello.txt'), 'hello\n', 'utf8');

  const result = await writeFileTool.execute(
    { path: 'hello.txt', content: 'updated\n' },
    { callId: 'call-write-1', computerFileRoot },
  );

  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'invalid_args');
  assert.match(result.error ?? '', /versionToken is required/);
});

void test('write_file allows creating a new file without a versionToken', async () => {
  const computerFileRoot = await mkdtemp(join(tmpdir(), 'geulbat-write-tool-'));

  const result = await writeFileTool.execute(
    { path: 'new.txt', content: 'created\n' },
    { callId: 'call-write-2', computerFileRoot },
  );

  assert.equal(result.ok, true);
  const payload = JSON.parse(result.output) as { mode: string; path: string };
  assert.equal(payload.mode, 'created');
  assert.equal(payload.path, 'new.txt');
});

void test('write_file creates an absolute file outside the coordinate base', async () => {
  const computerFileRoot = await mkdtemp(join(tmpdir(), 'geulbat-write-base-'));
  const outsideRoot = await mkdtemp(join(tmpdir(), 'geulbat-write-outside-'));
  const absolutePath = join(outsideRoot, 'created.txt');

  const result = await writeFileTool.execute(
    { path: absolutePath, content: 'created outside\n' },
    { callId: 'call-write-outside-base', computerFileRoot },
  );

  assert.equal(result.ok, true);
  assert.equal(await fsReadFile(absolutePath, 'utf8'), 'created outside\n');
  assert.equal(
    JSON.parse(result.output).path,
    normalizePath(computerFileRoot, absolutePath),
  );
});

void test('write_file creates and overwrites files in ComputerFileScope', async () => {
  const computerFileRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-computer-write-tool-'),
  );
  const absolutePath = join(computerFileRoot, 'notes', 'hello.txt');

  const created = await writeFileTool.execute(
    {
      path: 'notes/hello.txt',
      content: 'hello\n',
    },
    {
      callId: 'call-computer-write-create',
      computerFileRoot,
    },
  );

  assert.equal(created.ok, true);
  assert.equal(await fsReadFile(absolutePath, 'utf8'), 'hello\n');
  assert.equal(JSON.parse(created.output).root, 'computer');

  const current = await readFile(computerFileRoot, 'notes/hello.txt');
  const overwritten = await writeFileTool.execute(
    {
      path: 'notes/hello.txt',
      content: 'updated\n',
      versionToken: current.versionToken,
    },
    {
      callId: 'call-computer-write-overwrite',
      computerFileRoot,
    },
  );

  assert.equal(overwritten.ok, true);
  assert.equal(await fsReadFile(absolutePath, 'utf8'), 'updated\n');
  assert.equal(JSON.parse(overwritten.output).root, 'computer');
});

void test('write_file preserves stale-write detection in the computer root', async () => {
  const computerFileRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-computer-write-tool-'),
  );
  const absolutePath = join(computerFileRoot, 'hello.txt');
  await writeFile(absolutePath, 'hello\n', 'utf8');
  const stale = await readFile(computerFileRoot, 'hello.txt');
  await writeFile(absolutePath, 'changed\n', 'utf8');

  const result = await writeFileTool.execute(
    {
      path: 'hello.txt',
      content: 'updated\n',
      versionToken: stale.versionToken,
    },
    {
      callId: 'call-computer-write-stale',
      computerFileRoot,
    },
  );

  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'conflict_stale_write');
  assert.equal(await fsReadFile(absolutePath, 'utf8'), 'changed\n');
});

void test('write_file updates a symlink target regardless of its filename', async (t) => {
  const computerFileRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-computer-write-tool-'),
  );
  const reservedFile = join(computerFileRoot, '.env');
  const linkedFile = join(computerFileRoot, 'settings.txt');
  await writeFile(reservedFile, 'SECRET=kept\n', 'utf8');
  if (!(await createSymlinkOrSkip(t, reservedFile, linkedFile))) {
    return;
  }
  const current = await readFile(computerFileRoot, 'settings.txt');

  const result = await writeFileTool.execute(
    {
      path: 'settings.txt',
      content: 'SECRET=changed\n',
      versionToken: current.versionToken,
    },
    {
      callId: 'call-computer-write-reserved-alias',
      computerFileRoot,
    },
  );

  assert.equal(result.ok, true);
  assert.equal(await fsReadFile(reservedFile, 'utf8'), 'SECRET=changed\n');
});

void test('write_file rejects blank versionToken at the parser boundary', async () => {
  const result = await writeFileTool.execute(
    {
      path: 'new.txt',
      content: 'created\n',
      versionToken: '   ',
    },
    { callId: 'call-write-blank-version-token', computerFileRoot: '/computer' },
  );

  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'invalid_args');
  assert.match(result.error ?? '', /versionToken must not be empty/);
});

void test('write_file rejects blank path at the parser boundary', async () => {
  const result = await writeFileTool.execute(
    { path: '   ', content: 'created\n' },
    { callId: 'call-write-blank-path', computerFileRoot: '/computer' },
  );

  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'invalid_args');
  assert.match(result.error ?? '', /path.*empty/);
});

void test('write_file rejects the removed legacy root selector', async () => {
  const result = await writeFileTool.execute(
    { root: 'computer', path: 'new.txt', content: 'created\n' },
    { callId: 'call-write-legacy-root', computerFileRoot: '/computer' },
  );

  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'invalid_args');
  assert.match(result.error ?? '', /root/u);
});

void test('write_file overwrites an existing file when a valid versionToken is provided', async () => {
  const computerFileRoot = await mkdtemp(join(tmpdir(), 'geulbat-write-tool-'));
  const absolutePath = join(computerFileRoot, 'hello.txt');
  await writeFile(absolutePath, 'hello\n', 'utf8');
  const file = await readFile(computerFileRoot, 'hello.txt');

  const result = await writeFileTool.execute(
    {
      path: 'hello.txt',
      content: 'updated\n',
      versionToken: file.versionToken,
    },
    { callId: 'call-write-3', computerFileRoot },
  );

  assert.equal(result.ok, true);
  assert.equal(await fsReadFile(absolutePath, 'utf8'), 'updated\n');
  const payload = JSON.parse(result.output) as { mode: string };
  assert.equal(payload.mode, 'overwritten');
});

void test('write_file invalidates injected file state cache after a successful overwrite', async () => {
  const computerFileRoot = await mkdtemp(join(tmpdir(), 'geulbat-write-tool-'));
  const absolutePath = join(computerFileRoot, 'hello.txt');
  await writeFile(absolutePath, 'hello\n', 'utf8');
  const fileStateCache = createFileStateCache();
  const file = await readFile(computerFileRoot, 'hello.txt', {
    fileStateCache,
  });

  assert.equal(fileStateCache.getStats().entryCount, 1);

  const result = await writeFileTool.execute(
    {
      path: 'hello.txt',
      content: 'updated\n',
      versionToken: file.versionToken,
    },
    { callId: 'call-write-cache-invalidate', computerFileRoot, fileStateCache },
  );

  assert.equal(result.ok, true);
  assert.equal(fileStateCache.getStats().entryCount, 0);
  assert.equal(await fsReadFile(absolutePath, 'utf8'), 'updated\n');
});

void test('write_file rejects stale versionToken overwrites', async () => {
  const computerFileRoot = await mkdtemp(join(tmpdir(), 'geulbat-write-tool-'));
  const absolutePath = join(computerFileRoot, 'hello.txt');
  await writeFile(absolutePath, 'hello\n', 'utf8');
  const stale = await readFile(computerFileRoot, 'hello.txt');
  await writeFile(absolutePath, 'changed\n', 'utf8');

  const result = await writeFileTool.execute(
    {
      path: 'hello.txt',
      content: 'updated\n',
      versionToken: stale.versionToken,
    },
    { callId: 'call-write-4', computerFileRoot },
  );

  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'conflict_stale_write');
});

void test('write_file rejects old source paths after rename when a versionToken is present', async () => {
  const computerFileRoot = await mkdtemp(join(tmpdir(), 'geulbat-write-tool-'));
  const absolutePath = join(computerFileRoot, 'hello.txt');
  await writeFile(absolutePath, 'hello\n', 'utf8');
  const file = await readFile(computerFileRoot, 'hello.txt');
  await rename(absolutePath, join(computerFileRoot, 'renamed.txt'));

  const result = await writeFileTool.execute(
    {
      path: 'hello.txt',
      content: 'updated\n',
      versionToken: file.versionToken,
    },
    { callId: 'call-write-5', computerFileRoot },
  );

  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'not_found');
});

void test('write_file rejects old source paths after move when a versionToken is present', async () => {
  const computerFileRoot = await mkdtemp(join(tmpdir(), 'geulbat-write-tool-'));
  await mkdir(join(computerFileRoot, 'src'), { recursive: true });
  await mkdir(join(computerFileRoot, 'dst'), { recursive: true });
  const absolutePath = join(computerFileRoot, 'src', 'hello.txt');
  await writeFile(absolutePath, 'hello\n', 'utf8');
  const file = await readFile(computerFileRoot, 'src/hello.txt');
  await rename(absolutePath, join(computerFileRoot, 'dst', 'hello.txt'));

  const result = await writeFileTool.execute(
    {
      path: 'src/hello.txt',
      content: 'updated\n',
      versionToken: file.versionToken,
    },
    { callId: 'call-write-6', computerFileRoot },
  );

  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'not_found');
});

void test('write_file rejects deleted source paths after manage_files delete when a versionToken is present', async () => {
  const computerFileRoot = await mkdtemp(join(tmpdir(), 'geulbat-write-tool-'));
  const absolutePath = join(computerFileRoot, 'hello.txt');
  await writeFile(absolutePath, 'hello\n', 'utf8');
  const file = await readFile(computerFileRoot, 'hello.txt');

  const deleteResult = await manageFilesTool.execute(
    { operation: 'delete', path: 'hello.txt' },
    { callId: 'call-manage-delete-write', computerFileRoot },
  );
  assert.equal(deleteResult.ok, true);

  const result = await writeFileTool.execute(
    {
      path: 'hello.txt',
      content: 'updated\n',
      versionToken: file.versionToken,
    },
    { callId: 'call-write-delete', computerFileRoot },
  );

  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'not_found');
});
