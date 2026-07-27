import assert from 'node:assert/strict';
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { createCommandSessionHost } from '../../../command-host/session-core.js';
import type { HostCommandRuntime } from '../../../command-host/contract.js';
import { removeCommandHostWorkspace } from '../../../test-support/command-host-workspace.js';
import { testRunId } from '../../../test-support/run-id.js';
import { testThreadId } from '../../../test-support/thread-id.js';
import { createDaemonContext } from '../../context.js';
import {
  deleteExecCommandPersistentShellState,
  resolveExecCommandPersistentShellStateDirectory,
} from '../../exec-command-shell-state.js';
import type { ToolExecutionContext } from '../types.js';
import { execCommandTool } from './exec-command.js';

interface PersistentShellFixture {
  context(callId: string): ToolExecutionContext;
  hostCommands: HostCommandRuntime;
  stateRoot: string;
  threadId: string;
}

void test('exec_command persistent shell carries cwd, exports, aliases, and functions within one thread', async (t) => {
  const fixture = await createPersistentShellFixture(t, 1_121);
  const childDirectory = join(fixture.stateRoot, 'child');
  await mkdir(childDirectory);

  const changed = await execCommandTool.execute(
    {
      cmd: [
        'cd child',
        "export GEULBAT_PERSISTED_VALUE='kept'",
        "alias geulbat_alias='printf alias-ok'",
        'geulbat_function() { printf function-ok; }',
      ].join('; '),
      shellMode: 'persistent',
    },
    fixture.context('call-persistent-shell-change'),
  );
  assert.equal(changed.ok, true, changed.ok ? undefined : changed.error);

  const observed = await execCommandTool.execute(
    {
      cmd: [
        `printf '%s|%s|' "$PWD" "$GEULBAT_PERSISTED_VALUE"`,
        'geulbat_alias',
        "printf '|'",
        'geulbat_function',
      ].join('; '),
      shellMode: 'persistent',
    },
    fixture.context('call-persistent-shell-observe'),
  );
  assert.equal(observed.ok, true, observed.ok ? undefined : observed.error);
  if (!observed.ok) {
    return;
  }
  const output = JSON.parse(observed.output) as {
    shellMode: string;
    status: string;
    stdout: string;
  };
  assert.equal(output.shellMode, 'persistent');
  assert.equal(output.status, 'exit');
  assert.equal(output.stdout, `${childDirectory}|kept|alias-ok|function-ok`);
});

void test('persistent shell serialization restores state only after the prior command releases the thread lock', async (t) => {
  const fixture = await createPersistentShellFixture(t, 1_122);
  const first = await execCommandTool.execute(
    {
      cmd: [
        'export GEULBAT_SERIAL_VALUE=started',
        'sleep 0.15',
        'export GEULBAT_SERIAL_VALUE=finished',
      ].join('; '),
      shellMode: 'persistent',
      yieldTimeMs: 0,
    },
    fixture.context('call-persistent-shell-first'),
  );
  assert.equal(first.ok, true, first.ok ? undefined : first.error);
  if (!first.ok) {
    return;
  }
  const firstOutput = JSON.parse(first.output) as { status: string };
  assert.equal(firstOutput.status, 'running');

  const second = await execCommandTool.execute(
    {
      cmd: `printf '%s' "$GEULBAT_SERIAL_VALUE"`,
      shellMode: 'persistent',
    },
    fixture.context('call-persistent-shell-second'),
  );
  assert.equal(second.ok, true, second.ok ? undefined : second.error);
  if (!second.ok) {
    return;
  }
  const secondOutput = JSON.parse(second.output) as {
    status: string;
    stdout: string;
  };
  assert.equal(secondOutput.status, 'exit');
  assert.equal(secondOutput.stdout, 'finished');
});

void test('an explicit cwd resets the persistent cwd for that command and later commands', async (t) => {
  const fixture = await createPersistentShellFixture(t, 1_126);
  const childDirectory = join(fixture.stateRoot, 'child');
  await mkdir(childDirectory);
  const changed = await execCommandTool.execute(
    {
      cmd: 'cd child',
      shellMode: 'persistent',
    },
    fixture.context('call-persistent-shell-cwd-change'),
  );
  assert.equal(changed.ok, true, changed.ok ? undefined : changed.error);

  const reset = await execCommandTool.execute(
    {
      cmd: 'pwd',
      cwd: fixture.stateRoot,
      shellMode: 'persistent',
    },
    fixture.context('call-persistent-shell-cwd-reset'),
  );
  assert.equal(reset.ok, true, reset.ok ? undefined : reset.error);
  if (!reset.ok) {
    return;
  }
  const resetOutput = JSON.parse(reset.output) as { stdout: string };
  assert.equal(resetOutput.stdout.trim(), fixture.stateRoot);

  const observed = await execCommandTool.execute(
    {
      cmd: 'pwd',
      shellMode: 'persistent',
    },
    fixture.context('call-persistent-shell-cwd-after-reset'),
  );
  assert.equal(observed.ok, true, observed.ok ? undefined : observed.error);
  if (!observed.ok) {
    return;
  }
  const observedOutput = JSON.parse(observed.output) as { stdout: string };
  assert.equal(observedOutput.stdout.trim(), fixture.stateRoot);
});

