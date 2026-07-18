import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import {
  createPtcSessionDockerCommandFixture,
  readPtcSessionDockerBindMountHostPath,
} from '../../../test-support/ptc-session-docker.js';
import { testThreadId } from '../../../test-support/thread-id.js';
import { createDaemonContext } from '../../context.js';
import { createAgentLoopToolDefinitionPort } from '../../agent/loop-tool-definitions.js';
import { createPtcExecuteCodePlacementCoordinator } from '../../ptc/runtime/execute-code/execute-code-placement.js';
import { readPtcExecuteCodePlacementPreflightRecord } from '../../ptc/runtime/execute-code/execute-code-placement-contract.js';
import {
  createPtcSessionDockerLocalBatchCommandPolicy,
  PTC_SESSION_DOCKER_SDK_CONTAINER_ROOT,
} from '../../ptc/lab/session/session-docker-contract.js';
import {
  startPtcDockerClientProcess,
  type DetachedProcessExitInfo,
} from '../../ptc/shared/process-command.js';
import { executeTool } from '../executor.js';
import type { CallbackToolDispatcher } from '../types.js';
import { executeCodeTool } from './execute-code.js';
import { waitTool } from './wait.js';

const TEST_CALLBACK_TRANSPORT_POLICY = Object.freeze({
  maxFrameBytes: 8192,
  maxOpenConnections: 4,
  maxCallbacks: 20,
  callbackTimeoutMs: 30_000,
  maxResponseBytes: 8192,
});
const TEST_INITIAL_YIELD_MS = 1_000;
const TEST_RUNNING_CELL_REAP_AFTER_MS = 60_000;
const TEST_CALLBACK_DELAY_MS = 1_200;

