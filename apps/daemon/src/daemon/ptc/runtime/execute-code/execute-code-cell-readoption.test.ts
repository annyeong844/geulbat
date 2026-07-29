import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { deferredDetachedProcessExit as deferredExit } from '../../../../test-support/ptc-execute-code-cell-process.js';
import { makeRunContext } from '../../../../test-support/run-context.js';
import { createPtcSessionDockerCommandFixture } from '../../../../test-support/ptc-session-docker.js';
import { testThreadId } from '../../../../test-support/thread-id.js';
import type { PtcEpochCallbackHandler } from '../../callback/epoch-callback.js';
import { PTC_LAB_LOCAL_DOCKER_BATCH_COMMAND_MAX_BUFFERED_BYTES_PER_STREAM } from '../../lab/profile/lab-profile-contract.js';
import {
  createPtcSessionDockerLocalBatchCommandPolicy,
  type PtcSessionDockerManager,
} from '../../lab/session/session-docker-contract.js';
import type {
  DetachedProcessExitInfo,
  DetachedProcessHandle,
  DetachedProcessOutputSegment,
} from './execute-code-cell-process.js';
import { createPtcExecuteCodeCellReadoptionLedger } from './execute-code-cell-readoption.js';
import {
  PTC_EXECUTE_CODE_CELL_EXEC_MIN_YIELD_MS,
  PTC_EXECUTE_CODE_TRUST_CONTEXT_ID,
  type PtcExecuteCodeCellCoordinate,
  type PtcExecuteCodeCellCoordinateStore,
} from './execute-code-runtime-contract.js';
import { createPtcExecuteCodeRuntime } from './execute-code-runtime.js';

const TEST_RUNNING_CELL_REAP_AFTER_MS = 600_000;

void test('detached cells persist a non-secret coordinate before yielding and delete it after settlement', async () => {
  const stateRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-ptc-cell-coordinate-state-'),
  );
  const runtimeRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-ptc-cell-coordinate-runtime-'),
  );
  const fixture = createPtcSessionDockerCommandFixture({
    policy: createPtcSessionDockerLocalBatchCommandPolicy(),
    containerId: 'container-ptc-cell-coordinate',
  });
  const exit = deferredExit();
  const coordinates = createMemoryCoordinateStore();
  const runtime = createPtcExecuteCodeRuntime({
    commandRunner: fixture.runner,
    startCellProcess: () => ({
      ok: true,
      handle: makeDetachedHandle({
        outputRef: 'output-ref-cell-coordinate',
        output: { stdout: 'survived\n', stderr: '' },
        exit: exit.promise,
        onTerminate: () =>
          exit.resolve({
            kind: 'signal',
            exitCode: null,
            processTerminated: false,
          }),
      }),
    }),
    ptcCell: {
      enabled: true,
      initialYieldTimeMs: 1,
      runningCellReapAfterMs: TEST_RUNNING_CELL_REAP_AFTER_MS,
    },
    runtimeRootForState: () => runtimeRoot,
  });
  runtime.attachCellCoordinateStore?.(coordinates);

  try {
    const started = await runtime.executeCode({
      runContext: makeRunContext({
        threadId: testThreadId(980),
        stateRoot,
      }),
      request: { code: 'await new Promise(() => {})' },
    });
    assert.equal(started.ok, true);
    if (!started.ok) {
      return;
    }
    assert.equal(started.value.executionSurface, 'node_via_lab_detached_cell');
    if (started.value.executionSurface !== 'node_via_lab_detached_cell') {
      return;
    }
    assert.equal(started.value.status, 'running');
    assert.equal(coordinates.values.length, 1);
    const coordinate = coordinates.values[0];
    assert.equal(coordinate?.processOutputRef, 'output-ref-cell-coordinate');
    assert.equal(coordinate?.callbackOutputRef, undefined);
    assert.equal(coordinate?.containerId, 'container-ptc-cell-coordinate');
    assert.equal(coordinate?.orphanReapAtMs !== undefined, true);
    assert.deepEqual(coordinate?.callbackToolNames, []);
    assert.equal(coordinate?.storeCallbacksEnabled, false);

    exit.resolve({
      kind: 'exit',
      exitCode: 0,
      processTerminated: true,
    });
    const completed = await runtime.waitForCell({
      runContext: {
        threadId: testThreadId(980),
        stateRoot,
      },
      request: {
        cellId: started.value.cellId,
        yieldTimeMs: 1_000,
      },
    });
    assert.equal(completed.ok, true);
    if (completed.ok) {
      assert.equal(completed.value.status, 'completed');
      assert.equal(
        'stdout' in completed.value ? completed.value.stdout : undefined,
        'survived\n',
      );
    }
    assert.deepEqual(coordinates.values, []);
  } finally {
    await runtime.closeAll();
    await rm(stateRoot, { recursive: true, force: true });
    await rm(runtimeRoot, { recursive: true, force: true });
  }
});

