import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import type {
  RunRequest,
  RunStartRequest,
} from '@geulbat/protocol/run-contract';
import { assertRunId, type ThreadId } from '@geulbat/protocol/ids';
import { isRunChannelServerMessage } from '@geulbat/protocol/run-channel';
import {
  agentLoopKernelImplementation,
  type AgentLoopImplementation,
} from '@geulbat/agent-loop/kernel';
import { createToolCapabilityPolicy } from '@geulbat/tool-library/tool-capability-policy';

import { createDaemonContext } from '../../../daemon/context.js';
import {
  createAgentLoopImplementationAdmission,
  type AgentLoopImplementationAdmission,
} from '../../../daemon/agent/loop-implementation-admission.js';
import { createAgentToolCapabilityPolicy } from '../../../daemon/agent/loop-tool-library-projection.js';
import { getToolLibraryProjectionIdentity } from '../../../daemon/tools/tool-library-projection-manifest.js';
import { startManagedRun } from '../../../daemon/agent/runtime/managed-run.js';
import {
  readRunPromptInputRef,
  writeRunPromptInputRefFromStream,
} from '../../../daemon/sessions/prompt-input-ref-store.js';
import { appendTranscriptEntry } from '../../../daemon/sessions/transcript-log.js';
import {
  cleanupSocketState,
  getSocketState,
} from './run-channel-socket-runtime.js';
import {
  createRunChannelTestDaemonContext,
  createTestSocket,
  readLastSentMessage,
} from '../../../test-support/run-channel-test-support.js';
import { recoverDurableRunsAtDaemonStartup } from '../../../daemon/durable-run-execution.js';
import {
  executeRunRequest,
  recoverDurableRunsForSocket,
} from './run-channel-start.js';
import { testThreadId } from '../../../test-support/thread-id.js';

void test('executeRunRequest rejects blank prompts', async () => {
  const daemonContext = createRunChannelTestDaemonContext();
  const socket = createTestSocket();

  try {
    await executeRunRequest({
      socket,
      requestId: 'run-start-blank-prompt',
      request: {
        prompt: '   ',
      },
      allowedPublicToolNames: undefined,
      runtimeContext: daemonContext,
    });

    assert.deepEqual(readLastSentMessage(socket), {
      type: 'run.error',
      requestId: 'run-start-blank-prompt',
      status: 400,
      code: 'bad_request',
      message: 'prompt is required',
    });
  } finally {
    cleanupSocketState(socket, daemonContext);
  }
});

void test('executeRunRequest reports missing working directories before starting a run', async () => {
  const daemonContext = createRunChannelTestDaemonContext();
  const socket = createTestSocket();

  try {
    await executeRunRequest({
      socket,
      requestId: 'run-start-missing-working-directory',
      request: {
        prompt: 'hello',
        workingDirectory: join(
          daemonContext.homeStateRoot,
          'missing-working-directory',
        ),
      },
      allowedPublicToolNames: undefined,
      runtimeContext: daemonContext,
    });

    assert.deepEqual(readLastSentMessage(socket), {
      type: 'run.error',
      requestId: 'run-start-missing-working-directory',
      status: 404,
      code: 'not_found',
      message: 'working directory not found',
    });
  } finally {
    cleanupSocketState(socket, daemonContext);
  }
});

void test('executeRunRequest rejects malformed thread ids', async () => {
  const daemonContext = createRunChannelTestDaemonContext();
  const socket = createTestSocket();

  try {
    await executeRunRequest({
      socket,
      requestId: 'run-start-invalid-thread',
      request: {
        prompt: 'hello',
        threadId: '../bad-thread' as unknown as ThreadId,
      },
      allowedPublicToolNames: undefined,
      runtimeContext: daemonContext,
    });

    assert.deepEqual(readLastSentMessage(socket), {
      type: 'run.error',
      requestId: 'run-start-invalid-thread',
      status: 400,
      code: 'bad_request',
      message: 'invalid threadId',
    });
  } finally {
    cleanupSocketState(socket, daemonContext);
  }
});

void test('executeRunRequest does not start a run for a closed socket', async () => {
  const daemonContext = createRunChannelTestDaemonContext();
  const socket = createTestSocket();
  const socketState = getSocketState(socket);
  socketState.closed = true;

  try {
    await executeRunRequest({
      socket,
      requestId: 'run-start-closed-socket',
      request: {
        prompt: 'hello',
      },
      allowedPublicToolNames: undefined,
      runtimeContext: daemonContext,
    });

    assert.equal(readLastSentMessage(socket), undefined);
    assert.equal(socketState.activeRunIds.size, 0);
  } finally {
    cleanupSocketState(socket, daemonContext);
  }
});

