import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { removeCommandHostWorkspace } from '../test-support/command-host-workspace.js';
import { testRunId } from '../test-support/run-id.js';
import { testThreadId } from '../test-support/thread-id.js';
import { createDaemonContext } from './context.js';
import {
  ensureHostCommandFullOutputArchive,
  type HostCommandFullOutputArchiveResult,
} from './host-command-full-output-archive.js';
import {
  buildHostCommandPaths,
  readPersistedHostCommand,
} from './host-command-output-store.js';
import { execCommandTool } from './tools/builtin/exec-command.js';
import { writeStdinTool } from './tools/builtin/write-stdin.js';

void test('exec_command archives complete stdout and stderr beyond its tail ring', async (t) => {
  const stateRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-full-command-output-'),
  );
  const threadId = testThreadId(2_101);
  const runId = testRunId(2_101);
  const daemonContext = createDaemonContext({
    hostCommands: { inlineMaxBytes: 1024, tailRingBytes: 1024 },
  });
  t.after(async () => {
    await daemonContext.hostCommands.closeAll();
    await removeCommandHostWorkspace(stateRoot);
  });

  const expectedStdout = 'S'.repeat(8192);
  const expectedStderr = 'E'.repeat(4096);
  const started = await execCommandTool.execute(
    {
      cmd: `node -e "process.stdout.write('S'.repeat(8192)); process.stderr.write('E'.repeat(4096))"`,
      yieldTimeMs: 0,
    },
    {
      callId: 'call-full-command-output',
      computerFileRoot: stateRoot,
      runId,
      stateRoot,
      threadId,
      runtimeServices: daemonContext,
      workingDirectory: '',
    },
  );
  assert.equal(started.ok, true);
  if (!started.ok) {
    return;
  }
  const initial = JSON.parse(started.output) as {
    outputRef: string | null;
    status: string;
  };
  assert.equal(typeof initial.outputRef, 'string');
  if (initial.outputRef === null) {
    return;
  }

  const terminal = await waitForTerminal({
    daemonContext,
    outputRef: initial.outputRef,
    stateRoot,
    threadId,
  });
  assert.equal(terminal.status, 'exit');

  const paths = buildHostCommandPaths({
    stateRoot,
    threadId,
    outputRef: initial.outputRef,
  });
  assert.equal(await readFile(paths.stdoutFull, 'utf8'), expectedStdout);
  assert.equal(await readFile(paths.stderrFull, 'utf8'), expectedStderr);
  const persisted = await readPersistedHostCommand({
    stateRoot,
    threadId,
    outputRef: initial.outputRef,
  });
  assert.equal(persisted.ok, true);
  if (persisted.ok) {
    assert.equal(persisted.value.metadata.fullOutputAvailable, true);
    assert.equal(persisted.value.metadata.stdoutBaseOffset, 0);
    assert.equal(persisted.value.metadata.stderrBaseOffset, 0);
  }

  assert.equal(
    await readAllPages({
      daemonContext,
      outputRef: initial.outputRef,
      stateRoot,
      stream: 'stdout',
      threadId,
    }),
    expectedStdout,
  );
  assert.equal(
    await readAllPages({
      daemonContext,
      outputRef: initial.outputRef,
      stateRoot,
      stream: 'stderr',
      threadId,
    }),
    expectedStderr,
  );

  await daemonContext.hostCommands.closeAll();
  const replacementContext = createDaemonContext({
    hostCommands: { inlineMaxBytes: 1024, tailRingBytes: 1024 },
  });
  t.after(() => replacementContext.hostCommands.closeAll());
  const restartedPage = await replacementContext.hostCommands.interact({
    stateRoot,
    threadId,
    outputRef: initial.outputRef,
    yieldTimeMs: 0,
    page: {
      stream: 'stdout',
      offsetBytes: 0,
      limitBytes: 1024,
    },
  });
  assert.equal(restartedPage.ok, true);
  if (restartedPage.ok) {
    assert.equal(
      restartedPage.value.page?.content,
      expectedStdout.slice(0, 1024),
    );
    assert.equal(restartedPage.value.page?.offsetBytes, 0);
    assert.equal(restartedPage.value.page?.totalBytes, 8192);
  }
});