void test('a new runtime re-adopts a persisted cell and restores only its original callback tools through wait', async () => {
  const stateRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-ptc-cell-readoption-state-'),
  );
  const runtimeRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-ptc-cell-readoption-runtime-'),
  );
  const threadId = testThreadId(981);
  const cellId = 'ptc_cell_readopted';
  const exit = deferredExit();
  const handle = makeDetachedHandle({
    outputRef: 'output-ref-readopted-cell',
    output: { stdout: 'continued\n', stderr: '' },
    exit: exit.promise,
    onTerminate: () =>
      exit.resolve({
        kind: 'signal',
        exitCode: null,
        processTerminated: false,
      }),
  });
  let currentCallbackHandler: PtcEpochCallbackHandler | undefined;
  let adoptedContainerId: string | undefined;
  let sessionCloseCount = 0;
  const sessionManager = {
    async adoptExisting(_identity, args) {
      adoptedContainerId = args.containerId;
      return { ok: true, value: undefined as never };
    },
    async getOrCreate() {
      throw new Error('re-adoption must not launch a replacement container');
    },
    async close() {
      sessionCloseCount += 1;
      return { ok: true, value: undefined };
    },
    async closeAll() {
      return { ok: true, value: undefined };
    },
  } satisfies PtcSessionDockerManager;
  const coordinates = createMemoryCoordinateStore([
    {
      stateRoot,
      threadId,
      cellId,
      createdAtMs: Date.now() - 1_000,
      effectiveTimeoutMs: 30_000,
      orphanReapAtMs: Date.now() + TEST_RUNNING_CELL_REAP_AFTER_MS,
      processOutputRef: 'output-ref-readopted-cell',
      callbackOutputRef: 'output-ref-readopted-callback',
      trustContextId: PTC_EXECUTE_CODE_TRUST_CONTEXT_ID,
      containerId: 'container-ptc-cell-readoption',
      maxBufferedBytesPerStream:
        PTC_LAB_LOCAL_DOCKER_BATCH_COMMAND_MAX_BUFFERED_BYTES_PER_STREAM,
      callbackToolNames: ['read_file'],
      storeCallbacksEnabled: false,
    },
  ]);
  const runtime = createPtcExecuteCodeRuntime({
    createSessionManager: () => sessionManager,
    startCellProcess: () => {
      throw new Error('re-adoption must not launch a replacement process');
    },
    attachCellProcess: async ({ outputRef }) => {
      assert.equal(outputRef, 'output-ref-readopted-cell');
      return { ok: true, handle };
    },
    attachEpochCallbackController: async ({ outputRef, handler }) => {
      assert.equal(outputRef, 'output-ref-readopted-callback');
      currentCallbackHandler = handler;
      return {
        replaceHandler(nextHandler) {
          currentCallbackHandler = nextHandler;
        },
        async close() {},
      };
    },
    ptcCell: {
      enabled: true,
      initialYieldTimeMs: 1,
      runningCellReapAfterMs: TEST_RUNNING_CELL_REAP_AFTER_MS,
    },
    runtimeRootForState: () => runtimeRoot,
  });
  runtime.attachCellCoordinateStore?.(coordinates);

  try {
    assert.deepEqual(
      await withTestTimeout(
        runtime.reAdoptRunningCells?.(),
        'running-cell re-adoption',
      ),
      { ok: true },
    );
    assert.equal(adoptedContainerId, 'container-ptc-cell-readoption');

    const running = await withTestTimeout(
      runtime.waitForCell({
        runContext: { threadId, stateRoot },
        request: {
          cellId,
          yieldTimeMs: PTC_EXECUTE_CODE_CELL_EXEC_MIN_YIELD_MS,
        },
        toolCallbackHandler: async (invocation) => ({
          ok: true,
          result: {
            toolName: invocation.toolName,
            cellId: invocation.cellId,
          },
        }),
      }),
      'running-cell callback claim',
    );
    assert.equal(running.ok, true);
    if (running.ok) {
      assert.equal(running.value.status, 'running');
    }

    const callbackHandler = currentCallbackHandler;
    assert.notEqual(callbackHandler, undefined);
    if (callbackHandler === undefined) {
      return;
    }
    assert.deepEqual(
      await callbackHandler({
        requestId: 'readopted-allowed',
        kind: 'geulbat_tool_call',
        args: { toolName: 'read_file', args: { path: 'note.txt' } },
        signal: new AbortController().signal,
        enterLongWait: () => true,
      }),
      {
        ok: true,
        result: { toolName: 'read_file', cellId },
      },
    );
    assert.deepEqual(
      await callbackHandler({
        requestId: 'readopted-forbidden',
        kind: 'geulbat_tool_call',
        args: { toolName: 'write_file', args: { path: 'note.txt' } },
        signal: new AbortController().signal,
        enterLongWait: () => true,
      }),
      {
        ok: false,
        errorCode: 'ptc_tool_not_callable',
        message: 'The tool was not projected into this running PTC cell',
      },
    );

    exit.resolve({
      kind: 'exit',
      exitCode: 0,
      processTerminated: true,
    });
    const completed = await withTestTimeout(
      runtime.waitForCell({
        runContext: { threadId, stateRoot },
        request: { cellId, yieldTimeMs: 1_000 },
      }),
      're-adopted cell completion',
    );
    assert.equal(completed.ok, true);
    if (completed.ok) {
      assert.equal(completed.value.status, 'completed');
      assert.equal(
        'stdout' in completed.value ? completed.value.stdout : undefined,
        'continued\n',
      );
    }
    assert.deepEqual(coordinates.values, []);
    assert.equal(sessionCloseCount, 0);
  } finally {
    await runtime.closeAll();
    await rm(stateRoot, { recursive: true, force: true });
    await rm(runtimeRoot, { recursive: true, force: true });
  }
});