void test('foreground socket recovery ignores internally owned child checkpoints', async () => {
  const daemonContext = createRunChannelTestDaemonContext();
  const socket = createTestSocket();
  const threadId = testThreadId(46);
  const runId = assertRunId('run-internal-child-checkpoint');

  try {
    await daemonContext.runCheckpoints.startRun({
      runId,
      threadId,
      request: {
        workingDirectory: '',
        permissionMode: 'basic',
        backgroundChild: {
          parentRunId: assertRunId('run-internal-child-parent'),
          ownerThreadId: testThreadId(47),
          computerSessionId: 'internal-child-session',
        },
      },
    });
    assert.equal(await recoverDurableRunsForSocket(socket, daemonContext), 0);
    assert.equal(socket.sentFrames.length, 0);

    await daemonContext.runCheckpoints.settleRun({
      runId,
      threadId,
      terminal: {
        eventCursor: 0,
        event: {
          type: 'done',
          payload: { answer: 'child terminal', ok: true },
        },
      },
    });
    assert.equal(await recoverDurableRunsForSocket(socket, daemonContext), 0);
    assert.equal(socket.sentFrames.length, 0);
    assert.equal(await recoverDurableRunsAtDaemonStartup(daemonContext), 1);
    assert.equal(
      (await daemonContext.runCheckpoints.readThread(threadId))?.terminal
        ?.acknowledged,
      true,
    );
  } finally {
    cleanupSocketState(socket, daemonContext);
    await rm(daemonContext.homeStateRoot, { recursive: true, force: true });
  }
});

void test('executeRunRequest releases its managed run when loop admission rejects the contract', async () => {
  const daemonContext = createRunChannelTestDaemonContext();
  const socket = createTestSocket();
  const threadId = testThreadId(34);
  const incompatible = {
    ...agentLoopKernelImplementation,
    implementationId: 'test.incompatible-loop',
    contractVersion: '2',
  };
  let capturedToolCapabilityPolicy:
    | ReturnType<typeof createToolCapabilityPolicy>
    | undefined;
  const incompatibleAdmission = createAgentLoopImplementationAdmission({
    additionalImplementations: [incompatible],
    selectImplementationId: () => incompatible.implementationId,
  });
  const capturingAdmission: AgentLoopImplementationAdmission = {
    async admitRun(input) {
      capturedToolCapabilityPolicy = input.toolCapabilityPolicy;
      return await incompatibleAdmission.admitRun(input);
    },
  };
  const runtimeContext = {
    ...daemonContext,
    agent: {
      ...daemonContext.agent,
      loopImplementationAdmission: capturingAdmission,
    },
  };

  try {
    await executeRunRequest({
      socket,
      requestId: 'run-start-incompatible-loop',
      request: { prompt: 'hello', threadId } satisfies RunRequest,
      allowedPublicToolNames: undefined,
      runtimeContext,
    });

    assert.deepEqual(readLastSentMessage(socket), {
      type: 'run.error',
      requestId: 'run-start-incompatible-loop',
      status: 503,
      code: 'execution_failed',
      message:
        'agent loop implementation contract is incompatible: test.incompatible-loop@2; registered 2, host requires 1',
    });
    const toolCapabilityPolicy = capturedToolCapabilityPolicy;
    assert.ok(toolCapabilityPolicy);
    assert.deepEqual(
      toolCapabilityPolicy,
      createAgentToolCapabilityPolicy({
        registry: runtimeContext.toolRegistry,
      }),
    );
    const afterFailure = startManagedRun(
      {
        runId: 'run-after-incompatible-loop',
        runContext: {
          threadId,
          stateRoot: runtimeContext.homeStateRoot,
          workingDirectory: '',
        },
      },
      { activeRuns: runtimeContext.activeRuns },
    );
    assert.equal(afterFailure.ok, true);
    if (afterFailure.ok) {
      afterFailure.finish();
    }
  } finally {
    cleanupSocketState(socket, runtimeContext);
  }
});

void test('executeRunRequest releases its managed run when checkpoint lookup rejects', async () => {
  const daemonContext = createRunChannelTestDaemonContext();
  const socket = createTestSocket();
  const threadId = testThreadId(48);
  const checkpointFailure = new Error('checkpoint read failed');
  const runtimeContext = {
    ...daemonContext,
    runCheckpoints: {
      ...daemonContext.runCheckpoints,
      async readThread() {
        throw checkpointFailure;
      },
    },
  };

  try {
    await assert.rejects(
      executeRunRequest({
        socket,
        requestId: 'run-start-checkpoint-read-failure',
        request: { prompt: 'hello', threadId } satisfies RunRequest,
        allowedPublicToolNames: undefined,
        runtimeContext,
      }),
      checkpointFailure,
    );

    const afterFailure = startManagedRun(
      {
        runId: 'run-after-checkpoint-read-failure',
        runContext: {
          threadId,
          stateRoot: runtimeContext.homeStateRoot,
          workingDirectory: '',
        },
      },
      { activeRuns: runtimeContext.activeRuns },
    );
    assert.equal(afterFailure.ok, true);
    if (afterFailure.ok) {
      afterFailure.finish();
    }
  } finally {
    cleanupSocketState(socket, runtimeContext);
  }
});

void test('executeRunRequest releases live and managed run ownership when initial socket delivery throws', async () => {
  const daemonContext = createRunChannelTestDaemonContext();
  const socket = createTestSocket();
  const socketState = getSocketState(socket);
  const threadId = testThreadId(49);
  const deliveryFailure = new Error('initial socket delivery failed');
  Object.defineProperty(socket, 'send', {
    configurable: true,
    value() {
      throw deliveryFailure;
    },
  });

  try {
    await assert.rejects(
      executeRunRequest({
        socket,
        requestId: 'run-start-initial-socket-delivery-failure',
        request: { prompt: 'hello', threadId } satisfies RunRequest,
        allowedPublicToolNames: undefined,
        runtimeContext: daemonContext,
      }),
      deliveryFailure,
    );

    const ownedRunId = [...socketState.ownedRunIds].at(-1);
    assert.ok(ownedRunId);
    assert.equal(socketState.activeRunIds.size, 0);
    assert.equal(daemonContext.liveRunEvents.hasRun(ownedRunId), false);

    const afterFailure = startManagedRun(
      {
        runId: 'run-after-initial-socket-delivery-failure',
        runContext: {
          threadId,
          stateRoot: daemonContext.homeStateRoot,
          workingDirectory: '',
        },
      },
      { activeRuns: daemonContext.activeRuns },
    );
    assert.equal(afterFailure.ok, true);
    if (afterFailure.ok) {
      afterFailure.finish();
    }
  } finally {
    cleanupSocketState(socket, daemonContext);
  }
});

