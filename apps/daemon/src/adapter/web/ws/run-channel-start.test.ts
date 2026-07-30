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
import type { ThreadId } from '@geulbat/protocol/ids';
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
import { startManagedRun } from '../../../daemon/agent/runtime/managed-run.js';
import {
  readRunPromptInputRef,
  writeRunPromptInputRefFromStream,
} from '../../../daemon/sessions/prompt-input-ref-store.js';
import {
  cleanupSocketState,
  getSocketState,
} from './run-channel-socket-runtime.js';
import {
  createRunChannelTestDaemonContext,
  createTestSocket,
  readLastSentMessage,
} from '../../../test-support/run-channel-test-support.js';
import { executeRunRequest } from './run-channel-start.js';
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
      await input.ports.settleTerminal({ result, source: 'blocked' });
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
