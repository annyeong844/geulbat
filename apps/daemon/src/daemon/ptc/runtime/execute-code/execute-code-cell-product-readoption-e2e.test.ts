import assert from 'node:assert/strict';
import { fork, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import { createDaemonHostCommandRuntime } from '../../../../command-host/runtime-selection.js';
import { removeCommandHostWorkspace } from '../../../../test-support/command-host-workspace.js';
import { testThreadId } from '../../../../test-support/thread-id.js';
import {
  createHostRoutedDetachedProcessAttacher,
  createHostRoutedDetachedProcessStarter,
} from '../../../host-routed-detached-process.js';
import { createPtcExecuteCodeCellTerminalResultStore } from '../../../ptc-execute-code-terminal-result-store.js';
import { createDaemonRuntimeStateStore } from '../../../runtime-state-store.js';
import type {
  PtcSessionDockerHandle,
  PtcSessionDockerManager,
} from '../../lab/session/session-docker-contract.js';
import {
  PTC_EXECUTE_CODE_CELL_EXEC_MIN_YIELD_MS,
  type PtcExecuteCodeCellCoordinate,
  type PtcExecuteCodeCellCoordinateStore,
  type PtcExecuteCodeRuntimeCellWaitSummary,
} from './execute-code-runtime-contract.js';
import { createPtcExecuteCodeRuntime } from './execute-code-runtime.js';

const DAEMON_FIXTURE_ARGUMENT = '--geulbat-ptc-cell-readoption-daemon';
const FIXTURE_STATE_ROOT_ENV = 'GEULBAT_TEST_PTC_CELL_READOPTION_STATE_ROOT';
const FIXTURE_EXECUTABLE_ENV = 'GEULBAT_TEST_PTC_CELL_READOPTION_EXECUTABLE';
const FIXTURE_PHASE_ENV = 'GEULBAT_TEST_PTC_CELL_READOPTION_PHASE';
const FIXTURE_CELL_ID_ENV = 'GEULBAT_TEST_PTC_CELL_READOPTION_CELL_ID';
const FIXTURE_READY_MESSAGE = 'geulbat-ptc-cell-readoption-ready';
const FIXTURE_THREAD_ID = testThreadId(982);
const FIXTURE_RUN_ID = 'ptc-cell-readoption-run';
const FIXTURE_CALL_ID = 'ptc-cell-readoption-call';
const TEST_RUNNING_CELL_REAP_AFTER_MS = 60_000;

if (process.argv.includes(DAEMON_FIXTURE_ARGUMENT)) {
  await runDaemonFixture();
} else {
  void test(
    'a second daemon process re-adopts the same command-host-owned PTC cell and resumes at the retained output base',
    { timeout: 60_000 },
    async (t) => {
      const stateRoot = await mkdtemp(
        join(tmpdir(), 'geulbat-ptc-cell-product-readoption-'),
      );
      const executable = join(stateRoot, 'long-running-cell.sh');
      await writeFile(
        executable,
        [
          '#!/bin/sh',
          'printf "pid=%s;phase=before\\n" "$$"',
          'sleep 3',
          'printf "pid=%s;phase=after\\n" "$$"',
          '',
        ].join('\n'),
        { encoding: 'utf8', mode: 0o700 },
      );
      let firstChild: ChildProcess | undefined;
      let secondChild: ChildProcess | undefined;

      t.after(async () => {
        stopChild(firstChild);
        stopChild(secondChild);
        const cleanupRuntime = createWorkerRuntime();
        await cleanupRuntime.closeAll().catch(() => undefined);
        await removeCommandHostWorkspace(stateRoot);
      });

      const first = await startDaemonFixture({
        stateRoot,
        executable,
        phase: 'launch',
      });
      firstChild = first.child;
      assert.equal(first.ready.status, 'running');
      const firstPid = parseCellPid(first.ready.output, 'before');

      first.child.kill('SIGKILL');
      await once(first.child, 'exit');

      const second = await startDaemonFixture({
        stateRoot,
        executable,
        phase: 'adopt',
        cellId: first.ready.cellId,
      });
      secondChild = second.child;
      assert.equal(second.ready.status, 'completed');
      assert.equal(parseCellPid(second.ready.output, 'after'), firstPid);
      assert.equal(
        parseCellPid(second.ready.replayedOutput, 'before'),
        firstPid,
      );
      assert.equal(second.ready.cellId, first.ready.cellId);
      assert.equal(
        second.ready.outputRef,
        first.ready.outputRef,
        'daemon 2 claimed the persisted command-host output session',
      );
      assert.equal(
        second.ready.processStarts,
        0,
        'daemon 2 recovered exec without starting another cell process',
      );

      second.child.kill('SIGTERM');
      const [secondExitCode, secondExitSignal] = await once(
        second.child,
        'exit',
      );
      assert.equal(secondExitCode, 0);
      assert.equal(secondExitSignal, null);

      const stateStore = await createDaemonRuntimeStateStore({
        homeStateRoot: stateRoot,
      });
      try {
        assert.deepEqual(
          stateStore.listPtcExecuteCodeCellCoordinates(),
          [],
          'terminal settlement removes the PTC cell coordinate',
        );
      } finally {
        stateStore.close();
      }
    },
  );

  void test(
    'a second daemon reconciles the same command-host-owned PTC process when the first daemon dies before coordinate persistence',
    { timeout: 60_000 },
    async (t) => {
      const stateRoot = await mkdtemp(
        join(tmpdir(), 'geulbat-ptc-cell-pre-coordinate-recovery-'),
      );
      const executable = join(stateRoot, 'long-running-cell.sh');
      const pidFile = join(stateRoot, 'cell.pid');
      await writeFile(
        executable,
        [
          '#!/bin/sh',
          `printf "%s" "$$" > "${pidFile}"`,
          'printf "pid=%s;phase=before\\n" "$$"',
          'sleep 3',
          'printf "pid=%s;phase=after\\n" "$$"',
          '',
        ].join('\n'),
        { encoding: 'utf8', mode: 0o700 },
      );
      let firstChild: ChildProcess | undefined;
      let secondChild: ChildProcess | undefined;

      t.after(async () => {
        stopChild(firstChild);
        stopChild(secondChild);
        const cleanupRuntime = createWorkerRuntime();
        await cleanupRuntime.closeAll().catch(() => undefined);
        await removeCommandHostWorkspace(stateRoot);
      });

      const first = await startDaemonFixture({
        stateRoot,
        executable,
        phase: 'launch_before_coordinate',
      });
      firstChild = first.child;
      const firstPid = await waitForPidFile(pidFile);

      first.child.kill('SIGKILL');
      await once(first.child, 'exit');

      const stateBeforeRecovery = await createDaemonRuntimeStateStore({
        homeStateRoot: stateRoot,
      });
      try {
        assert.deepEqual(
          stateBeforeRecovery.listPtcExecuteCodeCellCoordinates(),
          [],
          'daemon 1 died before publishing a PTC cell coordinate',
        );
      } finally {
        stateBeforeRecovery.close();
      }

      const second = await startDaemonFixture({
        stateRoot,
        executable,
        phase: 'recover_before_coordinate',
        cellId: first.ready.cellId,
      });
      secondChild = second.child;
      assert.equal(second.ready.status, 'completed');
      assert.equal(
        parseCellPid(second.ready.replayedOutput, 'before'),
        firstPid,
      );
      assert.equal(parseCellPid(second.ready.output, 'after'), firstPid);
      assert.equal(second.ready.cellId, first.ready.cellId);
      assert.equal(
        second.ready.outputRef,
        first.ready.outputRef,
        'the stable cell invocation recovered the pre-coordinate command-host session',
      );

      second.child.kill('SIGTERM');
      const [secondExitCode, secondExitSignal] = await once(
        second.child,
        'exit',
      );
      assert.equal(secondExitCode, 0);
      assert.equal(secondExitSignal, null);
    },
  );
}

interface DaemonFixtureReady {
  type: typeof FIXTURE_READY_MESSAGE;
  cellId: string;
  outputRef: string;
  output: string;
  replayedOutput: string;
  processStarts: number;
  status: PtcExecuteCodeRuntimeCellWaitSummary['status'];
}

type DaemonFixturePhase =
  | 'launch'
  | 'adopt'
  | 'launch_before_coordinate'
  | 'recover_before_coordinate';

interface NodeModuleCommand {
  execPath: string;
  args: string[];
}

async function runDaemonFixture(): Promise<void> {
  const stateRoot = requireFixtureEnv(FIXTURE_STATE_ROOT_ENV);
  const executable = requireFixtureEnv(FIXTURE_EXECUTABLE_ENV);
  const phase = requireFixturePhase();
  const stateStore = await createDaemonRuntimeStateStore({
    homeStateRoot: stateRoot,
  });
  const hostCommands = createWorkerRuntime();
  const starter = createHostRoutedDetachedProcessStarter({
    hostCommands,
    stateRoot,
    pageLimitBytes: 32 * 1024,
    cwd: stateRoot,
    env: process.env,
    runId: 'ptc-cell-readoption-e2e',
  });
  const attacher = createHostRoutedDetachedProcessAttacher({
    hostCommands,
    stateRoot,
    pageLimitBytes: 32 * 1024,
  });
  const sessionManager = createFixtureSessionManager();
  let processStarts = 0;
  const runtime = createPtcExecuteCodeRuntime({
    cellTerminalResultStore: createPtcExecuteCodeCellTerminalResultStore(),
    dockerPath: executable,
    createSessionManager: () => sessionManager,
    startCellProcess: (invocation) => {
      processStarts += 1;
      return starter({
        callId: invocation.cellId,
        executable: invocation.executable,
        args: invocation.args,
        ...(invocation.timeoutMs === undefined
          ? {}
          : { timeoutMs: invocation.timeoutMs }),
        ...(invocation.redactionMarkers === undefined
          ? {}
          : { redactionMarkers: invocation.redactionMarkers }),
        ...(invocation.redactionReplacement === undefined
          ? {}
          : { redactionReplacement: invocation.redactionReplacement }),
        ...(invocation.outputBufferPolicy === undefined
          ? {}
          : { outputBufferPolicy: invocation.outputBufferPolicy }),
      });
    },
    attachCellProcess: attacher,
    ptcCell: {
      enabled: true,
      initialYieldTimeMs: PTC_EXECUTE_CODE_CELL_EXEC_MIN_YIELD_MS,
      runningCellReapAfterMs: TEST_RUNNING_CELL_REAP_AFTER_MS,
    },
    runtimeRootForState: (root) => join(root, '.ptc-cell-readoption-runtime'),
  });
  const persistCellCoordinateBeforeCrash = async (
    coordinate: PtcExecuteCodeCellCoordinate,
  ): Promise<void> => {
    await sendFixtureMessage({
      type: FIXTURE_READY_MESSAGE,
      cellId: coordinate.cellId,
      outputRef: coordinate.processOutputRef,
      output: '',
      replayedOutput: '',
      processStarts,
      status: 'running',
    });
    await new Promise<void>(() => undefined);
  };
  const coordinateStore: PtcExecuteCodeCellCoordinateStore =
    phase === 'launch_before_coordinate'
      ? {
          listPtcExecuteCodeCellCoordinates: () =>
            stateStore.listPtcExecuteCodeCellCoordinates(),
          persistPtcExecuteCodeCellCoordinate: persistCellCoordinateBeforeCrash,
          deletePtcExecuteCodeCellCoordinate: (cellId) =>
            stateStore.deletePtcExecuteCodeCellCoordinate(cellId),
          readPtcExecuteCodeRunningExecDelivery: (args) =>
            stateStore.readPtcExecuteCodeRunningExecDelivery?.(args),
          persistPtcExecuteCodeRunningExecDelivery: (delivery) =>
            stateStore.persistPtcExecuteCodeRunningExecDelivery?.(delivery),
        }
      : stateStore;
  runtime.attachCellCoordinateStore?.(coordinateStore);
  const reAdopted = await runtime.reAdoptRunningCells?.();
  if (reAdopted === undefined || !reAdopted.ok) {
    throw new Error(
      reAdopted === undefined
        ? 'PTC cell re-adoption is unavailable'
        : reAdopted.message,
    );
  }

  let ready: DaemonFixtureReady;
  if (phase === 'launch' || phase === 'launch_before_coordinate') {
    const started = await runtime.executeCode({
      runContext: { threadId: FIXTURE_THREAD_ID, stateRoot },
      invocation: {
        runId: FIXTURE_RUN_ID,
        callId: FIXTURE_CALL_ID,
      },
      invocationId: FIXTURE_CALL_ID,
      request: {
        code: 'await new Promise(() => {})',
        timeoutMs: 30_000,
      },
    });
    if (phase === 'launch_before_coordinate') {
      throw new Error(
        'PTC pre-coordinate fixture unexpectedly crossed the blocked persistence boundary',
      );
    }
    if (
      !started.ok ||
      started.value.executionSurface !== 'node_via_lab_detached_cell' ||
      started.value.status !== 'running'
    ) {
      throw new Error('PTC readoption fixture cell did not remain running');
    }
    const runningCell = started.value;
    const coordinate = stateStore
      .listPtcExecuteCodeCellCoordinates()
      .find((value) => value.cellId === runningCell.cellId);
    if (coordinate === undefined) {
      throw new Error('PTC readoption fixture coordinate was not persisted');
    }
    ready = {
      type: FIXTURE_READY_MESSAGE,
      cellId: runningCell.cellId,
      outputRef: coordinate.processOutputRef,
      output: runningCell.stdout,
      replayedOutput: '',
      processStarts,
      status: runningCell.status,
    };
  } else {
    const cellId = requireFixtureEnv(FIXTURE_CELL_ID_ENV);
    let coordinate = stateStore
      .listPtcExecuteCodeCellCoordinates()
      .find((value) => value.cellId === cellId);
    if (phase === 'adopt' && coordinate === undefined) {
      throw new Error('PTC readoption fixture coordinate was not restored');
    }
    const replayed = await runtime.executeCode({
      runContext: { threadId: FIXTURE_THREAD_ID, stateRoot },
      invocation: {
        runId: FIXTURE_RUN_ID,
        callId: FIXTURE_CALL_ID,
      },
      invocationId: FIXTURE_CALL_ID,
      request: {
        code: 'await new Promise(() => {})',
        timeoutMs: 30_000,
      },
    });
    if (
      !replayed.ok ||
      replayed.value.executionSurface !== 'node_via_lab_detached_cell' ||
      replayed.value.status !== 'running' ||
      replayed.value.cellId !== cellId
    ) {
      throw new Error('PTC readoption fixture exec was not durably replayed');
    }
    coordinate = stateStore
      .listPtcExecuteCodeCellCoordinates()
      .find((value) => value.cellId === cellId);
    if (coordinate === undefined) {
      throw new Error(
        'PTC readoption fixture coordinate was not reconciled by exec',
      );
    }
    let output = '';
    let completed = false;
    while (!completed) {
      const waited = await runtime.waitForCell({
        runContext: { threadId: FIXTURE_THREAD_ID, stateRoot },
        request: { cellId, yieldTimeMs: 10_000 },
      });
      if (!waited.ok) {
        throw new Error(
          `PTC readoption fixture cell wait failed: ${waited.reasonCode}`,
        );
      }
      if ('stdout' in waited.value) {
        output += waited.value.stdout;
      }
      if (waited.value.status === 'completed') {
        completed = true;
        continue;
      }
      if (
        waited.value.status !== 'running' &&
        waited.value.status !== 'queued'
      ) {
        throw new Error(
          `PTC readoption fixture cell ended as ${waited.value.status}`,
        );
      }
    }
    ready = {
      type: FIXTURE_READY_MESSAGE,
      cellId,
      outputRef: coordinate.processOutputRef,
      output,
      replayedOutput: replayed.value.stdout,
      processStarts,
      status: 'completed',
    };
  }

  // Arm shutdown observation before publishing readiness. The parent is free
  // to signal as soon as it receives the IPC message.
  const shutdownSignal = waitForShutdownSignal();
  await sendFixtureMessage(ready);
  await shutdownSignal;
  try {
    await runtime.closeAll();
    await hostCommands.closeAll();
  } finally {
    stateStore.close();
    if (process.connected) {
      process.disconnect();
    }
  }
}

function createFixtureSessionManager(): PtcSessionDockerManager {
  const handle = {
    state: 'ready',
    containerId: 'ptc-cell-readoption-fixture-container',
  } as PtcSessionDockerHandle;
  return {
    async reapRestartResidue() {
      return { ok: true, value: undefined };
    },
    async adoptExisting(_identity, args) {
      assert.equal(args.containerId, handle.containerId);
      return { ok: true, value: handle };
    },
    async getOrCreate() {
      return { ok: true, value: handle };
    },
    async close() {
      return { ok: true, value: undefined };
    },
    async closeAll() {
      return { ok: true, value: undefined };
    },
  };
}

function createWorkerRuntime() {
  return createDaemonHostCommandRuntime({
    config: { inlineMaxBytes: 64 * 1024, tailRingBytes: 64 * 1024 },
    requestedMode: 'worker',
    workerCommand: commandHostWorkerCommand(),
  });
}

function commandHostWorkerCommand(): NodeModuleCommand {
  const source = fileURLToPath(
    new URL('../../../../command-host/main.ts', import.meta.url),
  );
  const built = fileURLToPath(
    new URL('../../../../command-host/main.js', import.meta.url),
  );
  return existsSync(built)
    ? { execPath: process.execPath, args: [built] }
    : {
        execPath: process.execPath,
        args: ['--import', fileURLToPath(import.meta.resolve('tsx')), source],
      };
}

async function startDaemonFixture(args: {
  stateRoot: string;
  executable: string;
  phase: DaemonFixturePhase;
  cellId?: string;
}): Promise<{ child: ChildProcess; ready: DaemonFixtureReady }> {
  const childEnvironment = { ...process.env };
  delete childEnvironment[FIXTURE_CELL_ID_ENV];
  if (args.cellId !== undefined) {
    childEnvironment[FIXTURE_CELL_ID_ENV] = args.cellId;
  }
  const child = fork(
    fileURLToPath(import.meta.url),
    [DAEMON_FIXTURE_ARGUMENT],
    {
      env: {
        ...childEnvironment,
        [FIXTURE_STATE_ROOT_ENV]: args.stateRoot,
        [FIXTURE_EXECUTABLE_ENV]: args.executable,
        [FIXTURE_PHASE_ENV]: args.phase,
      },
      execArgv: process.execArgv.filter(
        (argument) => !argument.startsWith('--test'),
      ),
      stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
    },
  );
  return await new Promise((resolve, reject) => {
    let settled = false;
    const settle = (
      outcome:
        | { ok: true; ready: DaemonFixtureReady }
        | { ok: false; error: Error },
    ): void => {
      if (settled) {
        return;
      }
      settled = true;
      child.off('message', onMessage);
      child.off('error', onError);
      child.off('exit', onExit);
      if (outcome.ok) {
        resolve({ child, ready: outcome.ready });
        return;
      }
      reject(outcome.error);
    };
    const onMessage = (message: unknown): void => {
      if (isDaemonFixtureReady(message)) {
        settle({ ok: true, ready: message });
      }
    };
    const onError = (error: Error): void => {
      settle({ ok: false, error });
    };
    const onExit = (
      code: number | null,
      signal: NodeJS.Signals | null,
    ): void => {
      settle({
        ok: false,
        error: new Error(
          `PTC cell fixture exited before readiness (code=${String(
            code,
          )}, signal=${String(signal)})`,
        ),
      });
    };
    child.on('message', onMessage);
    child.on('error', onError);
    child.on('exit', onExit);
  });
}

function isDaemonFixtureReady(value: unknown): value is DaemonFixtureReady {
  return (
    typeof value === 'object' &&
    value !== null &&
    'type' in value &&
    value.type === FIXTURE_READY_MESSAGE &&
    'cellId' in value &&
    typeof value.cellId === 'string' &&
    'outputRef' in value &&
    typeof value.outputRef === 'string' &&
    'output' in value &&
    typeof value.output === 'string' &&
    'replayedOutput' in value &&
    typeof value.replayedOutput === 'string' &&
    'processStarts' in value &&
    typeof value.processStarts === 'number' &&
    'status' in value &&
    (value.status === 'running' || value.status === 'completed')
  );
}

async function sendFixtureMessage(message: DaemonFixtureReady): Promise<void> {
  const send = process.send;
  if (send === undefined) {
    throw new Error('PTC cell readoption fixture requires an IPC channel');
  }
  await new Promise<void>((resolve, reject) => {
    send.call(process, message, (error) => {
      if (error === null) {
        resolve();
        return;
      }
      reject(error);
    });
  });
}

function parseCellPid(output: string, phase: 'before' | 'after'): number {
  const match = new RegExp(`pid=(\\d+);phase=${phase}`, 'u').exec(output);
  assert.ok(match);
  return Number(match[1]);
}

function requireFixtureEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0) {
    throw new Error(`missing PTC cell readoption fixture environment: ${name}`);
  }
  return value;
}

function requireFixturePhase(): DaemonFixturePhase {
  const value = requireFixtureEnv(FIXTURE_PHASE_ENV);
  if (
    value !== 'launch' &&
    value !== 'adopt' &&
    value !== 'launch_before_coordinate' &&
    value !== 'recover_before_coordinate'
  ) {
    throw new Error('invalid PTC cell readoption fixture phase');
  }
  return value;
}

function waitForShutdownSignal(): Promise<void> {
  return new Promise((resolve) => {
    process.once('SIGINT', resolve);
    process.once('SIGTERM', resolve);
  });
}

function stopChild(child: ChildProcess | undefined): void {
  if (
    child !== undefined &&
    child.exitCode === null &&
    child.signalCode === null
  ) {
    child.kill('SIGTERM');
  }
}

async function waitForPidFile(pidFile: string): Promise<number> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const pid = Number(await readFile(pidFile, 'utf8'));
      if (Number.isSafeInteger(pid) && pid > 0) {
        return pid;
      }
    } catch {
      // The child may not have crossed exec yet.
    }
    await delay(20);
  }
  throw new Error('PTC cell process did not publish its pid');
}