void test('executeRunRequest pins one observer-safe projection identity in the durable request', async (t) => {
  const homeStateRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-run-projection-pin-'),
  );
  t.after(async () => rm(homeStateRoot, { recursive: true, force: true }));
  const daemonContext = createDaemonContext({ homeStateRoot });
  const socket = createTestSocket();
  const threadId = testThreadId(45);
  const implementation = {
    implementationId: 'test.projection-pin-loop',
    contractVersion: agentLoopKernelImplementation.contractVersion,
    async run(input) {
      const result = input.ports.createTerminalFailure({
        kind: 'blocked',
        message: 'projection pin test stop',
      });
      input.ports.settleTerminal({ result, source: 'blocked' });
      return result;
    },
  } satisfies AgentLoopImplementation;
  const runtimeContext = {
    ...daemonContext,
    agent: {
      ...daemonContext.agent,
      loopImplementationAdmission: createAgentLoopImplementationAdmission({
        additionalImplementations: [implementation],
        selectImplementationId: () => implementation.implementationId,
      }),
    },
  };

  try {
    await executeRunRequest({
      socket,
      requestId: 'run-start-projection-pin',
      request: {
        prompt: 'pin the projection before execution',
        threadId,
      } satisfies RunRequest,
      allowedPublicToolNames: undefined,
      runtimeContext,
    });

    const checkpoint = await runtimeContext.runCheckpoints.readThread(threadId);
    assert.equal(checkpoint?.status, 'terminal');
    const identity = checkpoint?.request.toolLibraryProjectionIdentity;
    assert.deepEqual(Object.keys(identity ?? {}).sort(), [
      'policyId',
      'sdkProjectionHash',
      'sdkVersion',
    ]);
    assert.ok(identity);
    const rehydrated =
      await runtimeContext.toolLibraryProjection.rehydrateProjectionMount({
        stateRoot: homeStateRoot,
        threadId,
        expectedIdentity: identity,
      });
    assert.equal(rehydrated.ok, true);
  } finally {
    cleanupSocketState(socket, runtimeContext);
  }
});

void test('durable recovery requires the exact recorded loop implementation without selection fallback', async () => {
  const daemonContext = createRunChannelTestDaemonContext();
  const socket = createTestSocket();
  const threadId = testThreadId(37);
  const runId = assertRunId('run-removed-loop-recovery');
  const originalError = console.error;
  const errors: unknown[][] = [];
  console.error = (...args: unknown[]) => {
    errors.push(args);
  };

  try {
    await daemonContext.runCheckpoints.startRun({
      runId,
      threadId,
      request: {
        workingDirectory: '',
        permissionMode: 'basic',
        loopImplementation: {
          implementationId: 'test.removed-loop',
          contractVersion: '1',
        },
      },
    });

    assert.equal(await recoverDurableRunsForSocket(socket, daemonContext), 0);
    assert.equal(
      daemonContext.activeRuns.getRunByThreadId(threadId),
      undefined,
    );
    assert.equal(
      (await daemonContext.runCheckpoints.readThread(threadId))?.status,
      'running',
    );
    assert.match(JSON.stringify(errors), /implementation_unavailable/u);
    assert.match(JSON.stringify(errors), /test\.removed-loop/u);
  } finally {
    console.error = originalError;
    cleanupSocketState(socket, daemonContext);
    await rm(daemonContext.homeStateRoot, { recursive: true, force: true });
  }
});