void test('running-cell re-adoption reports unreadable coordinates and missing process owners', async (t) => {
  const createLedger = () =>
    createPtcExecuteCodeCellReadoptionLedger({
      attachCellProcess: undefined,
      attachEpochCallbackController: undefined,
      cellRegistry: undefined,
      getStateRuntime: async () => ({
        ok: false,
        reasonCode: 'ptc_lab_session_unavailable',
        message: 'unused state runtime',
        diagnostics: { unused: true },
      }),
    });

  await t.test('coordinate listing fails closed', async () => {
    const ledger = createLedger();
    ledger.attachStore({
      listPtcExecuteCodeCellCoordinates() {
        throw new Error('coordinate store offline');
      },
      persistPtcExecuteCodeCellCoordinate() {},
      deletePtcExecuteCodeCellCoordinate() {},
    });

    assert.deepEqual(await ledger.reAdoptRunningCells(), {
      ok: false,
      reasonCode: 'ptc_execute_code_session_cleanup_failed',
      message: 'PTC execute_code cell coordinates could not be read',
      diagnostics: { cellCoordinateListFailed: true },
    });
  });

  await t.test('both required process attachers are diagnosed', async () => {
    const ledger = createLedger();
    ledger.attachStore(
      createMemoryCoordinateStore([
        persistedCoordinate({
          stateRoot: '/state/readoption-owner-check',
          threadId: testThreadId(982),
          cellId: 'ptc_cell_readoption_owner_check',
          callbackOutputRef: 'output-ref-readoption-callback',
          callbackToolNames: ['read_file'],
        }),
      ]),
    );

    assert.deepEqual(await ledger.reAdoptRunningCells(), {
      ok: false,
      reasonCode: 'ptc_execute_code_session_cleanup_failed',
      message:
        'PTC execute_code cell re-adoption is unavailable for persisted cells',
      diagnostics: {
        cellProcessAttacherMissing: true,
        callbackProcessAttacherMissing: true,
      },
    });
  });
});