void test('persistent shell does not copy unchanged daemon environment values into its state file', async (t) => {
  const fixture = await createPersistentShellFixture(t, 1_123);
  const environmentName = 'GEULBAT_TEST_BASELINE_SECRET';
  const secretValue = 'must-not-be-copied-to-shell-state';
  const previous = process.env[environmentName];
  process.env[environmentName] = secretValue;
  t.after(() => {
    if (previous === undefined) {
      delete process.env[environmentName];
    } else {
      process.env[environmentName] = previous;
    }
  });

  const result = await execCommandTool.execute(
    { cmd: 'true', shellMode: 'persistent' },
    fixture.context('call-persistent-shell-baseline'),
  );
  assert.equal(result.ok, true, result.ok ? undefined : result.error);

  const stateFile = await readOnlyPersistentShellStateFile(
    fixture.stateRoot,
    fixture.threadId,
  );
  const state = await readFile(stateFile, 'utf8');
  assert.equal(state.includes(environmentName), false);
  assert.equal(state.includes(secretValue), false);
});

void test('corrupt persistent shell state fails closed before the requested command runs', async (t) => {
  const fixture = await createPersistentShellFixture(t, 1_124);
  const initialized = await execCommandTool.execute(
    { cmd: 'true', shellMode: 'persistent' },
    fixture.context('call-persistent-shell-initialize'),
  );
  assert.equal(
    initialized.ok,
    true,
    initialized.ok ? undefined : initialized.error,
  );
  const stateFile = await readOnlyPersistentShellStateFile(
    fixture.stateRoot,
    fixture.threadId,
  );
  await writeFile(stateFile, '{"schemaVersion":999}\n', 'utf8');
  const markerPath = join(fixture.stateRoot, 'must-not-run');

  const result = await execCommandTool.execute(
    {
      cmd: `touch '${markerPath}'`,
      shellMode: 'persistent',
    },
    fixture.context('call-persistent-shell-corrupt'),
  );
  assert.equal(result.ok, true, result.ok ? undefined : result.error);
  if (!result.ok) {
    return;
  }
  const output = JSON.parse(result.output) as {
    exitCode: number | null;
    stderr: string;
  };
  assert.equal(output.exitCode, 125);
  assert.match(output.stderr, /state restore failed; command was not started/u);
  await assert.rejects(readFile(markerPath), /ENOENT/u);
});

void test('a persistent command finishing after thread-state deletion cannot recreate the deleted state', async (t) => {
  const fixture = await createPersistentShellFixture(t, 1_125);
  const started = await execCommandTool.execute(
    {
      cmd: 'sleep 0.15; export GEULBAT_MUST_NOT_RESURRECT=value',
      shellMode: 'persistent',
      yieldTimeMs: 0,
    },
    fixture.context('call-persistent-shell-delete-race'),
  );
  assert.equal(started.ok, true, started.ok ? undefined : started.error);
  if (!started.ok) {
    return;
  }
  const initial = JSON.parse(started.output) as {
    outputRef: string;
    status: string;
  };
  assert.equal(initial.status, 'running');
  assert.equal(
    await deleteExecCommandPersistentShellState({
      stateRoot: fixture.stateRoot,
      threadId: fixture.threadId,
    }),
    true,
  );

  let status = 'running';
  for (let attempt = 0; attempt < 10 && status === 'running'; attempt += 1) {
    const observed = await fixture.hostCommands.interact({
      stateRoot: fixture.stateRoot,
      threadId: fixture.threadId,
      outputRef: initial.outputRef,
      yieldTimeMs: 250,
    });
    assert.equal(observed.ok, true);
    if (!observed.ok) {
      return;
    }
    status = observed.value.snapshot.status;
  }
  assert.equal(status, 'exit');
  const stateDirectory = resolveExecCommandPersistentShellStateDirectory({
    stateRoot: fixture.stateRoot,
    threadId: fixture.threadId,
  });
  await assert.rejects(stat(stateDirectory), /ENOENT/u);
});

async function createPersistentShellFixture(
  t: TestContext,
  contextId: number,
): Promise<PersistentShellFixture> {
  const stateRoot = await mkdtemp(join(tmpdir(), 'geulbat-persistent-shell-'));
  const daemonContext = createDaemonContext();
  const hostCommands = createCommandSessionHost({
    inlineMaxBytes: 512 * 1024,
    tailRingBytes: 1024 * 1024,
  });
  const runtimeServices = { ...daemonContext, hostCommands };
  const threadId = testThreadId(contextId);
  const runId = testRunId(contextId);
  t.after(async () => {
    await hostCommands.closeAll();
    await daemonContext.hostCommands.closeAll();
    await removeCommandHostWorkspace(stateRoot);
    await rm(stateRoot, { recursive: true, force: true });
  });
  return {
    hostCommands,
    stateRoot,
    threadId,
    context(callId) {
      return {
        callId,
        computerFileRoot: stateRoot,
        runId,
        runtimeServices,
        stateRoot,
        threadId,
        workingDirectory: '',
      };
    },
  };
}

async function readOnlyPersistentShellStateFile(
  stateRoot: string,
  threadId: string,
): Promise<string> {
  const directory = resolveExecCommandPersistentShellStateDirectory({
    stateRoot,
    threadId,
  });
  const names = (await readdir(directory)).filter((name) =>
    name.endsWith('.json'),
  );
  assert.equal(names.length, 1);
  const name = names[0];
  assert.ok(name !== undefined);
  return join(directory, name);
}