void test(
  'durable recovery replays active history without holding socket authentication open',
  { timeout: 5_000 },
  async () => {
    const daemonContext = createRunChannelTestDaemonContext();
    daemonContext.provider.authRuntime.setCachedProviderCredential({
      accessToken: 'recovery-test-access-token',
      refreshToken: 'recovery-test-refresh-token',
      accountId: 'recovery-test-account',
      expiresAt: 0,
    });
    daemonContext.provider.authRuntime.setHydratedProviderAuth(true);
    const socket = createTestSocket();
    const threadId = testThreadId(40);
    const runId = assertRunId('run-active-progress-replay');
    let releaseLoop: () => void = () => {};
    const loopRelease = new Promise<void>((resolve) => {
      releaseLoop = resolve;
    });
    let markLoopStarted: () => void = () => {};
    const loopStarted = new Promise<void>((resolve) => {
      markLoopStarted = resolve;
    });
    const blockingImplementation = {
      implementationId: 'test.blocking-recovery-loop',
      contractVersion: agentLoopKernelImplementation.contractVersion,
      async run() {
        markLoopStarted();
        await loopRelease;
        throw new Error('released blocking recovery loop');
      },
    } satisfies AgentLoopImplementation;
    const recoveryToolCapabilityPolicy = createToolCapabilityPolicy({
      directRegistryNames: ['list_files'],
      allowedRegistryNames: ['list_files', 'read_file'],
      callbackRegistryNames: ['read_file'],
      writeCallbackEnabled: false,
    });
    const resolvedProjection =
      await daemonContext.toolLibraryProjection.resolveProjection({
        stateRoot: daemonContext.homeStateRoot,
        threadId,
        toolCapabilityPolicy: recoveryToolCapabilityPolicy,
      });
    assert.equal(resolvedProjection.ok, true);
    if (!resolvedProjection.ok) {
      assert.fail('expected recovery projection to resolve');
    }
    const toolLibraryProjectionIdentity = getToolLibraryProjectionIdentity(
      resolvedProjection.pin,
    );
    let projectionRehydrationCount = 0;
    let capturedRecoveryToolCapabilityPolicy:
      | ReturnType<typeof createToolCapabilityPolicy>
      | undefined;
    const recoveryAdmission = createAgentLoopImplementationAdmission({
      additionalImplementations: [blockingImplementation],
    });
    const capturingRecoveryAdmission: AgentLoopImplementationAdmission = {
      async admitRun(input) {
        capturedRecoveryToolCapabilityPolicy = input.toolCapabilityPolicy;
        return await recoveryAdmission.admitRun(input);
      },
    };
    const runtimeContext = {
      ...daemonContext,
      toolLibraryProjection: {
        async resolveProjection() {
          assert.fail(
            'durable replay with a recorded identity must not resolve a fresh projection',
          );
        },
        async rehydrateProjectionMount(args) {
          projectionRehydrationCount += 1;
          return await daemonContext.toolLibraryProjection.rehydrateProjectionMount(
            args,
          );
        },
      } satisfies typeof daemonContext.toolLibraryProjection,
      agent: {
        ...daemonContext.agent,
        loopImplementationAdmission: capturingRecoveryAdmission,
      },
    };
    const originalFinishRun = runtimeContext.liveRunEvents.finishRun;
    let markRecoveryFinished: () => void = () => {};
    const recoveryFinished = new Promise<void>((resolve) => {
      markRecoveryFinished = resolve;
    });
    runtimeContext.liveRunEvents.finishRun = (candidateRunId) => {
      originalFinishRun(candidateRunId);
      if (candidateRunId === runId) {
        markRecoveryFinished();
      }
    };

    try {
      await appendTranscriptEntry(runtimeContext.homeStateRoot, threadId, {
        role: 'user',
        content: 'continue after restart',
        timestamp: '2026-07-21T00:00:00.000Z',
      });
      await runtimeContext.runCheckpoints.startRun({
        runId,
        threadId,
        request: {
          workingDirectory: '',
          permissionMode: 'basic',
          loopImplementation: {
            implementationId: blockingImplementation.implementationId,
            contractVersion: blockingImplementation.contractVersion,
          },
          toolCapabilityPolicy: recoveryToolCapabilityPolicy,
          toolLibraryProjectionIdentity,
        },
      });
      await runtimeContext.runCheckpoints.appendRunEvents({
        runId,
        threadId,
        events: [
          {
            seq: 0,
            event: { type: 'run_ack', payload: { runId, threadId } },
          },
        ],
      });

      assert.equal(
        await recoverDurableRunsForSocket(socket, runtimeContext),
        1,
      );
      assert.equal(runtimeContext.activeRuns.getRunById(runId)?.runId, runId);
      assert.equal(socket.sentFrames.length, 1);
      const replayed: unknown = JSON.parse(socket.sentFrames[0] ?? '');
      assert.equal(isRunChannelServerMessage(replayed), true);
      if (
        isRunChannelServerMessage(replayed) &&
        replayed.type === 'run.event'
      ) {
        assert.equal(replayed.event.seq, 0);
        assert.equal(replayed.event.type, 'run_ack');
      }
      await loopStarted;
      assert.deepEqual(
        capturedRecoveryToolCapabilityPolicy,
        recoveryToolCapabilityPolicy,
      );
      assert.equal(projectionRehydrationCount, 1);
    } finally {
      releaseLoop();
      await recoveryFinished;
      runtimeContext.liveRunEvents.finishRun = originalFinishRun;
      cleanupSocketState(socket, runtimeContext);
      await rm(runtimeContext.homeStateRoot, { recursive: true, force: true });
    }
  },
);

void test('executeRunRequest reports conflict_active_run when the thread already has a run', async () => {
  const daemonContext = createRunChannelTestDaemonContext();
  const socket = createTestSocket();
  const threadId = testThreadId(31);
  const existingRun = startManagedRun(
    {
      runId: 'existing-run-start-conflict',
      runContext: {
        threadId,
        stateRoot: daemonContext.homeStateRoot,
        workingDirectory: 'workspace',
      },
    },
    { activeRuns: daemonContext.activeRuns },
  );
  assert.equal(existingRun.ok, true);

  try {
    await executeRunRequest({
      socket,
      requestId: 'run-start-conflict',
      request: {
        prompt: 'hello',
        threadId,
      } satisfies RunRequest,
      allowedPublicToolNames: undefined,
      runtimeContext: daemonContext,
    });

    assert.deepEqual(readLastSentMessage(socket), {
      type: 'run.error',
      requestId: 'run-start-conflict',
      status: 409,
      code: 'conflict_active_run',
      message: `thread ${threadId} already has an active run`,
    });
  } finally {
    if (existingRun.ok) {
      existingRun.finish();
    }
    cleanupSocketState(socket, daemonContext);
  }
});