void test('a partially adopted cell is closed and forgotten when its process cannot be reattached', async () => {
  const stateRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-ptc-cell-readoption-cleanup-state-'),
  );
  const runtimeRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-ptc-cell-readoption-cleanup-runtime-'),
  );
  const threadId = testThreadId(983);
  const cellId = 'ptc_cell_readoption_cleanup';
  let sessionCloseCount = 0;
  const sessionManager = {
    async adoptExisting() {
      return { ok: true, value: undefined as never };
    },
    async getOrCreate() {
      throw new Error('cleanup proof must not launch a replacement container');
    },
    async close() {
      sessionCloseCount += 1;
      return { ok: true, value: undefined };
    },
    async closeAll() {
      return { ok: true, value: undefined };
    },
  } satisfies PtcSessionDockerManager;
  const coordinates = createMemoryCoordinateStore([
    persistedCoordinate({ stateRoot, threadId, cellId }),
  ]);
  const runtime = createPtcExecuteCodeRuntime({
    createSessionManager: () => sessionManager,
    startCellProcess: () => {
      throw new Error('cleanup proof must not start a replacement process');
    },
    attachCellProcess: async () => {
      throw new Error('persisted process no longer exists');
    },
    ptcCell: {
      enabled: true,
      initialYieldTimeMs: 1,
      runningCellReapAfterMs: TEST_RUNNING_CELL_REAP_AFTER_MS,
    },
    runtimeRootForState: () => runtimeRoot,
  });
  runtime.attachCellCoordinateStore?.(coordinates);

  try {
    assert.deepEqual(await runtime.reAdoptRunningCells?.(), { ok: true });
    assert.deepEqual(coordinates.values, []);
    assert.equal(sessionCloseCount, 1);
  } finally {
    await runtime.closeAll();
    await rm(stateRoot, { recursive: true, force: true });
    await rm(runtimeRoot, { recursive: true, force: true });
  }
});

function createMemoryCoordinateStore(
  initial: readonly PtcExecuteCodeCellCoordinate[] = [],
): PtcExecuteCodeCellCoordinateStore & {
  readonly values: readonly PtcExecuteCodeCellCoordinate[];
} {
  const coordinates = new Map(initial.map((value) => [value.cellId, value]));
  return {
    get values() {
      return [...coordinates.values()];
    },
    listPtcExecuteCodeCellCoordinates() {
      return [...coordinates.values()];
    },
    persistPtcExecuteCodeCellCoordinate(coordinate) {
      coordinates.set(coordinate.cellId, coordinate);
    },
    deletePtcExecuteCodeCellCoordinate(cellId) {
      coordinates.delete(cellId);
    },
  };
}

function persistedCoordinate(args: {
  stateRoot: string;
  threadId: string;
  cellId: PtcExecuteCodeCellCoordinate['cellId'];
  callbackOutputRef?: string;
  callbackToolNames?: readonly string[];
}): PtcExecuteCodeCellCoordinate {
  return {
    stateRoot: args.stateRoot,
    threadId: args.threadId,
    cellId: args.cellId,
    createdAtMs: Date.now() - 1_000,
    effectiveTimeoutMs: 30_000,
    orphanReapAtMs: Date.now() + TEST_RUNNING_CELL_REAP_AFTER_MS,
    processOutputRef: `output-ref-${args.cellId}`,
    ...(args.callbackOutputRef === undefined
      ? {}
      : { callbackOutputRef: args.callbackOutputRef }),
    trustContextId: PTC_EXECUTE_CODE_TRUST_CONTEXT_ID,
    containerId: `container-${args.cellId}`,
    maxBufferedBytesPerStream:
      PTC_LAB_LOCAL_DOCKER_BATCH_COMMAND_MAX_BUFFERED_BYTES_PER_STREAM,
    callbackToolNames: args.callbackToolNames ?? [],
    storeCallbacksEnabled: false,
  };
}

function makeDetachedHandle(args: {
  outputRef: string;
  output: DetachedProcessOutputSegment;
  exit: Promise<DetachedProcessExitInfo>;
  onTerminate?: () => void;
}): DetachedProcessHandle {
  let exited = false;
  let pending = args.output;
  return {
    outputRef: args.outputRef,
    drainNewOutput() {
      if (!exited) {
        return { stdout: '', stderr: '' };
      }
      const output = pending;
      pending = { stdout: '', stderr: '' };
      return output;
    },
    exit: args.exit.then((value) => {
      exited = true;
      return value;
    }),
    terminate() {
      args.onTerminate?.();
    },
  };
}

async function withTestTimeout<T>(
  promise: Promise<T> | undefined,
  label: string,
): Promise<T> {
  if (promise === undefined) {
    throw new Error(`${label} is unavailable`);
  }
  return await Promise.race([
    promise,
    new Promise<never>((_resolve, reject) => {
      setTimeout(() => reject(new Error(`${label} timed out`)), 2_000).unref();
    }),
  ]);
}
