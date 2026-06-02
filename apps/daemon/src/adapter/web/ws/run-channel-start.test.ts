import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { RunRequest } from '@geulbat/protocol/run-contract';
import type { ThreadId } from '@geulbat/protocol/ids';

import { bootstrapDaemonContext } from '../../../bootstrap-daemon-context.js';
import { createDaemonContext } from '../../../daemon/context.js';
import { startManagedRun } from '../../../daemon/agent/runtime/managed-run.js';
import {
  cleanupSocketState,
  getSocketState,
} from './run-channel-socket-runtime.js';
import {
  createTestSocket,
  readLastSentMessage,
} from './run-channel-test-support.js';
import { executeRunRequest } from './run-channel-start.js';
import { testProjectId } from '../../../test-support/project-id.js';
import { testThreadId } from '../../../test-support/thread-id.js';

void test('executeRunRequest rejects blank prompts', async () => {
  const daemonContext = createDaemonContext();
  await bootstrapDaemonContext({
    projectStore: daemonContext.projectStore,
    repoRoot: process.cwd(),
  });
  const socket = createTestSocket();

  try {
    await executeRunRequest({
      socket,
      requestId: 'run-start-blank-prompt',
      request: {
        prompt: '   ',
        projectId: testProjectId(),
      },
      allowedToolNames: undefined,
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

void test('executeRunRequest rejects unknown projects before starting a run', async () => {
  const daemonContext = createDaemonContext();
  await bootstrapDaemonContext({
    projectStore: daemonContext.projectStore,
    repoRoot: process.cwd(),
  });
  const socket = createTestSocket();

  try {
    await executeRunRequest({
      socket,
      requestId: 'run-start-unknown-project',
      request: {
        prompt: 'hello',
        projectId: 'missing-project' as ReturnType<typeof testProjectId>,
      },
      allowedToolNames: undefined,
      runtimeContext: daemonContext,
    });

    assert.deepEqual(readLastSentMessage(socket), {
      type: 'run.error',
      requestId: 'run-start-unknown-project',
      status: 404,
      code: 'not_found',
      message: 'unknown projectId: missing-project',
    });
  } finally {
    cleanupSocketState(socket, daemonContext);
  }
});

void test('executeRunRequest rejects malformed thread ids', async () => {
  const daemonContext = createDaemonContext();
  await bootstrapDaemonContext({
    projectStore: daemonContext.projectStore,
    repoRoot: process.cwd(),
  });
  const socket = createTestSocket();

  try {
    await executeRunRequest({
      socket,
      requestId: 'run-start-invalid-thread',
      request: {
        prompt: 'hello',
        projectId: testProjectId(),
        threadId: '../bad-thread' as unknown as ThreadId,
      },
      allowedToolNames: undefined,
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
  const daemonContext = createDaemonContext();
  await bootstrapDaemonContext({
    projectStore: daemonContext.projectStore,
    repoRoot: process.cwd(),
  });
  const socket = createTestSocket();
  const socketState = getSocketState(socket);
  socketState.closed = true;

  try {
    await executeRunRequest({
      socket,
      requestId: 'run-start-closed-socket',
      request: {
        prompt: 'hello',
        projectId: testProjectId(),
      },
      allowedToolNames: undefined,
      runtimeContext: daemonContext,
    });

    assert.equal(readLastSentMessage(socket), undefined);
    assert.equal(socketState.activeRunIds.size, 0);
  } finally {
    cleanupSocketState(socket, daemonContext);
  }
});

void test('executeRunRequest reports conflict_active_run when the thread already has a run', async () => {
  const daemonContext = createDaemonContext();
  await bootstrapDaemonContext({
    projectStore: daemonContext.projectStore,
    repoRoot: process.cwd(),
  });
  const socket = createTestSocket();
  const threadId = testThreadId(31);
  const existingRun = startManagedRun(
    {
      runId: 'existing-run-start-conflict',
      runContext: {
        threadId,
        projectId: testProjectId(),
        workspaceRoot: resolve(process.cwd(), 'workspace'),
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
        projectId: testProjectId(),
        threadId,
      } satisfies RunRequest,
      allowedToolNames: undefined,
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

void test('executeRunRequest logs request context when foreground execution fails', async () => {
  const daemonContext = createDaemonContext();
  await bootstrapDaemonContext({
    projectStore: daemonContext.projectStore,
    repoRoot: process.cwd(),
  });
  const root = await mkdtemp(join(tmpdir(), 'geulbat-run-start-log-'));
  const fileWorkspaceRoot = join(root, 'workspace-file');
  await writeFile(fileWorkspaceRoot, 'not a directory', 'utf8');
  const socket = createTestSocket();
  const threadId = testThreadId(32);
  const requestId = 'run-start-execute-failure';
  const errors: unknown[][] = [];
  const originalError = console.error;
  console.error = (...args: unknown[]) => {
    errors.push(args);
  };

  const runtimeContext = {
    ...daemonContext,
    projectRegistry: {
      isKnownProjectId(projectId: string): boolean {
        return projectId === testProjectId();
      },
      resolveProjectRoot(projectId: string): string | null {
        return projectId === testProjectId() ? fileWorkspaceRoot : null;
      },
    },
  };

  try {
    await executeRunRequest({
      socket,
      requestId,
      request: {
        prompt: 'hello',
        projectId: testProjectId(),
        threadId,
      } satisfies RunRequest,
      allowedToolNames: undefined,
      runtimeContext,
    });

    const executeRunLog = errors.find((entry) =>
      String(entry[0]).includes('[run-channel/execute-run] unexpected error:'),
    );
    assert.ok(executeRunLog);
    const logLine = String(executeRunLog[0]);
    assert.match(logLine, /projectId="workspace"/);
    assert.match(logLine, /requestId="run-start-execute-failure"/);
    assert.match(logLine, new RegExp(`threadId="${threadId}"`, 'u'));

    const message = readLastSentMessage(socket);
    assert.equal(message?.type, 'run.event');
    if (message?.type === 'run.event') {
      assert.equal(message.event.threadId, threadId);
      assert.equal(message.event.type, 'error');
      assert.deepEqual(message.event.payload, {
        code: 'internal',
        message: 'internal server error',
      });
    }
  } finally {
    console.error = originalError;
    cleanupSocketState(socket, daemonContext);
    await rm(root, { recursive: true, force: true });
  }
});