void test('executeRunRequest deletes consumed prompt refs after active-run conflicts', async () => {
  const stateRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-run-start-prompt-ref-'),
  );
  const daemonContext = createDaemonContext({ homeStateRoot: stateRoot });
  const written = await writeRunPromptInputRefFromStream({
    workspaceRoot: stateRoot,
    input: Readable.from(['stored prompt']),
  });
  const socket = createTestSocket();
  const threadId = testThreadId(33);
  const existingRun = startManagedRun(
    {
      runId: 'existing-run-start-ref-conflict',
      runContext: {
        threadId,
        stateRoot,
        workingDirectory: '',
      },
    },
    { activeRuns: daemonContext.activeRuns },
  );
  assert.equal(existingRun.ok, true);

  try {
    await executeRunRequest({
      socket,
      requestId: 'run-start-ref-conflict',
      request: {
        promptRef: written.promptRef,
        displayPrompt: 'visible prompt',
        threadId,
      } satisfies RunStartRequest,
      allowedPublicToolNames: undefined,
      runtimeContext: daemonContext,
    });

    assert.deepEqual(readLastSentMessage(socket), {
      type: 'run.error',
      requestId: 'run-start-ref-conflict',
      status: 409,
      code: 'conflict_active_run',
      message: `thread ${threadId} already has an active run`,
    });
    assert.deepEqual(
      await readRunPromptInputRef({
        workspaceRoot: stateRoot,
        promptRef: written.promptRef,
      }),
      {
        ok: false,
        code: 'not_found',
        message: 'promptRef was not found.',
      },
    );
  } finally {
    if (existingRun.ok) {
      existingRun.finish();
    }
    cleanupSocketState(socket, daemonContext);
    await rm(stateRoot, { recursive: true, force: true });
  }
});

void test('executeRunRequest logs request context when foreground execution fails', async () => {
  const daemonContext = createRunChannelTestDaemonContext();
  const root = await mkdtemp(join(tmpdir(), 'geulbat-run-start-log-'));
  const fileWorkspaceRoot = join(root, 'workspace-file');
  await writeFile(fileWorkspaceRoot, 'not a directory', 'utf8');
  const socket = createTestSocket();
  const threadId = testThreadId(32);
  const requestId = 'run-start-execute-failure';
  const resolvedProjection =
    await daemonContext.toolLibraryProjection.resolveProjection({
      stateRoot: daemonContext.homeStateRoot,
      threadId,
    });
  assert.equal(resolvedProjection.ok, true);
  if (!resolvedProjection.ok) {
    assert.fail('expected foreground failure projection to resolve');
  }
  const errors: unknown[][] = [];
  const originalError = console.error;
  console.error = (...args: unknown[]) => {
    errors.push(args);
  };

  const runtimeContext = {
    ...daemonContext,
    homeStateRoot: fileWorkspaceRoot,
    computerFileScope: {
      root,
      browseStartPath: '',
      browseShortcuts: [],
    },
    toolLibraryProjection: {
      async resolveProjection() {
        return resolvedProjection;
      },
      async rehydrateProjectionMount(args) {
        return await daemonContext.toolLibraryProjection.rehydrateProjectionMount(
          {
            ...args,
            stateRoot: daemonContext.homeStateRoot,
          },
        );
      },
    } satisfies typeof daemonContext.toolLibraryProjection,
  };

  try {
    await executeRunRequest({
      socket,
      requestId,
      request: {
        prompt: 'hello',
        threadId,
      } satisfies RunRequest,
      allowedPublicToolNames: undefined,
      runtimeContext,
    });

    const executeRunLog = errors.find((entry) =>
      String(entry[0]).includes('[run-channel/execute-run] unexpected error:'),
    );
    assert.ok(executeRunLog);
    const logLine = String(executeRunLog[0]);
    assert.doesNotMatch(logLine, /projectId=/u);
    assert.match(logLine, /requestId="run-start-execute-failure"/);
    assert.match(logLine, new RegExp(`threadId="${threadId}"`, 'u'));

    assert.deepEqual(readLastSentMessage(socket), {
      type: 'run.error',
      requestId,
      status: 500,
      code: 'internal',
      message: 'internal server error',
    });
  } finally {
    console.error = originalError;
    cleanupSocketState(socket, daemonContext);
    await rm(root, { recursive: true, force: true });
  }
});

