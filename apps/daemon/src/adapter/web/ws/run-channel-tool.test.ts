import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';
import type { RunId } from '@geulbat/protocol/ids';
import type {
  RunToolRequest,
  RunToolResultPayload,
} from '@geulbat/protocol/run-channel';

import {
  createTestSocket,
  readLastSentMessage,
} from '../../../test-support/run-channel-test-support.js';
import { makeRunContext } from '../../../test-support/run-context.js';
import { testThreadId } from '../../../test-support/thread-id.js';
import {
  createDaemonContext,
  type DaemonContext,
} from '../../../daemon/context.js';
import { createRunInterjectBuffer } from '../../../daemon/sessions/active-run-interject-buffer.js';
import type { RunChannelRuntimeContext } from './run-channel-runtime-context.js';
import { handleClientMessage } from './run-channel-dispatch.js';
import {
  cleanupSocketState,
  getSocketState,
} from './run-channel-socket-runtime.js';
import { handleRunTool } from './run-channel-tool.js';

function readRunToolControlResult(
  socket: ReturnType<typeof createTestSocket>,
  requestId: string,
): RunToolResultPayload {
  const message = readLastSentMessage(socket);
  if (message?.type !== 'run.control' || message.action !== 'run.tool') {
    assert.fail(
      `expected run.tool control response: ${JSON.stringify(message)}`,
    );
  }
  assert.equal(message.requestId, requestId);
  assert.equal(message.ok, true);
  return message.result;
}