void test('WO6-V3 removed search_memory_index stays usable through the pinned multi-tool SDK and detached wait', async () => {
  const computerFileRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-ptc-wo6-v1-computer-files-'),
  );
  const stateRoot = await mkdtemp(join(tmpdir(), 'geulbat-ptc-wo6-v1-state-'));
  const runtimeRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-ptc-wo6-v1-runtime-'),
  );
  const threadId = testThreadId(961);
  const events: string[] = [];
  let detachedExit: Promise<DetachedProcessExitInfo> | undefined;
  let resolvePlacementReleased: (() => void) | undefined;
  const placementReleased = new Promise<void>((resolve) => {
    resolvePlacementReleased = resolve;
  });
  let fixture: ReturnType<typeof createPtcSessionDockerCommandFixture>;
  fixture = createPtcSessionDockerCommandFixture({
    policy: createPtcSessionDockerLocalBatchCommandPolicy(),
    containerId: 'container-agent-ptc-wo6-v1',
  });
  const daemonContext = createDaemonContext({
    ptcExecuteCodeRuntimeOptions: {
      callbackTransportPolicy: TEST_CALLBACK_TRANSPORT_POLICY,
      commandRunner: fixture.runner,
      createPlacementCoordinator() {
        const owner = createPtcExecuteCodePlacementCoordinator();
        return {
          async acquirePlacement(args) {
            events.push('placement:acquire');
            const placementResult = await owner.acquirePlacement(args);
            assert.equal(placementResult.ok, true);
            if (!placementResult.ok || 'queued' in placementResult) {
              return placementResult;
            }
            const placement = placementResult.value;
            const preflight =
              readPtcExecuteCodePlacementPreflightRecord(placement);
            assert.equal(placement.kind, 'warm_session');
            assert.equal(placement.lease.generation, 1);
            assert.equal(placement.lease.shutdownEpoch, 0);
            assert.equal(placement.lease.ownerThreadId, threadId);
            assert.equal(preflight.burstEligible, true);
            assert.equal(preflight.selectedLane, 'warm_session');
            assert.equal(preflight.reason, 'burst_not_enabled_yet');
            return placementResult;
          },
          async releasePlacement(placement) {
            await owner.releasePlacement(placement);
            events.push('placement:release');
            resolvePlacementReleased?.();
          },
          beginShutdown() {
            owner.beginShutdown();
          },
          finishShutdown() {
            owner.finishShutdown();
          },
        };
      },
      getPlacementContinuityProvenance(args) {
        assert.equal(args.kind, 'detached_cell');
        return { independenceProof: { reason: 'read_only_analysis' } };
      },
      packageInstall: { enabled: false },
      ptcCell: {
        enabled: true,
        initialYieldTimeMs: TEST_INITIAL_YIELD_MS,
        runningCellReapAfterMs: TEST_RUNNING_CELL_REAP_AFTER_MS,
      },
      runtimeRootForState: () => runtimeRoot,
      startCellProcess(invocation) {
        assert.deepEqual(events, ['placement:acquire']);
        const command = invocation.args.at(-1);
        assert.ok(command);
        const createInvocation = [...fixture.invocations]
          .reverse()
          .find((candidate) => candidate.args[0] === 'create');
        assert.ok(createInvocation);
        const callbackHostRoot = readPtcSessionDockerBindMountHostPath(
          createInvocation,
          '/geulbat/callbacks',
        );
        const sdkHostRoot = readPtcSessionDockerBindMountHostPath(
          createInvocation,
          PTC_SESSION_DOCKER_SDK_CONTAINER_ROOT,
        );
        events.push('process:start');
        const started = startPtcDockerClientProcess({
          ...invocation,
          executable: '/bin/bash',
          args: [
            '-c',
            remapEncodedExecuteCodeCallbackRoot(
              command,
              callbackHostRoot,
              sdkHostRoot,
            ),
          ],
        });
        if (started.ok) {
          detachedExit = started.handle.exit;
        }
        return started;
      },
      store: {
        enabled: true,
        maxKeys: 32,
        maxValueBytes: 4_096,
        maxTotalBytes: 32_768,
      },
    },
  });
  const callbackToolDispatcher: CallbackToolDispatcher = {
    async dispatch({ toolName, args, runtimeToolCallId, cellId, signal }) {
      assert.equal(
        ['read_file', 'search_memory_index'].includes(toolName),
        true,
      );
      assert.equal(typeof cellId, 'string');
      events.push(`callback:${toolName}`);
      if (toolName === 'read_file') {
        await delay(TEST_CALLBACK_DELAY_MS);
      }
      return await executeTool(
        toolName,
        args,
        {
          callId: runtimeToolCallId,
          computerFileRoot,
          threadId,
          stateRoot,
          workingDirectory: '',
          signal,
          runSignal: signal,
          fileStateCache: daemonContext.fileStateCache,
          memoryIndex: daemonContext.memoryIndex,
        },
        { toolRegistry: daemonContext.toolRegistry },
      );
    },
  };

  try {
    await mkdir(join(computerFileRoot, 'docs'), { recursive: true });
    await writeFile(
      join(computerFileRoot, 'docs', 'note.txt'),
      'WO6-V3 callback reached the real searchable memory tool.\n',
      'utf8',
    );
    await daemonContext.memoryIndex.refreshMemoryIndex({
      stateRoot,
      sourceRoot: computerFileRoot,
    });
    const directToolNames = createAgentLoopToolDefinitionPort(
      daemonContext.toolRegistry,
    )
      .buildToolDefinitions({})
      .map((tool) => tool.name);
    assert.equal(directToolNames.includes('read_file'), true);
    assert.equal(directToolNames.includes('search_memory_index'), false);
    const projection =
      await daemonContext.toolLibraryProjection.resolveProjection({
        stateRoot,
        threadId,
      });
    assert.equal(projection.ok, true);
    if (!projection.ok) {
      assert.fail('expected the WO6-V3 SDK projection to resolve');
    }
    assert.deepEqual(projection.projection.allowedRegistryNames, [
      'fetch_url',
      'list_files',
      'read_file',
      'read_tool_output',
      'search_files',
      'search_memory_index',
    ]);
    const toolContext = {
      computerFileRoot,
      threadId,
      stateRoot,
      workingDirectory: '',
      agentSpawnRuntime: daemonContext,
      callbackToolDispatcher,
      toolLibraryProjectionIdentity: {
        sdkVersion: projection.pin.sdkVersion,
        sdkProjectionHash: projection.pin.sdkProjectionHash,
        policyId: projection.pin.policyId,
      },
    };

    const execResult = await executeCodeTool.execute(
      {
        code: [
          "const readFile = require('geulbat-sdk/files/readFile');",
          "if (typeof readFile !== 'function' || readFile.readFile !== readFile) throw new Error('readFile CommonJS interop is unavailable');",
          "const { searchMemoryIndex } = require('geulbat-sdk/tools/search-memory-index');",
          "const result = await readFile({ path: 'docs/note.txt', limit: 1 });",
          "if (result.kind !== 'inline') throw new Error('read_file callback was offloaded');",
          'if (!result.value.ok) throw new Error(`read_file callback failed: ${result.value.errorCode} ${result.value.error}`);',
          'const payload = JSON.parse(result.value.output);',
          "const memory = await searchMemoryIndex({ query: 'searchable memory tool', pathPrefix: 'docs' });",
          "if (memory.kind !== 'inline') throw new Error('search_memory_index callback was offloaded');",
          'if (!memory.value.ok) throw new Error(`search_memory_index callback failed: ${memory.value.errorCode} ${memory.value.error}`);',
          'const memoryPayload = JSON.parse(memory.value.output);',
          "await geulbat.store.set('wo6_v3', { content: payload.content.trim(), memoryPath: memoryPayload.results[0].path });",
          "const stored = await geulbat.store.get('wo6_v3');",
          'console.log(`${stored.content} ${stored.memoryPath}`);',
        ].join('\n'),
        timeoutMs: 5_000,
        'yield-time_ms': TEST_INITIAL_YIELD_MS,
      },
      { ...toolContext, callId: 'call-wo6-v1-exec' },
    );

    if (!execResult.ok) {
      assert.fail(execResult.error);
    }
    assert.equal(execResult.ok, true);
    const execOutput = JSON.parse(execResult.output) as Record<string, unknown>;
    assert.equal(
      execOutput.kind,
      'ptc_execute_code_cell_running',
      JSON.stringify(execOutput),
    );
    assert.equal(execOutput.status, 'running');
    const cellId = execOutput.cellId;
    assert.equal(typeof cellId, 'string');
    if (typeof cellId !== 'string') {
      assert.fail('expected exec to return a detached cell id');
    }
    assert.deepEqual(events, [
      'placement:acquire',
      'process:start',
      'callback:read_file',
    ]);
    assert.ok(detachedExit);
    await detachedExit;
    await placementReleased;

    const waitResult = await waitTool.execute(
      { cell_id: cellId },
      { ...toolContext, callId: 'call-wo6-v1-wait' },
    );
    if (!waitResult.ok) {
      assert.fail(waitResult.error);
    }
    assert.equal(waitResult.ok, true);
    const waitOutput = JSON.parse(waitResult.output) as Record<string, unknown>;
    assert.equal(waitOutput.kind, 'ptc_execute_code_cell_wait');
    assert.equal(waitOutput.status, 'completed');
    assert.equal(waitOutput.exitCode, 0, JSON.stringify(waitOutput));
    assert.equal(waitOutput.offloaded, true);
    assert.equal(waitOutput.recoveryTool, 'read_tool_output');
    const outputRef = waitOutput.outputRef;
    const fullOutputChars = waitOutput.fullOutputChars;
    assert.equal(typeof outputRef, 'string');
    assert.equal(typeof fullOutputChars, 'number');
    if (
      typeof outputRef !== 'string' ||
      typeof fullOutputChars !== 'number' ||
      fullOutputChars < 1
    ) {
      assert.fail('expected wait to return a recoverable durable output');
    }

    const recoveredResult = await executeTool(
      'read_tool_output',
      { outputRef, limit: fullOutputChars },
      { ...toolContext, callId: 'call-wo6-v1-read-output' },
      { toolRegistry: daemonContext.toolRegistry },
    );
    if (!recoveredResult.ok) {
      assert.fail(recoveredResult.error);
    }
    const recoveredPage = JSON.parse(recoveredResult.output) as Record<
      string,
      unknown
    >;
    assert.equal(recoveredPage.hasMore, false);
    assert.equal(recoveredPage.totalChars, fullOutputChars);
    const recoveredContent = recoveredPage.content;
    assert.equal(typeof recoveredContent, 'string');
    if (typeof recoveredContent !== 'string') {
      assert.fail('expected read_tool_output to return the terminal result');
    }
    const terminalOutput = JSON.parse(recoveredContent) as Record<
      string,
      unknown
    >;
    assert.equal(terminalOutput.kind, 'ptc_execute_code_cell_wait');
    assert.equal(terminalOutput.status, 'completed');
    assert.equal(terminalOutput.exitCode, 0);
    assert.deepEqual(terminalOutput.store, {
      committedKeys: ['wo6_v3'],
      revisions: { wo6_v3: 1 },
    });
    assert.match(
      String(terminalOutput.stdout),
      /WO6-V3 callback reached the real searchable memory tool\. docs\/note\.txt/u,
    );
    assert.deepEqual(events, [
      'placement:acquire',
      'process:start',
      'callback:read_file',
      'callback:search_memory_index',
      'placement:release',
    ]);
  } finally {
    await daemonContext.ptcExecuteCode.closeAll();
    await rm(computerFileRoot, { recursive: true, force: true });
    await rm(stateRoot, { recursive: true, force: true });
    await rm(runtimeRoot, { recursive: true, force: true });
  }
});

function remapEncodedExecuteCodeCallbackRoot(
  command: string,
  callbackHostRoot: string,
  sdkHostRoot?: string,
): string {
  const encodedRunnerMatch = /GEULBAT_PTC_RUNNER_B64='([A-Za-z0-9+/=]+)'/u.exec(
    command,
  );
  assert.ok(encodedRunnerMatch);
  const encodedRunner = encodedRunnerMatch[1];
  assert.ok(encodedRunner);
  const runnerSource = Buffer.from(encodedRunner, 'base64').toString('utf8');
  let remappedRunnerSource = runnerSource.replaceAll(
    '/geulbat/callbacks',
    callbackHostRoot,
  );
  if (sdkHostRoot !== undefined) {
    remappedRunnerSource = remappedRunnerSource.replaceAll(
      PTC_SESSION_DOCKER_SDK_CONTAINER_ROOT,
      sdkHostRoot,
    );
  }
  assert.notEqual(remappedRunnerSource, runnerSource);
  const remappedRunner = Buffer.from(remappedRunnerSource, 'utf8').toString(
    'base64',
  );
  return command.replace(
    encodedRunnerMatch[0],
    `GEULBAT_PTC_RUNNER_B64='${remappedRunner}'`,
  );
}