void test('durable terminal recovery reprojects the thread snapshot and stable done cursor without rerunning', async () => {
  const daemonContext = createRunChannelTestDaemonContext();
  const socket = createTestSocket();
  const threadId = testThreadId(34);
  const runId = assertRunId('run-terminal-reprojection');

  try {
    await appendTranscriptEntry(daemonContext.homeStateRoot, threadId, {
      role: 'assistant',
      content: 'durable final answer',
      timestamp: '2026-07-18T00:00:00.000Z',
      metadata: { phase: 'final_answer', sourceRunId: runId },
    });
    await daemonContext.runCheckpoints.startRun({
      runId,
      threadId,
      request: { workingDirectory: '', permissionMode: 'basic' },
    });
    await daemonContext.runCheckpoints.settleRun({
      runId,
      threadId,
      terminal: {
        eventCursor: 4,
        event: {
          type: 'done',
          payload: { answer: 'durable final answer', ok: true },
        },
      },
    });

    assert.equal(await recoverDurableRunsForSocket(socket, daemonContext), 1);
    const messages = socket.sentFrames.map((raw) => {
      const message: unknown = JSON.parse(raw);
      assert.equal(isRunChannelServerMessage(message), true);
      if (!isRunChannelServerMessage(message)) {
        throw new Error('invalid run channel test message');
      }
      return message;
    });
    assert.equal(messages.length, 2);
    assert.equal(messages[0]?.type, 'run.event');
    assert.equal(messages[1]?.type, 'run.event');
    if (messages[0]?.type === 'run.event') {
      assert.equal(messages[0].event.seq, 3);
      assert.equal(messages[0].event.type, 'thread_state_persisted');
    }
    if (messages[1]?.type === 'run.event') {
      assert.equal(messages[1].event.seq, 4);
      assert.equal(messages[1].event.type, 'done');
      assert.deepEqual(messages[1].event.payload, {
        answer: 'durable final answer',
        ok: true,
      });
    }
  } finally {
    cleanupSocketState(socket, daemonContext);
    await rm(daemonContext.homeStateRoot, { recursive: true, force: true });
  }
});

void test('durable terminal recovery replaces a persisted delta with a full thread snapshot', async () => {
  const daemonContext = createRunChannelTestDaemonContext();
  const socket = createTestSocket();
  const threadId = testThreadId(3401);
  const runId = assertRunId('run-terminal-delta-reprojection');

  try {
    await appendTranscriptEntry(daemonContext.homeStateRoot, threadId, {
      role: 'assistant',
      content: 'full durable answer after reload',
      timestamp: '2026-07-18T00:00:00.000Z',
      metadata: { phase: 'final_answer', sourceRunId: runId },
    });
    await daemonContext.runCheckpoints.startRun({
      runId,
      threadId,
      request: { workingDirectory: '', permissionMode: 'basic' },
    });
    await daemonContext.runCheckpoints.appendRunEvents({
      runId,
      threadId,
      events: [
        {
          seq: 0,
          event: {
            type: 'thread_state_delta_persisted',
            payload: {
              threadId,
              snapshotVersion: '2026-07-18T00:00:00.000Z',
              baseEntryId: 'entry-that-a-reloaded-client-does-not-have',
              messages: [],
              artifacts: [],
            },
          },
        },
      ],
    });
    await daemonContext.runCheckpoints.settleRun({
      runId,
      threadId,
      terminal: {
        eventCursor: 1,
        event: {
          type: 'done',
          payload: { answer: 'full durable answer after reload', ok: true },
        },
      },
    });

    assert.equal(await recoverDurableRunsForSocket(socket, daemonContext), 1);
    const messages = socket.sentFrames.map((raw) => {
      const message: unknown = JSON.parse(raw);
      assert.equal(isRunChannelServerMessage(message), true);
      if (!isRunChannelServerMessage(message)) {
        throw new Error('invalid run channel test message');
      }
      return message;
    });
    assert.equal(messages.length, 2);
    const snapshotMessage = messages[0];
    assert.equal(snapshotMessage?.type, 'run.event');
    if (snapshotMessage?.type === 'run.event') {
      assert.equal(snapshotMessage.event.seq, 0);
      assert.equal(snapshotMessage.event.type, 'thread_state_persisted');
      if (snapshotMessage.event.type === 'thread_state_persisted') {
        assert.equal(
          snapshotMessage.event.payload.messages[0]?.content,
          'full durable answer after reload',
        );
      }
    }
  } finally {
    cleanupSocketState(socket, daemonContext);
    await rm(daemonContext.homeStateRoot, { recursive: true, force: true });
  }
});

void test('durable terminal recovery accepts a successful terminal cursor without a reserved snapshot slot', async () => {
  const daemonContext = createRunChannelTestDaemonContext();
  const socket = createTestSocket();
  const threadId = testThreadId(41);
  const runId = assertRunId('run-terminal-without-snapshot-slot');

  try {
    await daemonContext.runCheckpoints.startRun({
      runId,
      threadId,
      request: { workingDirectory: '', permissionMode: 'basic' },
    });
    await daemonContext.runCheckpoints.appendRunEvents({
      runId,
      threadId,
      events: [
        {
          seq: 0,
          event: { type: 'run_ack', payload: { runId, threadId } },
        },
        {
          seq: 1,
          event: {
            type: 'final_answer_delta',
            payload: { text: 'answer before terminal persistence' },
          },
        },
      ],
    });
    await daemonContext.runCheckpoints.settleRun({
      runId,
      threadId,
      terminal: {
        eventCursor: 2,
        event: {
          type: 'done',
          payload: { answer: 'answer before terminal persistence', ok: true },
        },
      },
    });

    assert.equal(await recoverDurableRunsForSocket(socket, daemonContext), 1);
    const runEvents = socket.sentFrames.map((raw) => {
      const message: unknown = JSON.parse(raw);
      assert.equal(isRunChannelServerMessage(message), true);
      if (!isRunChannelServerMessage(message) || message.type !== 'run.event') {
        throw new Error('invalid run channel test message');
      }
      return { seq: message.event.seq, type: message.event.type };
    });
    assert.deepEqual(runEvents, [
      { seq: 0, type: 'run_ack' },
      { seq: 1, type: 'final_answer_delta' },
      { seq: 2, type: 'done' },
    ]);
  } finally {
    cleanupSocketState(socket, daemonContext);
    await rm(daemonContext.homeStateRoot, { recursive: true, force: true });
  }
});

