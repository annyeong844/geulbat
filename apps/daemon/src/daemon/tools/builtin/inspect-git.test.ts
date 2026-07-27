import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after, type TestContext } from 'node:test';
import { testRunId } from '../../../test-support/run-id.js';
import { testThreadId } from '../../../test-support/thread-id.js';
import { createDaemonContext } from '../../context.js';
import { isToolObjectParameters, type ToolExecutionContext } from '../types.js';
import { buildInspectGitArguments, inspectGitTool } from './inspect-git.js';

const daemonContext = createDaemonContext({
  hostCommands: { inlineMaxBytes: 64 * 1024 },
});
let contextId = 1_900;

after(async () => {
  await daemonContext.hostCommands.closeAll();
});

void test('inspect_git exposes only fixed read operations without approval', () => {
  assert.equal(inspectGitTool.sideEffectLevel, 'read');
  assert.equal(inspectGitTool.mayMutateComputerFiles, false);
  assert.equal(inspectGitTool.requiresApproval, false);
  assert.equal(inspectGitTool.recoveryStrategy, 'replay_safe');
  assert.ok(isToolObjectParameters(inspectGitTool.parameters));
  assert.deepEqual(inspectGitTool.parameters.required, ['operation']);
  assert.deepEqual(
    buildInspectGitArguments({
      operation: 'diff',
      staged: true,
      paths: ['src/file.ts'],
    }),
    [
      '--no-optional-locks',
      '--literal-pathspecs',
      '-c',
      'color.ui=false',
      'diff',
      '--no-ext-diff',
      '--no-textconv',
      '--cached',
      '--',
      'src/file.ts',
    ],
  );
});

void test('inspect_git reports branch, tracked changes, and untracked files', async (t) => {
  const repositoryRoot = await createRepositoryFixture(t);
  await writeFile(join(repositoryRoot, 'tracked.txt'), 'changed\n', 'utf8');
  await writeFile(join(repositoryRoot, 'untracked.txt'), 'new\n', 'utf8');

  const result = await inspectGitTool.execute(
    { operation: 'status' },
    createToolContext(repositoryRoot),
  );

  assert.equal(result.ok, true);
  const output = JSON.parse(result.output) as {
    operation: string;
    exitCode: number | null;
    stdout: string;
  };
  assert.equal(output.operation, 'status');
  assert.equal(output.exitCode, 0);
  assert.match(output.stdout, /^## /mu);
  assert.match(output.stdout, / M tracked\.txt$/mu);
  assert.match(output.stdout, /\?\? untracked\.txt$/mu);
});

void test('inspect_git returns exact staged diff and caller-bounded history', async (t) => {
  const repositoryRoot = await createRepositoryFixture(t);
  await writeFile(join(repositoryRoot, 'tracked.txt'), 'second\n', 'utf8');
  runGit(repositoryRoot, ['add', 'tracked.txt']);
  runGit(repositoryRoot, ['commit', '--quiet', '-m', 'second commit']);
  await writeFile(join(repositoryRoot, 'tracked.txt'), 'staged\n', 'utf8');
  runGit(repositoryRoot, ['add', 'tracked.txt']);

  const diff = await inspectGitTool.execute(
    { operation: 'diff', staged: true, paths: ['tracked.txt'] },
    createToolContext(repositoryRoot),
  );
  assert.equal(diff.ok, true);
  assert.match(
    (JSON.parse(diff.output) as { stdout: string }).stdout,
    /^\+staged$/mu,
  );

  const log = await inspectGitTool.execute(
    { operation: 'log', maxEntries: 1 },
    createToolContext(repositoryRoot),
  );
  assert.equal(log.ok, true);
  const logLines = (JSON.parse(log.output) as { stdout: string }).stdout
    .trim()
    .split('\n');
  assert.equal(logLines.length, 1);
  assert.match(logLines[0] ?? '', /\tsecond commit$/u);
});

void test('inspect_git preserves Git diagnostics outside a repository', async (t) => {
  const computerFileRoot = await mkdtemp(join(tmpdir(), 'geulbat-git-none-'));
  t.after(async () => {
    await rm(computerFileRoot, { recursive: true, force: true });
  });

  const result = await inspectGitTool.execute(
    { operation: 'status' },
    createToolContext(computerFileRoot),
  );

  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'execution_failed');
  assert.equal(result.diagnostics?.phase, 'command_wait');
  assert.match(result.diagnostics?.reasonCode ?? '', /^git_exit_/u);
  const output = JSON.parse(result.output) as { stderr: string };
  assert.match(output.stderr, /not a git repository/u);
});

async function createRepositoryFixture(t: TestContext): Promise<string> {
  const repositoryRoot = await mkdtemp(join(tmpdir(), 'geulbat-git-inspect-'));
  t.after(async () => {
    await rm(repositoryRoot, { recursive: true, force: true });
  });
  runGit(repositoryRoot, ['init', '--quiet']);
  runGit(repositoryRoot, ['config', 'user.email', 'fixture@example.com']);
  runGit(repositoryRoot, ['config', 'user.name', 'Fixture']);
  await writeFile(join(repositoryRoot, 'tracked.txt'), 'initial\n', 'utf8');
  runGit(repositoryRoot, ['add', 'tracked.txt']);
  runGit(repositoryRoot, ['commit', '--quiet', '-m', 'initial commit']);
  return repositoryRoot;
}

function runGit(cwd: string, args: string[]): void {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
  });
  assert.equal(
    result.status,
    0,
    `git ${args.join(' ')} failed: ${result.stderr}`,
  );
}

function createToolContext(computerFileRoot: string): ToolExecutionContext {
  const id = contextId;
  contextId += 1;
  return {
    callId: `call-inspect-git-${id}`,
    computerFileRoot,
    runId: testRunId(id),
    runtimeServices: daemonContext,
    stateRoot: computerFileRoot,
    threadId: testThreadId(id),
    workingDirectory: '',
  };
}
