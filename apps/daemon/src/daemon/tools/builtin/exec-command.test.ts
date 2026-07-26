import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after } from 'node:test';
import { testRunId } from '../../../test-support/run-id.js';
import { testThreadId } from '../../../test-support/thread-id.js';
import { createDaemonContext } from '../../context.js';
import type { AgentEvent } from '../../runtime-contracts.js';
import { isToolObjectParameters, type ToolExecutionContext } from '../types.js';
import { execCommandTool } from './exec-command.js';
import { writeStdinTool } from './write-stdin.js';

const standaloneDaemonContext = createDaemonContext({
  hostCommands: { inlineMaxBytes: 512 * 1024 },
});
let standaloneContextId = 1_100;

after(async () => {
  await standaloneDaemonContext.hostCommands.closeAll();
});

void test('exec_command exposes a real command schema and destructive approval metadata', () => {
  assert.equal(execCommandTool.name, 'exec_command');
  assert.equal(execCommandTool.sideEffectLevel, 'destructive');
  assert.equal(execCommandTool.requiresApproval, true);
  assert.equal(execCommandTool.mayMutateComputerFiles, true);
  assert.ok(isToolObjectParameters(execCommandTool.parameters));
  assert.deepEqual(execCommandTool.parameters.required, ['cmd']);
  assert.deepEqual(Object.keys(execCommandTool.parameters.properties), [
    'cmd',
    'cwd',
    'timeoutMs',
    'yieldTimeMs',
    'stdinMode',
    'maxOutputBytesPerStream',
  ]);
  assert.match(execCommandTool.description, /real approved shell command/u);
  assert.match(execCommandTool.description, /not a file-tool alias/u);
  assert.match(execCommandTool.description, /one cohesive shell pipeline/u);
  assert.match(execCommandTool.description, /same-round independent reads/u);
  assert.doesNotMatch(execCommandTool.description, /virtual/u);
  assert.match(
    execCommandTool.catalogSearchMetadata?.whenToUse ?? '',
    /more effective than splitting dependent work across tool rounds/u,
  );
  assert.match(
    execCommandTool.catalogSearchMetadata?.notFor ?? '',
    /Routine file listing, reading, searching, or editing/u,
  );
});

void test('exec_command requires an explicit yield window before opening stdin', async () => {
  const computerFileRoot = await mkdtemp(join(tmpdir(), 'geulbat-exec-'));
  const result = await execCommandTool.execute(
    { cmd: 'node', stdinMode: 'open' },
    createStandaloneContext(computerFileRoot),
  );

  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'invalid_args');
  assert.match(result.error ?? '', /requires yieldTimeMs/u);
});

void test('exec_command fails closed when the daemon host runtime is absent', async () => {
  const computerFileRoot = await mkdtemp(join(tmpdir(), 'geulbat-exec-'));
  const result = await execCommandTool.execute(
    { cmd: 'node -e "process.stdout.write(\'must-not-run\')"' },
    {
      callId: 'call-exec-command-unrouted-test',
      computerFileRoot,
      workingDirectory: '',
    },
  );

  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'execution_failed');
  assert.match(result.error ?? '', /requires the daemon host command runtime/u);
});