void test('an active archive resumes from the worker release offset after daemon-side interruption', async (t) => {
  const stateRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-full-command-resume-'),
  );
  const threadId = testThreadId(2_102);
  const runId = testRunId(2_102);
  const daemonContext = createDaemonContext({
    hostCommands: { inlineMaxBytes: 256, tailRingBytes: 256 },
  });
  t.after(async () => {
    await daemonContext.hostCommands.closeAll();
    await removeCommandHostWorkspace(stateRoot);
  });

  const expected = 'R'.repeat(4096);
  const started = await daemonContext.hostCommands.start({
    executable: process.execPath,
    args: [
      '-e',
      `setTimeout(() => process.stdout.write('R'.repeat(4096)), 20)`,
    ],
    cwd: stateRoot,
    env: process.env,
    stateRoot,
    threadId,
    runId,
    callId: 'call-full-command-resume',
    stdinMode: 'closed',
    streamMode: 'lossless',
    requiresDeferredOutputRelease: true,
  });
  assert.equal(started.ok, true);
  if (!started.ok) {
    return;
  }
  const claimed = await daemonContext.hostCommands.waitForInitialResult({
    stateRoot,
    outputRef: started.outputRef,
    yieldTimeMs: 0,
  });
  assert.equal(claimed.ok, true);
  if (!claimed.ok) {
    return;
  }

  let firstPage;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const observed = await daemonContext.hostCommands.interact({
      stateRoot,
      threadId,
      outputRef: started.outputRef,
      yieldTimeMs: 25,
      page: {
        stream: 'stdout',
        offsetBytes: 0,
        limitBytes: 256,
        deferRelease: true,
      },
    });
    assert.equal(observed.ok, true);
    if (observed.ok && observed.value.page?.endOffsetBytes) {
      firstPage = observed.value.page;
      break;
    }
  }
  assert.ok(firstPage);
  if (firstPage === undefined) {
    return;
  }

  const paths = buildHostCommandPaths({
    stateRoot,
    threadId,
    outputRef: started.outputRef,
  });
  await mkdir(paths.directory, { recursive: true });
  await writeFile(paths.stdoutFull, firstPage.content, { mode: 0o600 });
  await writeFile(paths.stderrFull, '', { mode: 0o600 });
  await writeFile(
    paths.fullOutputState,
    `${JSON.stringify({ schemaVersion: 1, status: 'active' })}\n`,
    { mode: 0o600 },
  );
  const released = await daemonContext.hostCommands.interact({
    stateRoot,
    threadId,
    outputRef: started.outputRef,
    yieldTimeMs: 0,
    page: {
      stream: 'stdout',
      offsetBytes: firstPage.endOffsetBytes,
      limitBytes: 256,
      deferRelease: true,
      releaseUpToBytes: firstPage.endOffsetBytes,
    },
  });
  assert.equal(released.ok, true);

  const archive = await ensureHostCommandFullOutputArchive({
    hostCommands: daemonContext.hostCommands,
    stateRoot,
    threadId,
    outputRef: started.outputRef,
    pageLimitBytes: 256,
    createIfMissing: false,
    activateRelease: true,
  });
  assert.ok(archive);
  const completed = await archive.completed;
  assert.deepEqual(completed, { ok: true });
  assert.equal(await readFile(paths.stdoutFull, 'utf8'), expected);
  assert.equal(await readFile(paths.stderrFull, 'utf8'), '');
});

