import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { isToolObjectParameters, type ToolExecutionContext } from '../types.js';
import { execCommandTool } from './exec-command.js';

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
    'maxOutputBytesPerStream',
  ]);
  assert.match(execCommandTool.description, /real approved shell command/u);
  assert.match(execCommandTool.description, /not a file-tool alias/u);
  assert.doesNotMatch(execCommandTool.description, /virtual/u);
  assert.match(
    execCommandTool.catalogSearchMetadata?.notFor ?? '',
    /Routine file listing, reading, searching, or editing/u,
  );
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
  return {
    callId: 'call-exec-command-test',
    computerFileRoot,
    workingDirectory,
  };
}