void test('exec_command yields a thread-bound durable result that write_stdin pages exactly', async (t) => {
  const stateRoot = await mkdtemp(join(tmpdir(), 'geulbat-exec-runtime-'));
  const expected = '🙂exact-background-output-한글';
  // host command core는 컨텍스트 config로 구성한다 (인스턴스 주입 금지).
  const daemonContext = createDaemonContext({
    hostCommands: { inlineMaxBytes: 24 },
  });
  const hostCommands = daemonContext.hostCommands;
  const threadId = testThreadId(1_006);
  t.after(async () => {
    await hostCommands.closeAll();
    await rm(stateRoot, { recursive: true, force: true });
  });

  const started = await execCommandTool.execute(
    {
      cmd: `node -e "setTimeout(() => process.stdout.write('${expected}'), 40)"`,
      yieldTimeMs: 0,
    },
    {
      callId: 'call-exec-command-runtime-test',
      computerFileRoot: stateRoot,
      runId: testRunId(1_006),
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
    outputRef: string;
    revision: number;
    status: string;
  };
  assert.equal(initial.status, 'running');
  assert.match(initial.outputRef, /^command-output:/u);

  const firstPage = await writeStdinTool.execute(
    {
      outputRef: initial.outputRef,
      afterRevision: initial.revision,
      yieldTimeMs: 2_000,
      stream: 'stdout',
      offsetBytes: 0,
      limitBytes: 12,
    },
    {
      callId: 'call-write-stdin-runtime-test',
      stateRoot,
      threadId,
      runtimeServices: daemonContext,
    },
  );
  assert.equal(firstPage.ok, true);
  if (!firstPage.ok) {
    return;
  }

  let observed = JSON.parse(firstPage.output) as {
    page: {
      content: string;
      nextOffsetBytes: number | null;
    };
  };
  let recovered = observed.page.content;
  while (observed.page.nextOffsetBytes !== null) {
    const nextPage = await writeStdinTool.execute(
      {
        outputRef: initial.outputRef,
        yieldTimeMs: 0,
        stream: 'stdout',
        offsetBytes: observed.page.nextOffsetBytes,
        limitBytes: 12,
      },
      {
        callId: 'call-write-stdin-runtime-test',
        stateRoot,
        threadId,
        runtimeServices: daemonContext,
      },
    );
    assert.equal(nextPage.ok, true);
    if (!nextPage.ok) {
      return;
    }
    observed = JSON.parse(nextPage.output) as typeof observed;
    recovered += observed.page.content;
  }
  assert.equal(recovered, expected);
});

void test('exec_command runs without caller-imposed timeout or output stop policy', async () => {
  const computerFileRoot = await mkdtemp(join(tmpdir(), 'geulbat-exec-'));
  const result = await execCommandTool.execute(
    { cmd: 'node -e "process.stdout.write(\'ok\')"' },
    createStandaloneContext(computerFileRoot),
  );

  assert.equal(result.ok, true);
  const output = JSON.parse(result.output) as {
    status: string;
    stdout: string;
    timeoutMs: number | null;
    maxOutputBytesPerStream: number | null;
    outputLimitExceeded: unknown;
  };
  assert.equal(output.status, 'exit');
  assert.equal(output.stdout, 'ok');
  assert.equal(output.timeoutMs, null);
  assert.equal(output.maxOutputBytesPerStream, null);
  assert.equal(output.outputLimitExceeded, null);
});

void test('exec_command emits accepted stdout before returning its final result', async () => {
  const computerFileRoot = await mkdtemp(join(tmpdir(), 'geulbat-exec-'));
  let resolveFirstOutput:
    | ((event: Extract<AgentEvent, { type: 'tool_output_delta' }>) => void)
    | undefined;
  const firstOutput = new Promise<
    Extract<AgentEvent, { type: 'tool_output_delta' }>
  >((resolve) => {
    resolveFirstOutput = resolve;
  });
  const resultPromise = execCommandTool.execute(
    {
      cmd: "node -e \"process.stdout.write('ready'); setTimeout(() => process.stdout.write('-done'), 100)\"",
      timeoutMs: 1000,
    },
    {
      ...createStandaloneContext(computerFileRoot),
      emitAgentEvent(event) {
        if (event.type === 'tool_output_delta') {
          resolveFirstOutput?.(event);
          resolveFirstOutput = undefined;
        }
      },
    },
  );

  const first = await Promise.race([
    firstOutput,
    resultPromise.then(() => {
      throw new Error(
        'exec_command returned before streaming its first output',
      );
    }),
  ]);
  assert.deepEqual(first.payload, {
    callId: 'call-exec-command-test',
    tool: 'exec_command',
    stream: 'stdout',
    text: 'ready',
  });

  const result = await resultPromise;
  assert.equal(result.ok, true);
  const output = JSON.parse(result.output) as {
    stdout: string;
    durationMs: number;
    firstOutputAfterMs: number | null;
  };
  assert.equal(output.stdout, 'ready-done');
  assert.ok(output.firstOutputAfterMs !== null);
  assert.ok(output.firstOutputAfterMs >= 0);
  assert.ok(output.firstOutputAfterMs <= output.durationMs);
});

void test('exec_command does not impose a hidden output stop when the caller omits one', async () => {
  const computerFileRoot = await mkdtemp(join(tmpdir(), 'geulbat-exec-'));
  const expectedChars = 256 * 1024;
  const result = await execCommandTool.execute(
    {
      cmd: `node -e "process.stdout.write('x'.repeat(${String(expectedChars)}))"`,
    },
    createStandaloneContext(computerFileRoot),
  );

  assert.equal(result.ok, true);
  const output = JSON.parse(result.output) as {
    status: string;
    stdout: string;
    maxOutputBytesPerStream: number | null;
    outputLimitExceeded: unknown;
  };
  assert.equal(output.status, 'exit');
  assert.equal(output.stdout.length, expectedChars);
  assert.equal(output.maxOutputBytesPerStream, null);
  assert.equal(output.outputLimitExceeded, null);
});

void test('exec_command runs a real shell command in the requested cwd', async () => {
  const computerFileRoot = await mkdtemp(join(tmpdir(), 'geulbat-exec-'));
  const currentDir = join(computerFileRoot, 'repo');
  const childDir = join(computerFileRoot, 'downloads');
  await mkdir(currentDir);
  await mkdir(childDir);

  const result = await execCommandTool.execute(
    {
      cmd: 'node -e "process.stdout.write(process.cwd())"',
      cwd: '../downloads',
      timeoutMs: 1000,
      maxOutputBytesPerStream: 8192,
    },
    createStandaloneContext(computerFileRoot, 'repo'),
  );

  assert.equal(result.ok, true);
  const output = JSON.parse(result.output) as {
    cwd: string;
    status: string;
    exitCode: number | null;
    stdout: string;
    stderr: string;
    outputLimitExceeded: unknown;
  };
  assert.equal(output.status, 'exit');
  assert.equal(output.exitCode, 0);
  assert.equal(await realpath(output.cwd), await realpath(childDir));
  assert.equal(await realpath(output.stdout), await realpath(childDir));
  assert.equal(output.stderr, '');
  assert.equal(output.outputLimitExceeded, null);
});

void test('exec_command can start in another absolute Computer directory without changing run cwd', async () => {
  const runDirectory = await mkdtemp(join(tmpdir(), 'geulbat-exec-run-'));
  const selectedDirectory = await mkdtemp(
    join(tmpdir(), 'geulbat-exec-selected-'),
  );

  const result = await execCommandTool.execute(
    {
      cmd: 'node -e "process.stdout.write(process.cwd())"',
      cwd: selectedDirectory,
      timeoutMs: 1000,
      maxOutputBytesPerStream: 8192,
    },
    createStandaloneContext('/', runDirectory.slice(1)),
  );

  assert.equal(result.ok, true);
  const output = JSON.parse(result.output) as { cwd: string; stdout: string };
  assert.equal(await realpath(output.cwd), await realpath(selectedDirectory));
  assert.equal(
    await realpath(output.stdout),
    await realpath(selectedDirectory),
  );
});

void test('exec_command starts in an absolute cwd anywhere on the host filesystem', async () => {
  const computerFileRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-exec-computer-'),
  );
  const outsideRoot = await mkdtemp(join(tmpdir(), 'geulbat-exec-outside-'));

  const result = await execCommandTool.execute(
    {
      cmd: 'node -e "process.stdout.write(process.cwd())"',
      cwd: outsideRoot,
      timeoutMs: 1000,
      maxOutputBytesPerStream: 8192,
    },
    createStandaloneContext(computerFileRoot),
  );

  assert.equal(result.ok, true);
  const output = JSON.parse(result.output) as { cwd: string; stdout: string };
  assert.equal(await realpath(output.cwd), await realpath(outsideRoot));
  assert.equal(await realpath(output.stdout), await realpath(outsideRoot));
});