void test('a replacement daemon runtime takes over an archive left active by a lost connection', async (t) => {
  const stateRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-full-command-takeover-'),
  );
  const threadId = testThreadId(2_103);
  const runId = testRunId(2_103);
  const daemonContext = createDaemonContext({
    hostCommands: { inlineMaxBytes: 256, tailRingBytes: 256 },
  });
  t.after(async () => {
    await daemonContext.hostCommands.closeAll();
    await removeCommandHostWorkspace(stateRoot);
  });

  const expected = 'T'.repeat(4096);
  const started = await daemonContext.hostCommands.start({
    executable: process.execPath,
    args: ['-e', `process.stdout.write('T'.repeat(4096))`],
    cwd: stateRoot,
    env: process.env,
    stateRoot,
    threadId,
    runId,
    callId: 'call-full-command-takeover',
    stdinMode: 'closed',
    streamMode: 'lossless',
    requiresDeferredOutputRelease: true,
  });
  assert.equal(started.ok, true);
  if (!started.ok) {
    return;
  }
  const claimed = await daemonContext.hostCommands.waitForInitialResult({
    stateRoot,
    outputRef: started.outputRef,
    yieldTimeMs: 0,
  });
  assert.equal(claimed.ok, true);
  if (!claimed.ok) {
    return;
  }

  const disconnectedRuntime = {
    ...daemonContext.hostCommands,
    async interact(): Promise<{
      ok: false;
      reasonCode: 'output_store_failed';
      message: string;
    }> {
      return {
        ok: false,
        reasonCode: 'output_store_failed',
        message: 'command-host connection was lost.',
      };
    },
  };
  const interrupted = await ensureHostCommandFullOutputArchive({
    hostCommands: disconnectedRuntime,
    stateRoot,
    threadId,
    outputRef: started.outputRef,
    pageLimitBytes: 256,
    createIfMissing: true,
  });
  assert.ok(interrupted);
  assert.deepEqual(await interrupted.completed, {
    ok: false,
    message: 'command-host connection was lost.',
  } satisfies HostCommandFullOutputArchiveResult);

  const paths = buildHostCommandPaths({
    stateRoot,
    threadId,
    outputRef: started.outputRef,
  });
  assert.deepEqual(JSON.parse(await readFile(paths.fullOutputState, 'utf8')), {
    schemaVersion: 1,
    status: 'active',
  });

  const replacement = await ensureHostCommandFullOutputArchive({
    hostCommands: daemonContext.hostCommands,
    stateRoot,
    threadId,
    outputRef: started.outputRef,
    pageLimitBytes: 256,
    createIfMissing: false,
    activateRelease: true,
  });
  assert.ok(replacement);
  assert.deepEqual(await replacement.completed, { ok: true });
  assert.equal(await readFile(paths.stdoutFull, 'utf8'), expected);
  assert.deepEqual(JSON.parse(await readFile(paths.fullOutputState, 'utf8')), {
    schemaVersion: 1,
    status: 'complete',
  });
});

async function waitForTerminal(args: {
  daemonContext: ReturnType<typeof createDaemonContext>;
  outputRef: string;
  stateRoot: string;
  threadId: ReturnType<typeof testThreadId>;
}): Promise<{ status: string }> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const observed = await writeStdinTool.execute(
      {
        outputRef: args.outputRef,
        yieldTimeMs: 50,
      },
      {
        callId: `call-full-command-poll-${attempt}`,
        stateRoot: args.stateRoot,
        threadId: args.threadId,
        runtimeServices: args.daemonContext,
      },
    );
    assert.equal(observed.ok, true);
    if (!observed.ok) {
      break;
    }
    const value = JSON.parse(observed.output) as {
      snapshot: { status: string };
    };
    if (value.snapshot.status !== 'running') {
      return value.snapshot;
    }
  }
  throw new Error('full-output command did not reach terminal state');
}

async function readAllPages(args: {
  daemonContext: ReturnType<typeof createDaemonContext>;
  outputRef: string;
  stateRoot: string;
  stream: 'stdout' | 'stderr';
  threadId: ReturnType<typeof testThreadId>;
}): Promise<string> {
  let content = '';
  let offsetBytes = 0;
  for (;;) {
    const observed = await writeStdinTool.execute(
      {
        outputRef: args.outputRef,
        stream: args.stream,
        offsetBytes,
        limitBytes: 1024,
        yieldTimeMs: 0,
      },
      {
        callId: `call-full-command-page-${args.stream}-${offsetBytes}`,
        stateRoot: args.stateRoot,
        threadId: args.threadId,
        runtimeServices: args.daemonContext,
      },
    );
    assert.equal(observed.ok, true);
    if (!observed.ok) {
      return content;
    }
    const value = JSON.parse(observed.output) as {
      page: {
        content: string;
        endOffsetBytes: number;
        nextOffsetBytes: number | null;
      } | null;
    };
    assert.ok(value.page);
    if (value.page === null) {
      return content;
    }
    content += value.page.content;
    if (value.page.nextOffsetBytes === null) {
      return content;
    }
    assert.ok(value.page.endOffsetBytes > offsetBytes);
    offsetBytes = value.page.nextOffsetBytes;
  }
}