void test('durable terminal recovery replays journaled progress after the client cursor', async () => {
  const daemonContext = createRunChannelTestDaemonContext();
  const socket = createTestSocket();
  const threadId = testThreadId(39);
  const runId = assertRunId('run-terminal-progress-replay');

  try {
    await daemonContext.runCheckpoints.startRun({
      runId,
      threadId,
      request: { workingDirectory: '', permissionMode: 'basic' },
    });
    await daemonContext.runCheckpoints.appendRunEvents({
      runId,
      threadId,
      events: [
        {
          seq: 0,
          event: { type: 'run_ack', payload: { runId, threadId } },
        },
        {
          seq: 1,
          event: {
            type: 'commentary_delta',
            payload: { text: 'survived restart' },
          },
        },
      ],
    });
    await daemonContext.runCheckpoints.settleRun({
      runId,
      threadId,
      terminal: {
        eventCursor: 2,
        event: {
          type: 'error',
          payload: { code: 'internal', message: 'durable failure' },
        },
      },
    });

    assert.equal(
      await recoverDurableRunsForSocket(socket, daemonContext, [
        { runId, seq: 0 },
      ]),
      1,
    );
    const runEvents: Array<{ seq: number; type: string }> = [];
    for (const raw of socket.sentFrames) {
      const message: unknown = JSON.parse(raw);
      assert.equal(isRunChannelServerMessage(message), true);
      if (isRunChannelServerMessage(message) && message.type === 'run.event') {
        runEvents.push({ seq: message.event.seq, type: message.event.type });
      }
    }
    assert.deepEqual(runEvents, [
      { seq: 1, type: 'commentary_delta' },
      { seq: 2, type: 'error' },
    ]);
  } finally {
    cleanupSocketState(socket, daemonContext);
    await rm(daemonContext.homeStateRoot, { recursive: true, force: true });
  }
});

void test('durable recovery reconciles an already persisted final answer before model or tool recovery', async () => {
  const daemonContext = createRunChannelTestDaemonContext();
  const socket = createTestSocket();
  const threadId = testThreadId(35);
  const runId = assertRunId('run-transcript-terminal-reconcile');

  try {
    await appendTranscriptEntry(daemonContext.homeStateRoot, threadId, {
      role: 'user',
      content: 'finish once',
      timestamp: '2026-07-18T00:00:00.000Z',
    });
    await appendTranscriptEntry(daemonContext.homeStateRoot, threadId, {
      role: 'assistant',
      content: 'already committed',
      timestamp: '2026-07-18T00:00:01.000Z',
      metadata: { phase: 'final_answer', sourceRunId: runId },
    });
    await daemonContext.runCheckpoints.startRun({
      runId,
      threadId,
      request: { workingDirectory: '', permissionMode: 'basic' },
    });
    await daemonContext.runCheckpoints.appendRunEvents({
      runId,
      threadId,
      events: [
        {
          seq: 0,
          event: { type: 'run_ack', payload: { runId, threadId } },
        },
      ],
    });

    assert.equal(await recoverDurableRunsForSocket(socket, daemonContext), 1);
    const checkpoint = await daemonContext.runCheckpoints.readThread(threadId);
    assert.equal(checkpoint?.status, 'terminal');
    assert.deepEqual(checkpoint?.terminal, {
      eventCursor: 2,
      acknowledged: false,
      event: {
        type: 'done',
        payload: { answer: 'already committed', ok: true },
      },
    });
    assert.equal(socket.sentFrames.length, 3);
    const replayedMessage: unknown = JSON.parse(socket.sentFrames[0] ?? '');
    assert.equal(isRunChannelServerMessage(replayedMessage), true);
    if (
      isRunChannelServerMessage(replayedMessage) &&
      replayedMessage.type === 'run.event'
    ) {
      assert.equal(replayedMessage.event.seq, 0);
      assert.equal(replayedMessage.event.type, 'run_ack');
    }
    const terminalMessage: unknown = JSON.parse(socket.sentFrames[2] ?? '');
    assert.equal(isRunChannelServerMessage(terminalMessage), true);
    if (
      isRunChannelServerMessage(terminalMessage) &&
      terminalMessage.type === 'run.event'
    ) {
      assert.equal(terminalMessage.event.seq, 2);
      assert.equal(terminalMessage.event.type, 'done');
    }
  } finally {
    cleanupSocketState(socket, daemonContext);
    await rm(daemonContext.homeStateRoot, { recursive: true, force: true });
  }
});