void test('exec_command reports non-zero exit as command status instead of tool failure', async () => {
  const computerFileRoot = await mkdtemp(join(tmpdir(), 'geulbat-exec-'));
  const result = await execCommandTool.execute(
    {
      cmd: 'node -e "process.stderr.write(\'bad\'); process.exit(7)"',
      timeoutMs: 1000,
      maxOutputBytesPerStream: 8192,
    },
    createStandaloneContext(computerFileRoot),
  );

  assert.equal(result.ok, true);
  const output = JSON.parse(result.output) as {
    status: string;
    exitCode: number | null;
    stderr: string;
  };
  assert.equal(output.status, 'exit');
  assert.equal(output.exitCode, 7);
  assert.equal(output.stderr, 'bad');
});

void test('exec_command stops commands that exceed the caller-owned output cap', async () => {
  const computerFileRoot = await mkdtemp(join(tmpdir(), 'geulbat-exec-'));
  const result = await execCommandTool.execute(
    {
      cmd: 'node -e "process.stdout.write(\'x\'.repeat(2048)); setInterval(() => {}, 1000)"',
      timeoutMs: 1000,
      maxOutputBytesPerStream: 64,
    },
    createStandaloneContext(computerFileRoot),
  );

  assert.equal(result.ok, true);
  const output = JSON.parse(result.output) as {
    status: string;
    stdout: string;
    outputLimitExceeded: {
      stream: string;
      maxBufferedBytesPerStream: number;
    } | null;
  };
  assert.equal(output.status, 'output_limit_exceeded');
  assert.equal(output.stdout, '');
  assert.deepEqual(output.outputLimitExceeded, {
    stream: 'stdout',
    maxBufferedBytesPerStream: 64,
  });
});

function createStandaloneContext(
  computerFileRoot: string,
  workingDirectory = '',
): ToolExecutionContext {
  const contextId = standaloneContextId;
  standaloneContextId += 1;
  return {
    callId: 'call-exec-command-test',
    computerFileRoot,
    runId: testRunId(contextId),
    runtimeServices: standaloneDaemonContext,
    stateRoot:
      computerFileRoot === '/'
        ? join(computerFileRoot, workingDirectory)
        : computerFileRoot,
    threadId: testThreadId(contextId),
    workingDirectory,
  };
}