void describe('handleRunTool', () => {
  let daemonContext: DaemonContext;
  let root: string;
  let socket: ReturnType<typeof createTestSocket>;
  let workspaceRoot: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'geulbat-run-tool-'));
    workspaceRoot = join(root, 'workspace');
    await mkdir(workspaceRoot);
    daemonContext = createDaemonContext({
      homeStateRoot: join(root, 'home'),
    });
    socket = createTestSocket();
  });

  afterEach(async () => {
    cleanupSocketState(socket, daemonContext);
    await rm(root, { force: true, recursive: true });
  });

  void test('rejects malformed frame requests before dispatch', async () => {
    await handleRunTool(socket, 'tool-invalid', null, daemonContext);

    assert.deepEqual(readLastSentMessage(socket), {
      type: 'run.error',
      requestId: 'tool-invalid',
      status: 400,
      code: 'invalid_args',
      message: 'request must be an object',
    });
  });

  void test('requires a computer file scope for idle frame calls', async () => {
    const runtimeContext: RunChannelRuntimeContext = { ...daemonContext };
    delete runtimeContext.computerFileScope;

    await handleRunTool(
      socket,
      'tool-no-root',
      {
        threadId: testThreadId(701),
        toolName: 'list_files',
        args: {},
        scopeHandle: 'scope-no-root',
        frameRequestId: 'af-no-root',
        workingDirectory: workspaceRoot,
      } satisfies RunToolRequest,
      runtimeContext,
    );

    assert.deepEqual(readLastSentMessage(socket), {
      type: 'run.error',
      requestId: 'tool-no-root',
      status: 404,
      code: 'not_found',
      message: 'computer file root is unavailable',
    });
  });

  void test('uses the Computer root when an idle frame omits workingDirectory', async () => {
    assert.ok(daemonContext.computerFileScope);
    const computerFileScope = { ...daemonContext.computerFileScope };
    delete computerFileScope.browseStartPath;

    await handleRunTool(
      socket,
      'tool-default-root',
      {
        threadId: testThreadId(706),
        toolName: 'list_files',
        args: {},
        scopeHandle: 'scope-default-root',
        frameRequestId: 'af-default-root',
      } satisfies RunToolRequest,
      { ...daemonContext, computerFileScope },
    );

    assert.equal(
      readRunToolControlResult(socket, 'tool-default-root').ok,
      true,
    );
  });

  void test('maps unusable idle frame working directories before tool dispatch', async () => {
    const regularFile = join(root, 'regular-file.txt');
    await writeFile(regularFile, 'not a directory', 'utf8');

    await handleRunTool(
      socket,
      'tool-missing-cwd',
      {
        threadId: testThreadId(707),
        toolName: 'list_files',
        args: {},
        scopeHandle: 'scope-missing-cwd',
        frameRequestId: 'af-missing-cwd',
        workingDirectory: join(root, 'missing'),
      } satisfies RunToolRequest,
      daemonContext,
    );
    assert.deepEqual(readLastSentMessage(socket), {
      type: 'run.error',
      requestId: 'tool-missing-cwd',
      status: 404,
      code: 'not_found',
      message: 'working directory not found',
    });

    await handleRunTool(
      socket,
      'tool-file-cwd',
      {
        threadId: testThreadId(708),
        toolName: 'list_files',
        args: {},
        scopeHandle: 'scope-file-cwd',
        frameRequestId: 'af-file-cwd',
        workingDirectory: regularFile,
      } satisfies RunToolRequest,
      daemonContext,
    );
    assert.deepEqual(readLastSentMessage(socket), {
      type: 'run.error',
      requestId: 'tool-file-cwd',
      status: 400,
      code: 'bad_request',
      message: 'workingDirectory must name a directory',
    });
  });

  void test('runs an admitted read-only tool through the real artifact frame runtime', async () => {
    await writeFile(join(workspaceRoot, 'visible.txt'), 'visible', 'utf8');

    getSocketState(socket).authenticated = true;

    await handleClientMessage(
      socket,
      JSON.stringify({
        type: 'run.tool',
        requestId: 'tool-list',
        request: {
          threadId: testThreadId(702),
          toolName: 'list_files',
          args: {},
          scopeHandle: 'scope-list',
          frameRequestId: 'af-list',
          workingDirectory: workspaceRoot,
        } satisfies RunToolRequest,
      }),
      daemonContext,
    );

    const result = readRunToolControlResult(socket, 'tool-list');
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.match(result.output, /visible\.txt/u);
    }
  });

  void test('returns unknown artifact-frame tools as data', async () => {
    await handleRunTool(
      socket,
      'tool-unknown',
      {
        threadId: testThreadId(709),
        toolName: 'not_a_registered_tool',
        args: {},
        scopeHandle: 'scope-unknown',
        frameRequestId: 'af-unknown',
        workingDirectory: workspaceRoot,
      } satisfies RunToolRequest,
      daemonContext,
    );

    const result = readRunToolControlResult(socket, 'tool-unknown');
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.errorCode, 'approval_required');
      assert.match(
        result.error,
        /outside the artifact frame callback surface/u,
      );
    }
  });

  void test('returns invalid tool arguments as frame-visible data', async () => {
    await handleRunTool(
      socket,
      'tool-invalid-args',
      {
        threadId: testThreadId(703),
        toolName: 'list_files',
        args: { recursive: 'yes' },
        scopeHandle: 'scope-invalid-args',
        frameRequestId: 'af-invalid-args',
        workingDirectory: workspaceRoot,
      } satisfies RunToolRequest,
      daemonContext,
    );

    const result = readRunToolControlResult(socket, 'tool-invalid-args');
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.errorCode, 'invalid_args');
    }
  });

  void test('keeps mutating tools behind the artifact frame approval boundary', async () => {
    const blockedPath = join(workspaceRoot, 'blocked.txt');

    await handleRunTool(
      socket,
      'tool-write',
      {
        threadId: testThreadId(704),
        toolName: 'write_file',
        args: { path: 'blocked.txt', content: 'must not be written' },
        scopeHandle: 'scope-write',
        frameRequestId: 'af-write',
        workingDirectory: workspaceRoot,
      } satisfies RunToolRequest,
      daemonContext,
    );

    const result = readRunToolControlResult(socket, 'tool-write');
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.errorCode, 'approval_required');
    }
    await assert.rejects(access(blockedPath));
  });

  void test('uses the active run working directory instead of a frame override', async () => {
    const activeRoot = join(root, 'active');
    const ignoredRoot = join(root, 'ignored');
    await Promise.all([mkdir(activeRoot), mkdir(ignoredRoot)]);
    await Promise.all([
      writeFile(join(activeRoot, 'active.txt'), 'active', 'utf8'),
      writeFile(join(ignoredRoot, 'ignored.txt'), 'ignored', 'utf8'),
    ]);
    const threadId = testThreadId(705);
    const runId = 'run-tool-active' as RunId;
    const abortController = new AbortController();
    assert.deepEqual(
      daemonContext.activeRuns.tryStartRun(threadId, {
        runId,
        ...makeRunContext({
          threadId,
          stateRoot: daemonContext.homeStateRoot,
          workingDirectory: activeRoot,
        }),
        ownerThreadId: threadId,
        abortController,
        interject: createRunInterjectBuffer(),
        startedAt: '2026-07-19T00:00:00.000Z',
      }),
      { ok: true },
    );

    try {
      await handleRunTool(
        socket,
        'tool-active-cwd',
        {
          threadId,
          toolName: 'list_files',
          args: {},
          scopeHandle: 'scope-active-cwd',
          frameRequestId: 'af-active-cwd',
          workingDirectory: ignoredRoot,
        } satisfies RunToolRequest,
        daemonContext,
      );

      const result = readRunToolControlResult(socket, 'tool-active-cwd');
      assert.equal(result.ok, true);
      if (result.ok) {
        assert.match(result.output, /active\.txt/u);
        assert.doesNotMatch(result.output, /ignored\.txt/u);
      }

      abortController.abort();
      await handleRunTool(
        socket,
        'tool-aborted-cwd',
        {
          threadId,
          toolName: 'list_files',
          args: {},
          scopeHandle: 'scope-aborted-cwd',
          frameRequestId: 'af-aborted-cwd',
          workingDirectory: ignoredRoot,
        } satisfies RunToolRequest,
        daemonContext,
      );

      const abortedResult = readRunToolControlResult(
        socket,
        'tool-aborted-cwd',
      );
      assert.equal(abortedResult.ok, true);
      if (abortedResult.ok) {
        assert.match(abortedResult.output, /ignored\.txt/u);
        assert.doesNotMatch(abortedResult.output, /active\.txt/u);
      }
    } finally {
      daemonContext.activeRuns.finishRun(threadId, runId);
    }
  });
});