void test('durable Goal recovery surfaces interrupted completion admission without rerunning the model', async () => {
  const homeStateRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-goal-verification-recovery-'),
  );
  const beforeRestart = createDaemonContext({ homeStateRoot });
  const threadId = testThreadId(42);
  const runId = assertRunId('run-goal-verification-recovery');
  const socket = createTestSocket();
  let afterRestart: ReturnType<typeof createDaemonContext> | undefined;

  try {
    const goal = await beforeRestart.goals.enterOrResume({
      threadId,
      requested: true,
      objective: 'Recover Goal completion admission safely',
      executionTemplate: {
        workingDirectory: '',
        permissionMode: 'basic',
      },
    });
    assert.ok(goal);
    await beforeRestart.goals.requestCompletion({
      threadId,
      goalId: goal.goalId,
      runId,
    });
    await beforeRestart.runCheckpoints.startRun({
      runId,
      threadId,
      request: {
        workingDirectory: '',
        permissionMode: 'basic',
        goal: { goalId: goal.goalId },
      },
    });

    afterRestart = createDaemonContext({ homeStateRoot });
    assert.equal(await recoverDurableRunsForSocket(socket, afterRestart), 1);
    let checkpoint = await afterRestart.runCheckpoints.readThread(threadId);
    for (
      let attempt = 0;
      attempt < 50 && checkpoint?.status !== 'terminal';
      attempt += 1
    ) {
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
      checkpoint = await afterRestart.runCheckpoints.readThread(threadId);
    }
    assert.equal(checkpoint?.status, 'terminal');
    assert.equal(checkpoint?.terminal?.event.type, 'error');
    if (checkpoint?.terminal?.event.type === 'error') {
      assert.deepEqual(checkpoint.terminal.event.payload, {
        code: 'execution_failed',
        message:
          'Goal completion admission is unavailable after daemon recovery',
      });
    }

    const events = socket.sentFrames.flatMap((raw) => {
      const message: unknown = JSON.parse(raw);
      assert.equal(isRunChannelServerMessage(message), true);
      return isRunChannelServerMessage(message) && message.type === 'run.event'
        ? [message.event]
        : [];
    });
    assert.deepEqual(
      events.map((event) => event.type),
      ['goal_updated', 'error'],
    );
    assert.equal(events[0]?.type, 'goal_updated');
    if (events[0]?.type === 'goal_updated') {
      assert.equal(events[0].payload.state, 'verification_unavailable');
      assert.equal('votes' in events[0].payload, false);
    }
  } finally {
    cleanupSocketState(socket, afterRestart ?? beforeRestart);
    await rm(homeStateRoot, { recursive: true, force: true });
  }
});

void test('daemon startup reconciles a persisted final answer without waiting for a client socket', async () => {
  const homeStateRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-run-startup-recovery-'),
  );
  const beforeRestart = createDaemonContext({ homeStateRoot });
  const threadId = testThreadId(38);
  const runId = assertRunId('run-startup-transcript-terminal-reconcile');
  const activeBeforeRestart = startManagedRun(
    {
      runId,
      runContext: {
        threadId,
        stateRoot: homeStateRoot,
        workingDirectory: '',
      },
    },
    { activeRuns: beforeRestart.activeRuns },
  );
  assert.equal(activeBeforeRestart.ok, true);

  try {
    await appendTranscriptEntry(homeStateRoot, threadId, {
      role: 'assistant',
      content: 'already durable before reconnect',
      timestamp: '2026-07-21T00:00:00.000Z',
      metadata: { phase: 'final_answer', sourceRunId: runId },
    });
    await beforeRestart.runCheckpoints.startRun({
      runId,
      threadId,
      request: { workingDirectory: '', permissionMode: 'basic' },
    });

    const afterRestart = createDaemonContext({ homeStateRoot });
    assert.equal(afterRestart.activeRuns.getRunById(runId), undefined);
    assert.equal(await recoverDurableRunsAtDaemonStartup(afterRestart), 1);
    const checkpoint = await afterRestart.runCheckpoints.readThread(threadId);
    assert.equal(checkpoint?.status, 'terminal');
    assert.equal(checkpoint?.revision, 2);
    assert.deepEqual(checkpoint?.request, {
      workingDirectory: '',
      permissionMode: 'basic',
    });
    assert.deepEqual(checkpoint?.terminal, {
      eventCursor: 1,
      acknowledged: false,
      event: {
        type: 'done',
        payload: {
          answer: 'already durable before reconnect',
          ok: true,
        },
      },
    });
    assert.equal(afterRestart.liveRunEvents.hasRun(runId), false);
    assert.equal(afterRestart.activeRuns.getRunById(runId), undefined);
  } finally {
    if (activeBeforeRestart.ok) {
      activeBeforeRestart.finish();
    }
    await rm(homeStateRoot, { recursive: true, force: true });
  }
});

void test('durable terminal recovery reprojects exact terminal errors without a false success snapshot', async () => {
  const daemonContext = createRunChannelTestDaemonContext();
  const socket = createTestSocket();
  const threadId = testThreadId(36);
  const runId = assertRunId('run-terminal-error-reprojection');

  try {
    await daemonContext.runCheckpoints.startRun({
      runId,
      threadId,
      request: { workingDirectory: '', permissionMode: 'basic' },
    });
    await daemonContext.runCheckpoints.settleRun({
      runId,
      threadId,
      terminal: {
        eventCursor: 3,
        event: {
          type: 'error',
          payload: { code: 'internal', message: 'durable failure' },
        },
      },
    });

    assert.equal(await recoverDurableRunsForSocket(socket, daemonContext), 1);
    assert.equal(socket.sentFrames.length, 1);
    const message: unknown = JSON.parse(socket.sentFrames[0] ?? '');
    assert.equal(isRunChannelServerMessage(message), true);
    if (isRunChannelServerMessage(message) && message.type === 'run.event') {
      assert.equal(message.event.seq, 3);
      assert.equal(message.event.type, 'error');
      assert.deepEqual(message.event.payload, {
        code: 'internal',
        message: 'durable failure',
      });
    }
  } finally {
    cleanupSocketState(socket, daemonContext);
    await rm(daemonContext.homeStateRoot, { recursive: true, force: true });
  }
});
