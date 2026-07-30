import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { assertRunId, assertThreadId } from '@geulbat/protocol/ids';
import type { ProviderReplayScopeId } from '@geulbat/protocol/provider-auth';
import { toApprovalClass } from '@geulbat/protocol/run-approval';
import { z } from 'zod';

import type { HostCommandRuntime } from '../../command-host/contract.js';
import { createDaemonContext } from '../context.js';
import {
  ensureHostCommandFullOutputArchive,
  type HostCommandFullOutputArchiveHandle,
} from '../host-command-full-output-archive.js';
import { createDaemonRuntimeStateStore } from '../runtime-state-store.js';
import {
  commitMemoryEntries,
  readMemoryEntries,
} from '../memories/entries-store.js';
import { listPendingMemoryNotes } from '../memories/notes-store.js';
import {
  buildToolOutputRef,
  buildToolOutputSnapshot,
  writeToolOutputSnapshot,
} from '../files/tool-output-store.js';
import { createPreparedPathFingerprint } from '../files/file-mutation-chain.js';
import {
  prepareOperationManifest,
  type OperationManifest,
} from '../files/operation-manifest.js';
import { PTC_EXECUTE_CODE_TOOL_NAME } from '../ptc/runtime/execute-code/execute-code-runtime-contract.js';
import { normalizeTextContent } from '../files/text-content.js';
import { createRunContext } from '../run-context.js';
import { createRunState } from './runtime/run-state.js';
import { createVersionToken } from '../files/version-token.js';
import {
  appendTranscriptEntry,
  readTranscriptEntries,
} from '../sessions/transcript-log.js';
import { appendProviderRound } from '../sessions/provider-round-journal.js';
import { defineZodTool } from '../tools/zod-tool.js';
import { agentStopTool } from '../tools/builtin/agent-stop.js';
import { citeMemoryTool } from '../tools/builtin/cite-memory.js';
import { execCommandTool } from '../tools/builtin/exec-command.js';
import { writeMemoryNoteTool } from '../tools/builtin/write-memory-note.js';
import {
  createScriptedProviderCallModel,
  providerFinalAnswerRound,
} from '../../test-support/provider-response-fixtures.js';
import { removeCommandHostWorkspace } from '../../test-support/command-host-workspace.js';
import { loadExistingHistory } from './loop-history.js';
import { recoverPendingReplaySafeToolCalls } from './loop-tool-recovery.js';
import { runAgentLoop } from './run-agent-loop.js';
import { persistToolResultReady } from './tool-result-ready-store.js';
import {
  buildChildLaunchPayload,
  buildChildLaunchStarted,
} from '../subagent-runtime-contracts.js';
import {
  TEST_AUTO_SUBAGENT_MODEL_ROUTING,
  TEST_INHERITED_SOL_MODEL_PIN,
} from '../../test-support/subagent-model-routing.js';

// Recovery tests construct many daemon contexts in one process. OS browse
// discovery is unrelated to these contracts and otherwise leaves one detached
// retry loop per context competing with the real command-host recovery cases.
const previousComputerSessionDisabled =
  process.env['GEULBAT_COMPUTER_SESSION_DISABLED'];
process.env['GEULBAT_COMPUTER_SESSION_DISABLED'] = '1';
test.after(() => {
  if (previousComputerSessionDisabled === undefined) {
    delete process.env['GEULBAT_COMPUTER_SESSION_DISABLED'];
  } else {
    process.env['GEULBAT_COMPUTER_SESSION_DISABLED'] =
      previousComputerSessionDisabled;
  }
});

async function injectInFlightToolInvocation(args: {
  stateRoot: string;
  threadId: string;
  callId: string;
  toolName: string;
  recoveryState: unknown;
}): Promise<void> {
  const checkpointPath = join(
    args.stateRoot,
    '.geulbat',
    'run-checkpoints',
    `${args.threadId}.json`,
  );
  const checkpoint = JSON.parse(
    await readFile(checkpointPath, 'utf8'),
  ) as Record<string, unknown>;
  checkpoint.toolInvocations = [
    {
      callId: args.callId,
      toolName: args.toolName,
      recoveryStrategy: 'reconcile_then_replay',
      recoveryState: args.recoveryState,
      status: 'in_flight',
    },
  ];
  await writeFile(checkpointPath, `${JSON.stringify(checkpoint)}\n`, 'utf8');
}

async function readCheckpointToolInvocations(args: {
  stateRoot: string;
  threadId: string;
}): Promise<unknown> {
  const checkpoint = JSON.parse(
    await readFile(
      join(
        args.stateRoot,
        '.geulbat',
        'run-checkpoints',
        `${args.threadId}.json`,
      ),
      'utf8',
    ),
  ) as Record<string, unknown>;
  return checkpoint.toolInvocations;
}

function buildInterruptedCreateManifest(args: {
  runId: string;
  callId: string;
  targetPath: string;
  targetRelativePath?: string;
}): OperationManifest {
  return prepareOperationManifest({
    operationId: args.callId,
    manifestRevision: '1',
    operationKind: 'create_file',
    authorityId: 'computer',
    actor: { kind: 'assistant', runId: args.runId },
    targets: [
      {
        role: 'destination',
        path: args.targetRelativePath ?? 'restart-created.txt',
        canonicalTargetId: args.targetPath,
      },
    ],
    approval: { required: true },
    atomicity: 'best_effort',
    createdAt: '2026-07-18T00:00:02.000Z',
  });
}

function buildInterruptedWriteCreateManifest(args: {
  runId: string;
  callId: string;
  targetPath: string;
  targetRelativePath: string;
  content: string;
}): OperationManifest {
  return prepareOperationManifest({
    operationId: args.callId,
    manifestRevision: '1',
    operationKind: 'create_file',
    authorityId: 'computer',
    actor: { kind: 'assistant', runId: args.runId },
    targets: [
      {
        role: 'destination',
        path: args.targetRelativePath,
        canonicalTargetId: args.targetPath,
      },
    ],
    approval: { required: true },
    payloadDigest: {
      kind: 'content',
      digest: createVersionToken(normalizeTextContent(args.content)),
    },
    atomicity: 'atomic',
    createdAt: '2026-07-27T00:00:00.000Z',
  });
}

function buildInterruptedApplyPatchCreateRecoveryState(args: {
  runId: string;
  callId: string;
  targetPath: string;
  targetRelativePath: string;
  content: string;
  patch: string;
}): Record<string, unknown> {
  return {
    manifest: prepareOperationManifest({
      operationId: args.callId,
      manifestRevision: '1',
      operationKind: 'create_file',
      authorityId: 'computer',
      actor: { kind: 'assistant', runId: args.runId },
      targets: [
        {
          role: 'destination',
          path: args.targetRelativePath,
          canonicalTargetId: args.targetPath,
        },
      ],
      approval: { required: true },
      payloadDigest: {
        kind: 'content',
        digest: createVersionToken(normalizeTextContent(args.content)),
      },
      atomicity: 'atomic',
      createdAt: '2026-07-27T00:00:00.000Z',
    }),
    patchDigest: createVersionToken(normalizeTextContent(args.patch)),
  };
}

async function buildInterruptedDeleteManifest(args: {
  runId: string;
  callId: string;
  targetPath: string;
  targetRelativePath: string;
}): Promise<OperationManifest> {
  const fingerprint = createPreparedPathFingerprint(
    await lstat(args.targetPath),
    'file',
  );
  return prepareOperationManifest({
    operationId: args.callId,
    manifestRevision: '1',
    operationKind: 'delete',
    authorityId: 'computer',
    actor: { kind: 'assistant', runId: args.runId },
    targets: [
      {
        role: 'source',
        path: args.targetRelativePath,
        canonicalTargetId: args.targetPath,
        expectedKind: 'file',
        expectedIdentityToken: fingerprint.pathIdentityToken,
        expectedVersionToken: fingerprint.pathVersionToken,
      },
    ],
    approval: { required: true },
    atomicity: 'best_effort',
    createdAt: '2026-07-18T00:00:02.000Z',
  });
}

void test('restart recovery automatically replays a declared replay-safe tool once', async (t) => {
  const stateRoot = await mkdtemp(join(tmpdir(), 'geulbat-tool-recovery-'));
  t.after(async () => rm(stateRoot, { recursive: true, force: true }));
  const threadId = assertThreadId(randomUUID());
  const runId = assertRunId(randomUUID());
  let executions = 0;
  const daemonContext = createDaemonContext({ homeStateRoot: stateRoot });
  daemonContext.toolRegistry.registerTool(
    defineZodTool({
      name: 'restart_probe',
      description: 'Restart recovery probe.',
      argsSchema: z.strictObject({ value: z.string() }),
      sideEffectLevel: 'none',
      mayMutateComputerFiles: false,
      requiresApproval: false,
      recoveryStrategy: 'replay_safe',
      async executeParsed(args) {
        executions += 1;
        return { ok: true, output: args.value };
      },
    }),
  );
  await appendTranscriptEntry(stateRoot, threadId, {
    role: 'user',
    content: 'visible prompt',
    metadata: { hiddenPrompt: 'exact model prompt' },
    timestamp: '2026-07-18T00:00:00.000Z',
  });
  await appendTranscriptEntry(stateRoot, threadId, {
    role: 'tool_call',
    content: JSON.stringify({
      id: 'item-1',
      callId: 'call-1',
      tool: 'restart_probe',
      args: { value: 'recovered' },
      round: 2,
      recoveryStrategy: 'replay_safe',
    }),
    timestamp: '2026-07-18T00:00:01.000Z',
  });

  const recovered = await recoverPendingReplaySafeToolCalls({
    agentInput: {
      runId,
      runContext: createRunContext({
        threadId,
        stateRoot,
        workingDirectory: stateRoot,
      }),
      prompt: 'unused during recovery',
      runtimeServices: daemonContext,
      approvalContext: {
        computerSessionId: 'replacement-session',
        permissionMode: 'basic',
      },
      onEvent() {},
    },
  });

  assert.deepEqual(recovered, {
    modelPrompt: 'exact model prompt',
    transcriptPrompt: 'visible prompt',
    recoveredCallCount: 1,
  });
  assert.equal(executions, 1);
  const entries = await readTranscriptEntries(stateRoot, threadId);
  assert.equal(entries.filter((entry) => entry.role === 'tool_call').length, 1);
  assert.equal(
    entries.filter((entry) => entry.role === 'tool_result').length,
    1,
  );
});

void test('restart recovery rehydrates a settled queued agent_spawn and starts the same durable child identity', async (t) => {
  const stateRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-queued-child-recovery-'),
  );
  const homeStateRoot = join(stateRoot, 'home-state');
  const threadId = assertThreadId(randomUUID());
  const runId = assertRunId(randomUUID());
  const callId = 'call-settled-queued-agent-spawn';
  const originalStore = await createDaemonRuntimeStateStore({ homeStateRoot });
  const [queued] = originalStore.enqueueSubagentLaunchBatch([
    {
      toolCallId: callId,
      task: 'continue the queued child after restart',
      subagentType: 'explorer',
      capabilities: [],
      parentRunId: runId,
      ownerThreadId: threadId,
      stateRoot,
      workingDirectory: stateRoot,
      permissionMode: 'basic',
      ultraReasoning: false,
      modelPin: TEST_INHERITED_SOL_MODEL_PIN,
      subagentModelRouting: TEST_AUTO_SUBAGENT_MODEL_ROUTING,
    },
  ]);
  assert.ok(queued);
  originalStore.close();

  const replacementStore = await createDaemonRuntimeStateStore({
    homeStateRoot,
  });
  const replacement = createDaemonContext({
    homeStateRoot,
    subagentLaunchRequests: replacementStore,
    subagentConcurrencyPolicy: { maxConcurrentChildren: 1 },
  });
  t.after(async () => {
    await replacement.subagent.launchPromotions?.close();
    replacementStore.close();
    await rm(stateRoot, { recursive: true, force: true });
  });

  let startedArgs:
    | {
        childRunId: string | undefined;
        childThreadId: string | undefined;
        task: string;
      }
    | undefined;
  let observeStart = () => {};
  const startObserved = new Promise<void>((resolve) => {
    observeStart = resolve;
  });
  replacement.subagent.runs = {
    async startBackgroundRun(args) {
      startedArgs = {
        childRunId: args.childRunId,
        childThreadId: args.childThreadId,
        task: args.task,
      };
      assert.ok(args.childRunId);
      replacementStore.markSubagentLaunchStarted(args.childRunId);
      observeStart();
      return buildChildLaunchPayload(
        buildChildLaunchStarted({
          childRunId: args.childRunId,
          childThreadId: args.childThreadId ?? queued.childThreadId,
          subagentType: args.subagentType,
          modelPin: args.modelPin,
        }),
      );
    },
  };

  await appendTranscriptEntry(stateRoot, threadId, {
    role: 'user',
    content: 'delegate the queued work',
    metadata: { hiddenPrompt: 'delegate the queued work exactly' },
    timestamp: '2026-07-27T00:00:00.000Z',
  });
  await appendTranscriptEntry(stateRoot, threadId, {
    role: 'tool_call',
    content: JSON.stringify({
      id: 'item-settled-queued-agent-spawn',
      callId,
      tool: 'agent_spawn',
      args: {
        task: 'continue the queued child after restart',
        subagent_type: 'explorer',
      },
      round: 1,
      recoveryStrategy: 'reconcile_then_replay',
    }),
    timestamp: '2026-07-27T00:00:01.000Z',
  });
  await appendTranscriptEntry(stateRoot, threadId, {
    role: 'tool_result',
    content: JSON.stringify({
      callId,
      tool: 'agent_spawn',
      ok: true,
      computerFilesMayHaveChanged: false,
      displayText: 'queued',
      output: buildChildLaunchPayload(
        buildChildLaunchStarted({
          childRunId: queued.childRunId,
          childThreadId: queued.childThreadId,
          subagentType: 'explorer',
          modelPin: TEST_INHERITED_SOL_MODEL_PIN,
        }),
      ).output,
    }),
    timestamp: '2026-07-27T00:00:02.000Z',
  });
  const runContext = createRunContext({
    threadId,
    stateRoot,
    workingDirectory: stateRoot,
  });
  const recovered = await recoverPendingReplaySafeToolCalls({
    agentInput: {
      runId,
      runContext,
      prompt: 'unused during recovery',
      runtimeServices: replacement,
      approvalContext: {
        computerSessionId: 'replacement-session',
        permissionMode: 'basic',
      },
      runState: createRunState({ runId, runContext }),
      onEvent() {},
    },
  });
  await startObserved;

  assert.equal(recovered.recoveredCallCount, 0);
  assert.deepEqual(startedArgs, {
    childRunId: queued.childRunId,
    childThreadId: queued.childThreadId,
    task: 'continue the queued child after restart',
  });
  assert.equal(
    replacementStore.readSubagentLaunchRequestByChildRunId(queued.childRunId)
      ?.launchState,
    'started',
  );
});

void test('restart recovery reconciles agent_retry to the one durable replacement child', async (t) => {
  const stateRoot = await mkdtemp(join(tmpdir(), 'geulbat-tool-recovery-'));
  const threadId = assertThreadId(randomUUID());
  const parentRunId = assertRunId(randomUUID());
  const retryCallId = 'call-agent-retry-restart';
  let runtimeState = await createDaemonRuntimeStateStore({
    homeStateRoot: stateRoot,
  });
  const [original] = runtimeState.enqueueSubagentLaunchBatch([
    {
      toolCallId: 'call-original-agent-retry-child',
      task: 'finish the interrupted child task',
      subagentType: 'worker',
      capabilities: [],
      parentRunId,
      ownerThreadId: threadId,
      stateRoot,
      workingDirectory: stateRoot,
      permissionMode: 'full_access',
      ultraReasoning: true,
      modelPin: TEST_INHERITED_SOL_MODEL_PIN,
      subagentModelRouting: TEST_AUTO_SUBAGENT_MODEL_ROUTING,
    },
  ]);
  assert.ok(original);
  runtimeState.markSubagentLaunchStarting(original.childRunId);
  runtimeState.markSubagentLaunchStarted(original.childRunId);
  runtimeState.close();
  runtimeState = await createDaemonRuntimeStateStore({
    homeStateRoot: stateRoot,
  });
  t.after(async () => {
    runtimeState.close();
    await rm(stateRoot, { recursive: true, force: true });
  });
  assert.equal(
    runtimeState.readSubagentLaunchRequestByChildRunId(original.childRunId)
      ?.launchState,
    'interrupted',
  );
  const created = runtimeState.retryInterruptedSubagentLaunch({
    previousChildRunId: original.childRunId,
    ownerThreadId: threadId,
    parentRunId,
    toolCallId: retryCallId,
    stateRoot,
    workingDirectory: stateRoot,
    permissionMode: 'full_access',
  });
  assert.equal(created.disposition, 'created');
  runtimeState.markSubagentLaunchStarting(created.request.childRunId);
  runtimeState.markSubagentLaunchStarted(created.request.childRunId);
  await appendTranscriptEntry(stateRoot, threadId, {
    role: 'user',
    content: 'retry the interrupted child once',
    timestamp: '2026-07-28T00:00:00.000Z',
  });
  await appendTranscriptEntry(stateRoot, threadId, {
    role: 'tool_call',
    content: JSON.stringify({
      id: 'item-agent-retry-restart',
      callId: retryCallId,
      tool: 'agent_retry',
      args: { child_run_id: original.childRunId },
      round: 1,
      recoveryStrategy: 'reconcile_then_replay',
    }),
    timestamp: '2026-07-28T00:00:01.000Z',
  });
  const daemonContext = createDaemonContext({
    homeStateRoot: stateRoot,
    subagentLaunchRequests: runtimeState,
    subagentTerminalDeliveries: runtimeState,
  });
  const runContext = createRunContext({
    threadId,
    stateRoot,
    workingDirectory: stateRoot,
  });

  const recovered = await recoverPendingReplaySafeToolCalls({
    agentInput: {
      runId: parentRunId,
      runContext,
      prompt: 'unused during recovery',
      runtimeServices: daemonContext,
      approvalContext: {
        computerSessionId: 'replacement-session',
        permissionMode: 'full_access',
      },
      runState: createRunState({ runId: parentRunId, runContext }),
      onEvent() {},
    },
  });

  assert.equal(recovered.recoveredCallCount, 1);
  const sameRetry = runtimeState.retryInterruptedSubagentLaunch({
    previousChildRunId: original.childRunId,
    ownerThreadId: threadId,
    parentRunId,
    toolCallId: retryCallId,
    stateRoot,
    workingDirectory: stateRoot,
    permissionMode: 'full_access',
  });
  assert.equal(sameRetry.disposition, 'same_call_replay');
  assert.equal(sameRetry.request.childRunId, created.request.childRunId);
  const entries = await readTranscriptEntries(stateRoot, threadId);
  const resultEntry = entries.find((entry) => entry.role === 'tool_result');
  assert.equal(resultEntry?.role, 'tool_result');
  if (resultEntry?.role !== 'tool_result') {
    assert.fail('expected the recovered agent_retry result');
  }
  const storedResult = JSON.parse(resultEntry.content) as {
    ok: boolean;
    output?: string;
  };
  assert.equal(storedResult.ok, true);
  const output = JSON.parse(storedResult.output ?? '{}') as {
    previousChildRunId?: string;
    childRunId?: string;
    childThreadId?: string;
    retryDisposition?: string;
    launchState?: string;
  };
  assert.equal(output.previousChildRunId, original.childRunId);
  assert.equal(output.childRunId, created.request.childRunId);
  assert.equal(output.childThreadId, created.request.childThreadId);
  assert.equal(output.retryDisposition, 'same_call_replay');
  assert.equal(output.launchState, 'started');
});

void test('restart recovery settles a queued agent_stop whose cancellation already committed', async (t) => {
  const stateRoot = await mkdtemp(join(tmpdir(), 'geulbat-tool-recovery-'));
  const threadId = assertThreadId(randomUUID());
  const runId = assertRunId(randomUUID());
  const callId = 'call-agent-stop-restart';
  let runtimeState = await createDaemonRuntimeStateStore({
    homeStateRoot: stateRoot,
  });
  const [queued] = runtimeState.enqueueSubagentLaunchBatch([
    {
      toolCallId: 'call-agent-stop-child',
      task: 'cancel this queued child once',
      subagentType: 'worker',
      capabilities: [],
      parentRunId: runId,
      ownerThreadId: threadId,
      stateRoot,
      workingDirectory: stateRoot,
      permissionMode: 'basic',
      ultraReasoning: false,
      modelPin: TEST_INHERITED_SOL_MODEL_PIN,
      subagentModelRouting: TEST_AUTO_SUBAGENT_MODEL_ROUTING,
    },
  ]);
  assert.ok(queued);
  await appendTranscriptEntry(stateRoot, threadId, {
    role: 'user',
    content: 'stop the queued child after restart',
    timestamp: '2026-07-28T00:00:00.000Z',
  });
  await appendTranscriptEntry(stateRoot, threadId, {
    role: 'tool_call',
    content: JSON.stringify({
      id: 'item-agent-stop-restart',
      callId,
      tool: 'agent_stop',
      args: { child_run_id: queued.childRunId },
      round: 1,
      recoveryStrategy: 'replay_safe',
    }),
    timestamp: '2026-07-28T00:00:01.000Z',
  });
  const original = createDaemonContext({
    homeStateRoot: stateRoot,
    subagentLaunchRequests: runtimeState,
  });
  const stopped = await agentStopTool.execute(
    { child_run_id: queued.childRunId },
    {
      callId,
      stateRoot,
      threadId,
      runId,
      runtimeServices: original,
    },
  );
  assert.equal(stopped.ok, true);
  assert.equal(JSON.parse(stopped.output).stopState, 'cancelled_before_start');
  runtimeState.close();

  runtimeState = await createDaemonRuntimeStateStore({
    homeStateRoot: stateRoot,
  });
  t.after(async () => {
    runtimeState.close();
    await rm(stateRoot, { recursive: true, force: true });
  });
  const replacement = createDaemonContext({
    homeStateRoot: stateRoot,
    subagentLaunchRequests: runtimeState,
  });
  const recovered = await recoverPendingReplaySafeToolCalls({
    agentInput: {
      runId,
      runContext: createRunContext({
        threadId,
        stateRoot,
        workingDirectory: stateRoot,
      }),
      prompt: 'unused during recovery',
      runtimeServices: replacement,
      approvalContext: {
        computerSessionId: 'replacement-session',
        permissionMode: 'basic',
      },
      onEvent() {},
    },
  });

  assert.equal(recovered.recoveredCallCount, 1);
  assert.equal(
    runtimeState.readSubagentLaunchRequestByChildRunId(queued.childRunId)
      ?.launchState,
    'cancelled',
  );
  const resultEntry = (await readTranscriptEntries(stateRoot, threadId)).find(
    (entry) => entry.role === 'tool_result',
  );
  assert.equal(resultEntry?.role, 'tool_result');
  if (resultEntry?.role !== 'tool_result') {
    assert.fail('expected the recovered agent_stop result');
  }
  const result = JSON.parse(resultEntry.content) as {
    ok: boolean;
    output?: string;
  };
  assert.equal(result.ok, true);
  assert.deepEqual(JSON.parse(result.output ?? '{}'), {
    ok: true,
    childRunId: queued.childRunId,
    stopState: 'already_terminal',
  });
});

void test('restart recovery replays a reconcile-then-replay create whose effect never started', async (t) => {
  const stateRoot = await mkdtemp(join(tmpdir(), 'geulbat-tool-recovery-'));
  t.after(async () => rm(stateRoot, { recursive: true, force: true }));
  const threadId = assertThreadId(randomUUID());
  const runId = assertRunId(randomUUID());
  const callId = 'call-create-before-effect';
  const workingDirectory = join(stateRoot, 'nested');
  const targetPath = join(workingDirectory, 'restart-created.txt');
  await mkdir(workingDirectory);
  const original = createDaemonContext({ homeStateRoot: stateRoot });
  await original.runCheckpoints.startRun({
    runId,
    threadId,
    request: { workingDirectory, permissionMode: 'full_access' },
  });
  await appendTranscriptEntry(stateRoot, threadId, {
    role: 'user',
    content: 'create the restart evidence',
    timestamp: '2026-07-18T00:00:00.000Z',
  });
  await appendTranscriptEntry(stateRoot, threadId, {
    role: 'tool_call',
    content: JSON.stringify({
      id: 'item-create-before-effect',
      callId,
      tool: 'manage_files',
      args: { operation: 'create', path: 'restart-created.txt' },
      round: 1,
      recoveryStrategy: 'reconcile_then_replay',
    }),
    timestamp: '2026-07-18T00:00:01.000Z',
  });
  await injectInFlightToolInvocation({
    stateRoot,
    threadId,
    callId,
    toolName: 'manage_files',
    recoveryState: buildInterruptedCreateManifest({
      runId,
      callId,
      targetPath,
      targetRelativePath: 'nested/restart-created.txt',
    }),
  });

  const replacement = createDaemonContext({ homeStateRoot: stateRoot });
  replacement.computerFileRoot = stateRoot;
  const recovered = await recoverPendingReplaySafeToolCalls({
    agentInput: {
      runId,
      runContext: createRunContext({
        threadId,
        stateRoot,
        workingDirectory,
      }),
      prompt: 'unused during recovery',
      runtimeServices: replacement,
      approvalContext: {
        computerSessionId: 'replacement-session',
        permissionMode: 'full_access',
      },
      onEvent() {},
    },
  });

  assert.equal(recovered.recoveredCallCount, 1);
  assert.equal(await readFile(targetPath, 'utf8'), '');
  const result = JSON.parse(
    (await readTranscriptEntries(stateRoot, threadId)).at(-1)?.content ?? '{}',
  ) as Record<string, unknown>;
  assert.equal(result.ok, true);
  assert.deepEqual(
    await readCheckpointToolInvocations({ stateRoot, threadId }),
    [],
  );
});

void test('restart recovery restores a reconcile-then-replay create completed before outcome persistence', async (t) => {
  const stateRoot = await mkdtemp(join(tmpdir(), 'geulbat-tool-recovery-'));
  t.after(async () => rm(stateRoot, { recursive: true, force: true }));
  const threadId = assertThreadId(randomUUID());
  const runId = assertRunId(randomUUID());
  const callId = 'call-create-after-effect';
  const targetPath = join(stateRoot, 'restart-created.txt');
  const original = createDaemonContext({ homeStateRoot: stateRoot });
  await original.runCheckpoints.startRun({
    runId,
    threadId,
    request: { workingDirectory: stateRoot, permissionMode: 'full_access' },
  });
  await appendTranscriptEntry(stateRoot, threadId, {
    role: 'user',
    content: 'recover the completed create',
    timestamp: '2026-07-18T00:00:00.000Z',
  });
  await appendTranscriptEntry(stateRoot, threadId, {
    role: 'tool_call',
    content: JSON.stringify({
      id: 'item-create-after-effect',
      callId,
      tool: 'manage_files',
      args: { operation: 'create', path: 'restart-created.txt' },
      round: 1,
      recoveryStrategy: 'reconcile_then_replay',
    }),
    timestamp: '2026-07-18T00:00:01.000Z',
  });
  await injectInFlightToolInvocation({
    stateRoot,
    threadId,
    callId,
    toolName: 'manage_files',
    recoveryState: buildInterruptedCreateManifest({
      runId,
      callId,
      targetPath,
    }),
  });
  await writeFile(targetPath, '', 'utf8');

  const replacement = createDaemonContext({ homeStateRoot: stateRoot });
  replacement.computerFileRoot = stateRoot;
  const recovered = await recoverPendingReplaySafeToolCalls({
    agentInput: {
      runId,
      runContext: createRunContext({
        threadId,
        stateRoot,
        workingDirectory: stateRoot,
      }),
      prompt: 'unused during recovery',
      runtimeServices: replacement,
      approvalContext: {
        computerSessionId: 'replacement-session',
        permissionMode: 'full_access',
      },
      onEvent() {},
    },
  });

  assert.equal(recovered.recoveredCallCount, 1);
  assert.equal(await readFile(targetPath, 'utf8'), '');
  const result = JSON.parse(
    (await readTranscriptEntries(stateRoot, threadId)).at(-1)?.content ?? '{}',
  ) as Record<string, unknown>;
  assert.equal(result.ok, true);
  assert.deepEqual(
    await readCheckpointToolInvocations({ stateRoot, threadId }),
    [],
  );
});

void test('restart recovery replays write_file through the product registry after a pre-effect interruption', async (t) => {
  const stateRoot = await mkdtemp(join(tmpdir(), 'geulbat-tool-recovery-'));
  t.after(async () => rm(stateRoot, { recursive: true, force: true }));
  const threadId = assertThreadId(randomUUID());
  const runId = assertRunId(randomUUID());
  const callId = 'call-write-file-before-effect';
  const relativePath = 'restart-write-file.txt';
  const targetPath = join(stateRoot, relativePath);
  const content = 'write_file survived the restart\n';
  const original = createDaemonContext({ homeStateRoot: stateRoot });
  await original.runCheckpoints.startRun({
    runId,
    threadId,
    request: { workingDirectory: stateRoot, permissionMode: 'full_access' },
  });
  await appendTranscriptEntry(stateRoot, threadId, {
    role: 'user',
    content: 'write the restart evidence',
    timestamp: '2026-07-27T00:00:00.000Z',
  });
  await appendTranscriptEntry(stateRoot, threadId, {
    role: 'tool_call',
    content: JSON.stringify({
      id: 'item-write-file-before-effect',
      callId,
      tool: 'write_file',
      args: { path: relativePath, content },
      round: 1,
      recoveryStrategy: 'reconcile_then_replay',
    }),
    timestamp: '2026-07-27T00:00:01.000Z',
  });
  await injectInFlightToolInvocation({
    stateRoot,
    threadId,
    callId,
    toolName: 'write_file',
    recoveryState: buildInterruptedWriteCreateManifest({
      runId,
      callId,
      targetPath,
      targetRelativePath: relativePath,
      content,
    }),
  });

  const replacement = createDaemonContext({ homeStateRoot: stateRoot });
  replacement.computerFileRoot = stateRoot;
  const recovered = await recoverPendingReplaySafeToolCalls({
    agentInput: {
      runId,
      runContext: createRunContext({
        threadId,
        stateRoot,
        workingDirectory: stateRoot,
      }),
      prompt: 'unused during recovery',
      runtimeServices: replacement,
      approvalContext: {
        computerSessionId: 'replacement-session',
        permissionMode: 'full_access',
      },
      onEvent() {},
    },
  });

  assert.equal(recovered.recoveredCallCount, 1);
  assert.equal(await readFile(targetPath, 'utf8'), content);
  const result = JSON.parse(
    (await readTranscriptEntries(stateRoot, threadId)).at(-1)?.content ?? '{}',
  ) as { ok?: unknown; output?: unknown };
  assert.equal(result.ok, true);
  assert.equal(typeof result.output, 'string');
  if (typeof result.output === 'string') {
    assert.equal(JSON.parse(result.output).mode, 'created');
  }
  assert.deepEqual(
    await readCheckpointToolInvocations({ stateRoot, threadId }),
    [],
  );
});

void test('restart recovery replays apply_patch through the product registry after a pre-effect interruption', async (t) => {
  const stateRoot = await mkdtemp(join(tmpdir(), 'geulbat-tool-recovery-'));
  t.after(async () => rm(stateRoot, { recursive: true, force: true }));
  const threadId = assertThreadId(randomUUID());
  const runId = assertRunId(randomUUID());
  const callId = 'call-apply-patch-before-effect';
  const relativePath = 'restart-apply-patch.txt';
  const targetPath = join(stateRoot, relativePath);
  const content = 'apply_patch survived the restart\n';
  const patch = [
    '*** Begin Patch',
    `*** Add File: ${relativePath}`,
    '+apply_patch survived the restart',
    '*** End Patch',
    '',
  ].join('\n');
  const original = createDaemonContext({ homeStateRoot: stateRoot });
  await original.runCheckpoints.startRun({
    runId,
    threadId,
    request: { workingDirectory: stateRoot, permissionMode: 'full_access' },
  });
  await appendTranscriptEntry(stateRoot, threadId, {
    role: 'user',
    content: 'apply the restart-safe patch',
    timestamp: '2026-07-27T00:00:00.000Z',
  });
  await appendTranscriptEntry(stateRoot, threadId, {
    role: 'tool_call',
    content: JSON.stringify({
      id: 'item-apply-patch-before-effect',
      callId,
      tool: 'apply_patch',
      args: { patch },
      round: 1,
      recoveryStrategy: 'reconcile_then_replay',
    }),
    timestamp: '2026-07-27T00:00:01.000Z',
  });
  await injectInFlightToolInvocation({
    stateRoot,
    threadId,
    callId,
    toolName: 'apply_patch',
    recoveryState: buildInterruptedApplyPatchCreateRecoveryState({
      runId,
      callId,
      targetPath,
      targetRelativePath: relativePath,
      content,
      patch,
    }),
  });

  const replacement = createDaemonContext({ homeStateRoot: stateRoot });
  replacement.computerFileRoot = stateRoot;
  const recovered = await recoverPendingReplaySafeToolCalls({
    agentInput: {
      runId,
      runContext: createRunContext({
        threadId,
        stateRoot,
        workingDirectory: stateRoot,
      }),
      prompt: 'unused during recovery',
      runtimeServices: replacement,
      approvalContext: {
        computerSessionId: 'replacement-session',
        permissionMode: 'full_access',
      },
      onEvent() {},
    },
  });

  assert.equal(recovered.recoveredCallCount, 1);
  assert.equal(await readFile(targetPath, 'utf8'), content);
  const result = JSON.parse(
    (await readTranscriptEntries(stateRoot, threadId)).at(-1)?.content ?? '{}',
  ) as { ok?: unknown; output?: unknown };
  assert.equal(result.ok, true);
  assert.equal(typeof result.output, 'string');
  if (typeof result.output === 'string') {
    assert.equal(JSON.parse(result.output).operation, 'add');
  }
  assert.deepEqual(
    await readCheckpointToolInvocations({ stateRoot, threadId }),
    [],
  );
});

void test('restart recovery refuses to delete a same-kind replacement with a changed fingerprint', async (t) => {
  const stateRoot = await mkdtemp(join(tmpdir(), 'geulbat-tool-recovery-'));
  t.after(async () => rm(stateRoot, { recursive: true, force: true }));
  const threadId = assertThreadId(randomUUID());
  const runId = assertRunId(randomUUID());
  const callId = 'call-delete-replaced';
  const targetPath = join(stateRoot, 'delete-after-restart.txt');
  await writeFile(targetPath, 'original\n', 'utf8');
  const original = createDaemonContext({ homeStateRoot: stateRoot });
  await original.runCheckpoints.startRun({
    runId,
    threadId,
    request: { workingDirectory: stateRoot, permissionMode: 'full_access' },
  });
  await appendTranscriptEntry(stateRoot, threadId, {
    role: 'user',
    content: 'delete the original file',
    timestamp: '2026-07-18T00:00:00.000Z',
  });
  await appendTranscriptEntry(stateRoot, threadId, {
    role: 'tool_call',
    content: JSON.stringify({
      id: 'item-delete-replaced',
      callId,
      tool: 'manage_files',
      args: { operation: 'delete', path: 'delete-after-restart.txt' },
      round: 1,
      recoveryStrategy: 'reconcile_then_replay',
    }),
    timestamp: '2026-07-18T00:00:01.000Z',
  });
  await injectInFlightToolInvocation({
    stateRoot,
    threadId,
    callId,
    toolName: 'manage_files',
    recoveryState: await buildInterruptedDeleteManifest({
      runId,
      callId,
      targetPath,
      targetRelativePath: 'delete-after-restart.txt',
    }),
  });
  await rm(targetPath);
  await writeFile(targetPath, 'replacement with a different version\n', 'utf8');

  const replacement = createDaemonContext({ homeStateRoot: stateRoot });
  replacement.computerFileRoot = stateRoot;
  const recovered = await recoverPendingReplaySafeToolCalls({
    agentInput: {
      runId,
      runContext: createRunContext({
        threadId,
        stateRoot,
        workingDirectory: stateRoot,
      }),
      prompt: 'unused during recovery',
      runtimeServices: replacement,
      approvalContext: {
        computerSessionId: 'replacement-session',
        permissionMode: 'full_access',
      },
      onEvent() {},
    },
  });

  assert.equal(recovered.recoveredCallCount, 1);
  assert.equal(
    await readFile(targetPath, 'utf8'),
    'replacement with a different version\n',
  );
  const result = JSON.parse(
    (await readTranscriptEntries(stateRoot, threadId)).at(-1)?.content ?? '{}',
  ) as Record<string, unknown>;
  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'conflict');
  assert.deepEqual(
    await readCheckpointToolInvocations({ stateRoot, threadId }),
    [],
  );
});

void test('restart recovery projects a ready result without re-executing an opaque tool', async (t) => {
  const stateRoot = await mkdtemp(join(tmpdir(), 'geulbat-tool-recovery-'));
  t.after(async () => rm(stateRoot, { recursive: true, force: true }));
  const threadId = assertThreadId(randomUUID());
  const runId = assertRunId(randomUUID());
  const callId = 'call-ready-result';
  const toolName = 'opaque_ready_result_probe';
  const functionCall = {
    id: 'item-ready-result',
    callId,
    name: toolName,
    arguments: '{}',
  };
  const daemonContext = createDaemonContext({ homeStateRoot: stateRoot });
  let executions = 0;
  daemonContext.toolRegistry.registerTool(
    defineZodTool({
      name: toolName,
      description: 'Opaque result readiness recovery probe.',
      argsSchema: z.strictObject({}),
      sideEffectLevel: 'write',
      mayMutateComputerFiles: false,
      requiresApproval: false,
      async executeParsed() {
        executions += 1;
        return { ok: true, output: 'must not execute again' };
      },
    }),
  );
  await daemonContext.runCheckpoints.startRun({
    runId,
    threadId,
    request: { workingDirectory: stateRoot, permissionMode: 'basic' },
  });
  await appendTranscriptEntry(stateRoot, threadId, {
    role: 'user',
    content: 'settle the completed opaque tool',
    timestamp: '2026-07-18T00:00:00.000Z',
  });
  await appendTranscriptEntry(stateRoot, threadId, {
    role: 'tool_call',
    content: JSON.stringify({
      id: functionCall.id,
      callId,
      tool: toolName,
      args: {},
      round: 1,
    }),
    timestamp: '2026-07-18T00:00:01.000Z',
  });
  const resultRef = await persistToolResultReady({
    stateRoot,
    threadId,
    runId,
    ready: {
      functionCall,
      round: 1,
      toolResult: { ok: true, output: 'exact completed result' },
      computerFilesMayHaveChanged: true,
    },
  });
  await daemonContext.runCheckpoints.recordToolResultReady({
    threadId,
    runId,
    ready: { callId, toolName, resultRef },
  });

  const recovered = await recoverPendingReplaySafeToolCalls({
    agentInput: {
      runId,
      runContext: createRunContext({
        threadId,
        stateRoot,
        workingDirectory: stateRoot,
      }),
      prompt: 'unused during recovery',
      runtimeServices: daemonContext,
      approvalContext: {
        computerSessionId: 'replacement-session',
        permissionMode: 'basic',
      },
      onEvent() {},
    },
  });

  assert.equal(recovered.recoveredCallCount, 1);
  assert.equal(executions, 0);
  const results = (await readTranscriptEntries(stateRoot, threadId)).filter(
    (entry) => entry.role === 'tool_result',
  );
  assert.equal(results.length, 1);
  const stored = JSON.parse(results[0]?.content ?? '{}') as {
    computerFilesMayHaveChanged?: boolean;
    output?: string;
  };
  assert.equal(stored.output, 'exact completed result');
  assert.equal(stored.computerFilesMayHaveChanged, true);
  assert.deepEqual(
    (await daemonContext.runCheckpoints.readThread(threadId))?.toolResultsReady,
    [],
  );
});

void test('restart recovery clears an already-transcribed ready result without duplicating it', async (t) => {
  const stateRoot = await mkdtemp(join(tmpdir(), 'geulbat-tool-recovery-'));
  t.after(async () => rm(stateRoot, { recursive: true, force: true }));
  const threadId = assertThreadId(randomUUID());
  const runId = assertRunId(randomUUID());
  const callId = 'call-ready-result-transcribed';
  const toolName = 'opaque_transcribed_result_probe';
  const functionCall = {
    id: 'item-ready-result-transcribed',
    callId,
    name: toolName,
    arguments: '{}',
  };
  const daemonContext = createDaemonContext({ homeStateRoot: stateRoot });
  await daemonContext.runCheckpoints.startRun({
    runId,
    threadId,
    request: { workingDirectory: stateRoot, permissionMode: 'basic' },
  });
  await appendTranscriptEntry(stateRoot, threadId, {
    role: 'user',
    content: 'deduplicate the completed result',
    timestamp: '2026-07-18T00:00:00.000Z',
  });
  await appendTranscriptEntry(stateRoot, threadId, {
    role: 'tool_call',
    content: JSON.stringify({
      id: functionCall.id,
      callId,
      tool: toolName,
      args: {},
      round: 1,
    }),
    timestamp: '2026-07-18T00:00:01.000Z',
  });
  const resultRef = await persistToolResultReady({
    stateRoot,
    threadId,
    runId,
    ready: {
      functionCall,
      round: 1,
      toolResult: { ok: true, output: 'already transcribed result' },
      computerFilesMayHaveChanged: false,
    },
  });
  await daemonContext.runCheckpoints.recordToolResultReady({
    threadId,
    runId,
    ready: { callId, toolName, resultRef },
  });
  await appendTranscriptEntry(stateRoot, threadId, {
    role: 'tool_result',
    content: JSON.stringify({
      callId,
      tool: toolName,
      ok: true,
      computerFilesMayHaveChanged: false,
      displayText: 'already transcribed result',
      output: 'already transcribed result',
    }),
    timestamp: '2026-07-18T00:00:02.000Z',
  });

  const recovered = await recoverPendingReplaySafeToolCalls({
    agentInput: {
      runId,
      runContext: createRunContext({
        threadId,
        stateRoot,
        workingDirectory: stateRoot,
      }),
      prompt: 'unused during recovery',
      runtimeServices: daemonContext,
      approvalContext: {
        computerSessionId: 'replacement-session',
        permissionMode: 'basic',
      },
      onEvent() {},
    },
  });

  assert.equal(recovered.recoveredCallCount, 1);
  assert.equal(
    (await readTranscriptEntries(stateRoot, threadId)).filter(
      (entry) => entry.role === 'tool_result',
    ).length,
    1,
  );
  assert.deepEqual(
    (await daemonContext.runCheckpoints.readThread(threadId))?.toolResultsReady,
    [],
  );
});

void test('restart recovery replays a pending read_file invocation through the real builtin', async (t) => {
  const stateRoot = await mkdtemp(join(tmpdir(), 'geulbat-tool-recovery-'));
  t.after(async () => rm(stateRoot, { recursive: true, force: true }));
  const threadId = assertThreadId(randomUUID());
  const runId = assertRunId(randomUUID());
  await writeFile(
    join(stateRoot, 'restart-evidence.txt'),
    'recovered after restart\n',
    'utf8',
  );
  const daemonContext = createDaemonContext({ homeStateRoot: stateRoot });
  daemonContext.computerFileRoot = stateRoot;
  await appendTranscriptEntry(stateRoot, threadId, {
    role: 'user',
    content: 'read the restart evidence',
    timestamp: '2026-07-18T00:00:00.000Z',
  });
  await appendTranscriptEntry(stateRoot, threadId, {
    role: 'tool_call',
    content: JSON.stringify({
      id: 'item-read-file-restart',
      callId: 'call-read-file-restart',
      tool: 'read_file',
      args: { path: 'restart-evidence.txt', limit: 1 },
      round: 1,
      recoveryStrategy: 'replay_safe',
    }),
    timestamp: '2026-07-18T00:00:01.000Z',
  });

  const recovered = await recoverPendingReplaySafeToolCalls({
    agentInput: {
      runId,
      runContext: createRunContext({
        threadId,
        stateRoot,
        workingDirectory: stateRoot,
      }),
      prompt: 'unused during recovery',
      runtimeServices: daemonContext,
      approvalContext: {
        computerSessionId: 'replacement-session',
        permissionMode: 'basic',
      },
      onEvent() {},
    },
  });

  assert.equal(recovered.recoveredCallCount, 1);
  const entries = await readTranscriptEntries(stateRoot, threadId);
  const resultEntry = entries.find((entry) => entry.role === 'tool_result');
  assert.equal(resultEntry?.role, 'tool_result');
  if (resultEntry?.role !== 'tool_result') {
    assert.fail('expected the recovered read_file result');
  }
  const storedResult = JSON.parse(resultEntry.content) as {
    ok: boolean;
    output?: string;
  };
  assert.equal(storedResult.ok, true);
  assert.equal(typeof storedResult.output, 'string');
  const output = JSON.parse(storedResult.output ?? '{}') as {
    content?: string;
  };
  assert.equal(output.content, 'recovered after restart\n');
});

void test('restart recovery replays pure presentation tools through the product registry', async (t) => {
  const stateRoot = await mkdtemp(join(tmpdir(), 'geulbat-tool-recovery-'));
  t.after(async () => rm(stateRoot, { recursive: true, force: true }));
  const daemonContext = createDaemonContext({ homeStateRoot: stateRoot });
  const cases = [
    {
      tool: 'ask_user',
      args: {
        question: 'Which durable path should continue?',
        options: [
          {
            label: 'Existing path',
            description: 'Continue the persisted product path.',
          },
          {
            label: 'New path',
            description: 'Start a different product path.',
          },
        ],
      },
      expectedOutput: {
        asked: true,
        purpose: 'decision',
        optionCount: 2,
      },
    },
    {
      tool: 'suggest_followup',
      args: { prompt: 'Continue the durable follow-up' },
      expectedOutput: {
        ok: true,
        offered: 'Continue the durable follow-up',
      },
    },
    {
      tool: 'visualize',
      args: { code: '<svg></svg>', title: 'Recovered visual' },
      expectedOutput: {
        rendered: true,
        mode: 'svg',
        title: 'Recovered visual',
      },
    },
  ] as const;

  for (const recoveryCase of cases) {
    const threadId = assertThreadId(randomUUID());
    const runId = assertRunId(randomUUID());
    await appendTranscriptEntry(stateRoot, threadId, {
      role: 'user',
      content: `recover ${recoveryCase.tool}`,
      timestamp: '2026-07-27T00:00:00.000Z',
    });
    await appendTranscriptEntry(stateRoot, threadId, {
      role: 'tool_call',
      content: JSON.stringify({
        id: `item-${recoveryCase.tool}-restart`,
        callId: `call-${recoveryCase.tool}-restart`,
        tool: recoveryCase.tool,
        args: recoveryCase.args,
        round: 1,
        recoveryStrategy: 'replay_safe',
      }),
      timestamp: '2026-07-27T00:00:01.000Z',
    });

    const recovered = await recoverPendingReplaySafeToolCalls({
      agentInput: {
        runId,
        runContext: createRunContext({
          threadId,
          stateRoot,
          workingDirectory: stateRoot,
        }),
        prompt: 'unused during recovery',
        runtimeServices: daemonContext,
        approvalContext: {
          computerSessionId: 'replacement-session',
          permissionMode: 'basic',
        },
        onEvent() {},
      },
    });

    assert.equal(recovered.recoveredCallCount, 1, recoveryCase.tool);
    const entries = await readTranscriptEntries(stateRoot, threadId);
    const resultEntry = entries.find((entry) => entry.role === 'tool_result');
    assert.equal(resultEntry?.role, 'tool_result', recoveryCase.tool);
    if (resultEntry?.role !== 'tool_result') {
      assert.fail(`expected the recovered ${recoveryCase.tool} result`);
    }
    const storedResult = JSON.parse(resultEntry.content) as {
      ok: boolean;
      output?: string;
    };
    assert.equal(storedResult.ok, true, recoveryCase.tool);
    assert.deepEqual(
      JSON.parse(storedResult.output ?? '{}'),
      recoveryCase.expectedOutput,
      recoveryCase.tool,
    );
  }
});

void test('restart recovery rebuilds the derived memory index through the product registry', async (t) => {
  const stateRoot = await mkdtemp(join(tmpdir(), 'geulbat-tool-recovery-'));
  t.after(async () => rm(stateRoot, { recursive: true, force: true }));
  const threadId = assertThreadId(randomUUID());
  const runId = assertRunId(randomUUID());
  await mkdir(join(stateRoot, 'notes'), { recursive: true });
  await writeFile(
    join(stateRoot, 'notes', 'restart-memory.md'),
    '# Recovery\nrebuild the derived memory index\n',
    'utf8',
  );
  await appendTranscriptEntry(stateRoot, threadId, {
    role: 'user',
    content: 'refresh memory after restart',
    timestamp: '2026-07-28T00:00:00.000Z',
  });
  await appendTranscriptEntry(stateRoot, threadId, {
    role: 'tool_call',
    content: JSON.stringify({
      id: 'item-refresh-memory-index-restart',
      callId: 'call-refresh-memory-index-restart',
      tool: 'refresh_memory_index',
      args: {},
      round: 1,
      recoveryStrategy: 'replay_safe',
    }),
    timestamp: '2026-07-28T00:00:01.000Z',
  });
  const daemonContext = createDaemonContext({ homeStateRoot: stateRoot });
  daemonContext.computerFileRoot = stateRoot;

  const recovered = await recoverPendingReplaySafeToolCalls({
    agentInput: {
      runId,
      runContext: createRunContext({
        threadId,
        stateRoot,
        workingDirectory: stateRoot,
      }),
      prompt: 'unused during recovery',
      runtimeServices: daemonContext,
      approvalContext: {
        computerSessionId: 'replacement-session',
        permissionMode: 'full_access',
      },
      onEvent() {},
    },
  });

  assert.equal(recovered.recoveredCallCount, 1);
  const manifest = JSON.parse(
    await readFile(
      join(stateRoot, '.geulbat', 'index', 'manifest.json'),
      'utf8',
    ),
  ) as { files: Array<{ path: string }> };
  assert.equal(
    manifest.files.some((file) => file.path === 'notes/restart-memory.md'),
    true,
  );
  const entries = await readTranscriptEntries(stateRoot, threadId);
  const resultEntry = entries.find((entry) => entry.role === 'tool_result');
  assert.equal(resultEntry?.role, 'tool_result');
  if (resultEntry?.role !== 'tool_result') {
    assert.fail('expected the recovered refresh_memory_index result');
  }
  assert.equal((JSON.parse(resultEntry.content) as { ok: boolean }).ok, true);
});

void test('restart recovery reconciles one written memory note without appending it twice', async (t) => {
  const stateRoot = await mkdtemp(join(tmpdir(), 'geulbat-tool-recovery-'));
  t.after(async () => rm(stateRoot, { recursive: true, force: true }));
  const threadId = assertThreadId(randomUUID());
  const runId = assertRunId(randomUUID());
  const callId = 'call-write-memory-note-restart';
  const note = '크래시 창을 지나도 이 노트는 하나만 남는다';
  const original = createDaemonContext({ homeStateRoot: stateRoot });
  const runContext = createRunContext({
    threadId,
    stateRoot,
    workingDirectory: stateRoot,
  });
  const runState = createRunState({ runId, runContext });
  await original.runCheckpoints.startRun({
    runId,
    threadId,
    request: { workingDirectory: stateRoot, permissionMode: 'basic' },
  });
  await appendTranscriptEntry(stateRoot, threadId, {
    role: 'user',
    content: 'remember this after restart',
    timestamp: '2026-07-28T00:00:00.000Z',
  });
  await appendTranscriptEntry(stateRoot, threadId, {
    role: 'tool_call',
    content: JSON.stringify({
      id: 'item-write-memory-note-restart',
      callId,
      tool: 'write_memory_note',
      args: { note },
      round: 1,
      recoveryStrategy: 'reconcile_then_replay',
    }),
    timestamp: '2026-07-28T00:00:01.000Z',
  });

  const interruptedResult = await writeMemoryNoteTool.execute(
    { note },
    {
      kind: 'agent',
      runOwnerKind: 'root_main',
      callId,
      stateRoot,
      workingDirectory: stateRoot,
      threadId,
      runId,
      runState,
      signal: undefined,
      runSignal: undefined,
      currentFile: undefined,
      selection: undefined,
      approvalGranted: true,
      computerSessionId: 'original-session',
      permissionMode: 'basic',
      emitAgentEvent() {},
      memoryIndex: original.memoryIndex,
      runtimeServices: {
        ...original,
        runCheckpoints: {
          ...original.runCheckpoints,
          async recordToolInvocationResult() {
            assert.deepEqual(
              (await listPendingMemoryNotes(stateRoot)).map(
                (memoryNote) => memoryNote.text,
              ),
              [note],
            );
            throw new Error(
              'simulated daemon loss after memory note persistence',
            );
          },
        },
      },
    },
  );
  assert.equal(interruptedResult.ok, false);

  const replacement = createDaemonContext({ homeStateRoot: stateRoot });
  const recovered = await recoverPendingReplaySafeToolCalls({
    agentInput: {
      runId,
      runContext,
      prompt: 'unused during recovery',
      runtimeServices: replacement,
      approvalContext: {
        computerSessionId: 'replacement-session',
        permissionMode: 'basic',
      },
      runState,
      onEvent() {},
    },
  });

  assert.equal(recovered.recoveredCallCount, 1);
  assert.deepEqual(
    (await listPendingMemoryNotes(stateRoot)).map(
      (memoryNote) => memoryNote.text,
    ),
    [note],
  );
  const resultEntries = (
    await readTranscriptEntries(stateRoot, threadId)
  ).filter((entry) => entry.role === 'tool_result');
  assert.equal(resultEntries.length, 1);
  assert.equal(
    (
      JSON.parse(resultEntries[0]!.content) as {
        ok: boolean;
      }
    ).ok,
    true,
  );
});

void test('restart recovery reconciles one memory citation without counting it twice', async (t) => {
  const stateRoot = await mkdtemp(join(tmpdir(), 'geulbat-tool-recovery-'));
  t.after(async () => rm(stateRoot, { recursive: true, force: true }));
  const threadId = assertThreadId(randomUUID());
  const runId = assertRunId(randomUUID());
  const callId = 'call-cite-memory-restart';
  const { entryIds } = await commitMemoryEntries(stateRoot, [
    { id: undefined, text: 'restart-safe cited memory' },
  ]);
  const entryId = entryIds[0]!;
  const original = createDaemonContext({ homeStateRoot: stateRoot });
  const runContext = createRunContext({
    threadId,
    stateRoot,
    workingDirectory: stateRoot,
  });
  const runState = createRunState({ runId, runContext });
  await original.runCheckpoints.startRun({
    runId,
    threadId,
    request: { workingDirectory: stateRoot, permissionMode: 'basic' },
  });
  await appendTranscriptEntry(stateRoot, threadId, {
    role: 'user',
    content: 'cite this memory after restart',
    timestamp: '2026-07-28T00:00:00.000Z',
  });
  await appendTranscriptEntry(stateRoot, threadId, {
    role: 'tool_call',
    content: JSON.stringify({
      id: 'item-cite-memory-restart',
      callId,
      tool: 'cite_memory',
      args: { entryIds: [entryId] },
      round: 1,
      recoveryStrategy: 'reconcile_then_replay',
    }),
    timestamp: '2026-07-28T00:00:01.000Z',
  });

  const interruptedResult = await citeMemoryTool.execute(
    { entryIds: [entryId] },
    {
      kind: 'agent',
      runOwnerKind: 'root_main',
      callId,
      stateRoot,
      workingDirectory: stateRoot,
      threadId,
      runId,
      runState,
      signal: undefined,
      runSignal: undefined,
      currentFile: undefined,
      selection: undefined,
      approvalGranted: true,
      computerSessionId: 'original-session',
      permissionMode: 'basic',
      emitAgentEvent() {},
      memoryIndex: original.memoryIndex,
      runtimeServices: {
        ...original,
        runCheckpoints: {
          ...original.runCheckpoints,
          async recordToolInvocationResult() {
            assert.equal(
              (await readMemoryEntries(stateRoot))[0]?.usageCount,
              1,
            );
            throw new Error(
              'simulated daemon loss after memory citation persistence',
            );
          },
        },
      },
    },
  );
  assert.equal(interruptedResult.ok, false);

  const replacement = createDaemonContext({ homeStateRoot: stateRoot });
  const recovered = await recoverPendingReplaySafeToolCalls({
    agentInput: {
      runId,
      runContext,
      prompt: 'unused during recovery',
      runtimeServices: replacement,
      approvalContext: {
        computerSessionId: 'replacement-session',
        permissionMode: 'basic',
      },
      runState,
      onEvent() {},
    },
  });

  assert.equal(recovered.recoveredCallCount, 1);
  assert.equal((await readMemoryEntries(stateRoot))[0]?.usageCount, 1);
  const resultEntries = (
    await readTranscriptEntries(stateRoot, threadId)
  ).filter((entry) => entry.role === 'tool_result');
  assert.equal(resultEntries.length, 1);
  const recoveredResult = JSON.parse(resultEntries[0]!.content) as {
    ok: boolean;
    output?: string;
  };
  assert.equal(recoveredResult.ok, true);
  assert.deepEqual(JSON.parse(recoveredResult.output ?? '{}'), {
    ok: true,
    recorded: [entryId],
    unknown: [],
  });
});

void test('restart recovery restores one child result report summary on the replacement run state', async (t) => {
  const stateRoot = await mkdtemp(join(tmpdir(), 'geulbat-tool-recovery-'));
  const runtimeState = await createDaemonRuntimeStateStore({
    homeStateRoot: stateRoot,
  });
  t.after(async () => {
    runtimeState.close();
    await rm(stateRoot, { recursive: true, force: true });
  });
  const threadId = assertThreadId(randomUUID());
  const runId = assertRunId(randomUUID());
  const parentRunId = assertRunId(randomUUID());
  const runContext = createRunContext({
    threadId,
    stateRoot,
    workingDirectory: stateRoot,
  });
  const runState = createRunState({
    runId,
    parentRunId,
    runContext,
  });
  const summary = 'replacement child retained its compact handoff';
  await appendTranscriptEntry(stateRoot, threadId, {
    role: 'user',
    content: 'record the child result report',
    timestamp: '2026-07-28T00:00:00.000Z',
  });
  await appendTranscriptEntry(stateRoot, threadId, {
    role: 'tool_call',
    content: JSON.stringify({
      id: 'item-submit-result-report-restart',
      callId: 'call-submit-result-report-restart',
      tool: 'submit_result_report',
      args: { summary },
      round: 1,
      recoveryStrategy: 'replay_safe',
    }),
    timestamp: '2026-07-28T00:00:01.000Z',
  });
  const daemonContext = createDaemonContext({
    homeStateRoot: stateRoot,
    subagentTerminalDeliveries: runtimeState,
  });
  daemonContext.childRuns.registerChildRun({
    childRunId: runId,
    childThreadId: threadId,
    parentRunId,
    ownerThreadId: assertThreadId(randomUUID()),
    subagentType: 'explorer',
    modelPin: TEST_INHERITED_SOL_MODEL_PIN,
    subagentModelRouting: TEST_AUTO_SUBAGENT_MODEL_ROUTING,
  });

  const recovered = await recoverPendingReplaySafeToolCalls({
    agentInput: {
      runId,
      runContext,
      prompt: 'unused during recovery',
      runtimeServices: daemonContext,
      approvalContext: {
        computerSessionId: 'replacement-session',
        permissionMode: 'basic',
      },
      runState,
      onEvent() {},
    },
  });

  assert.equal(recovered.recoveredCallCount, 1);
  assert.equal(runState.subagentResultReportSummary, summary);
  const entries = await readTranscriptEntries(stateRoot, threadId);
  const resultEntry = entries.find((entry) => entry.role === 'tool_result');
  assert.equal(resultEntry?.role, 'tool_result');
  if (resultEntry?.role !== 'tool_result') {
    assert.fail('expected the recovered submit_result_report result');
  }
  assert.equal((JSON.parse(resultEntry.content) as { ok: boolean }).ok, true);
});

void test('restart recovery replays update_plan after its durable replacement while preserving execution binding', async (t) => {
  const stateRoot = await mkdtemp(join(tmpdir(), 'geulbat-tool-recovery-'));
  t.after(async () => rm(stateRoot, { recursive: true, force: true }));
  const threadId = assertThreadId(randomUUID());
  const runId = assertRunId(randomUUID());
  const callId = 'call-update-plan-restart';
  const toolArgs = {
    explanation: 'continue the approved work after restart',
    plan: [
      { id: 'step-1', step: 'Inspect durable state', status: 'completed' },
      { id: 'step-2', step: 'Continue execution', status: 'in_progress' },
    ],
  } as const;
  const execution = {
    approvedPlanRef: {
      workflowId: 'workflow-update-plan-restart',
      planId: 'plan-update-plan-restart',
      revision: 1,
      digest: `sha256:${'0'.repeat(64)}`,
    },
    executionRunId: runId,
  };
  const planStateDirectory = join(
    stateRoot,
    '.geulbat',
    'tool-state',
    'update-plan',
  );
  const planStatePath = join(planStateDirectory, `${threadId}.json`);
  await mkdir(planStateDirectory, { recursive: true });
  await writeFile(
    planStatePath,
    `${JSON.stringify({
      nextId: 3,
      items: [
        {
          id: 'step-1',
          text: 'Inspect durable state',
          status: 'pending',
          createdAt: 1,
        },
        {
          id: 'step-2',
          text: 'Continue execution',
          status: 'pending',
          createdAt: 1,
        },
      ],
      execution,
    })}\n`,
    'utf8',
  );
  await appendTranscriptEntry(stateRoot, threadId, {
    role: 'user',
    content: 'continue the approved plan',
    timestamp: '2026-07-27T00:00:00.000Z',
  });
  await appendTranscriptEntry(stateRoot, threadId, {
    role: 'tool_call',
    content: JSON.stringify({
      id: 'item-update-plan-restart',
      callId,
      tool: 'update_plan',
      args: toolArgs,
      round: 1,
      recoveryStrategy: 'replay_safe',
    }),
    timestamp: '2026-07-27T00:00:01.000Z',
  });

  const beforeRestart = createDaemonContext({ homeStateRoot: stateRoot });
  const tool = beforeRestart.toolRegistry.getTool('update_plan');
  assert.ok(tool);
  const firstResult = await tool.executeParsed(toolArgs, {
    callId,
    threadId,
    runId,
    stateRoot,
    workingDirectory: stateRoot,
    runtimeServices: beforeRestart,
  });
  assert.equal(firstResult.ok, true);

  const afterRestart = createDaemonContext({ homeStateRoot: stateRoot });
  const recovered = await recoverPendingReplaySafeToolCalls({
    agentInput: {
      runId,
      runContext: createRunContext({
        threadId,
        stateRoot,
        workingDirectory: stateRoot,
      }),
      prompt: 'unused during recovery',
      runtimeServices: afterRestart,
      approvalContext: {
        computerSessionId: 'replacement-session',
        permissionMode: 'basic',
      },
      onEvent() {},
    },
  });

  assert.equal(recovered.recoveredCallCount, 1);
  const entries = await readTranscriptEntries(stateRoot, threadId);
  const resultEntry = entries.find((entry) => entry.role === 'tool_result');
  assert.equal(resultEntry?.role, 'tool_result');
  if (resultEntry?.role !== 'tool_result') {
    assert.fail('expected the recovered update_plan result');
  }
  const storedResult = JSON.parse(resultEntry.content) as {
    ok: boolean;
    output?: string;
  };
  assert.equal(storedResult.ok, true);
  assert.deepEqual(JSON.parse(storedResult.output ?? '{}'), {
    ok: true,
    explanation: toolArgs.explanation,
    total: toolArgs.plan.length,
    plan: toolArgs.plan,
  });
  const persisted = JSON.parse(await readFile(planStatePath, 'utf8')) as {
    items: { id: string; text: string; status: string }[];
    execution?: unknown;
  };
  assert.deepEqual(
    persisted.items.map(({ id, text, status }) => ({ id, text, status })),
    toolArgs.plan.map(({ id, step, status }) => ({ id, text: step, status })),
  );
  assert.deepEqual(persisted.execution, execution);
});

void test('restart recovery reconciles propose_plan after its awaiting-approval snapshot was persisted', async (t) => {
  const stateRoot = await mkdtemp(join(tmpdir(), 'geulbat-tool-recovery-'));
  t.after(async () => rm(stateRoot, { recursive: true, force: true }));
  const threadId = assertThreadId(randomUUID());
  const runId = assertRunId(randomUUID());
  const callId = 'call-propose-plan-after-effect';
  const toolArgs = {
    outcome: 'Keep the exact durable plan across restart',
    steps: [
      {
        id: 'reconcile',
        text: 'Reconcile the persisted plan snapshot',
        acceptanceCriteria: ['The plan identity remains unchanged'],
      },
    ],
    decisions: [],
    assumptions: [],
    openQuestions: [],
  };
  const beforeRestart = createDaemonContext({ homeStateRoot: stateRoot });
  await beforeRestart.planningWorkflows.enterOrResume({
    threadId,
    requested: true,
    intensity: 'visual',
    depth: 'standard',
    executionTemplate: {
      workingDirectory: stateRoot,
      permissionMode: 'basic',
    },
  });
  await appendTranscriptEntry(stateRoot, threadId, {
    role: 'user',
    content: 'propose the exact durable plan',
    timestamp: '2026-07-27T00:00:00.000Z',
  });
  await appendTranscriptEntry(stateRoot, threadId, {
    role: 'tool_call',
    content: JSON.stringify({
      id: 'item-propose-plan-after-effect',
      callId,
      tool: 'propose_plan',
      args: toolArgs,
      round: 1,
      recoveryStrategy: 'reconcile_then_replay',
    }),
    timestamp: '2026-07-27T00:00:01.000Z',
  });

  const tool = beforeRestart.toolRegistry.getTool('propose_plan');
  assert.ok(tool);
  const firstResult = await tool.executeParsed(toolArgs, {
    kind: 'agent',
    callId,
    threadId,
    runId,
    stateRoot,
    workingDirectory: stateRoot,
    runtimeServices: beforeRestart,
    emitAgentEvent() {},
  });
  assert.equal(firstResult.ok, true);
  const snapshotBeforeRestart =
    await beforeRestart.planningWorkflows.readThread(threadId);
  assert.equal(snapshotBeforeRestart?.state, 'awaiting_approval');

  const afterRestart = createDaemonContext({ homeStateRoot: stateRoot });
  const recovered = await recoverPendingReplaySafeToolCalls({
    agentInput: {
      runId,
      runContext: createRunContext({
        threadId,
        stateRoot,
        workingDirectory: stateRoot,
      }),
      prompt: 'unused during recovery',
      runtimeServices: afterRestart,
      approvalContext: {
        computerSessionId: 'replacement-session',
        permissionMode: 'basic',
      },
      onEvent() {},
    },
  });

  assert.equal(recovered.recoveredCallCount, 1);
  const entries = await readTranscriptEntries(stateRoot, threadId);
  const resultEntry = entries.find((entry) => entry.role === 'tool_result');
  assert.equal(resultEntry?.role, 'tool_result');
  if (resultEntry?.role !== 'tool_result') {
    assert.fail('expected the recovered propose_plan result');
  }
  const storedResult = JSON.parse(resultEntry.content) as {
    ok: boolean;
    output?: string;
  };
  assert.equal(storedResult.ok, true);
  assert.equal(storedResult.output, firstResult.output);
  assert.deepEqual(
    await afterRestart.planningWorkflows.readThread(threadId),
    snapshotBeforeRestart,
  );
});

void test('restart recovery executes a journaled propose_plan before its transcript entry existed', async (t) => {
  const stateRoot = await mkdtemp(join(tmpdir(), 'geulbat-tool-recovery-'));
  t.after(async () => rm(stateRoot, { recursive: true, force: true }));
  const threadId = assertThreadId(randomUUID());
  const runId = assertRunId(randomUUID());
  const callId = 'call-propose-plan-before-transcript';
  const toolArgs = {
    outcome: 'Recover the provider-journaled plan',
    steps: [
      {
        id: 'resume',
        text: 'Resume before public transcript persistence',
        acceptanceCriteria: ['The durable workflow awaits approval'],
      },
    ],
    decisions: [],
    assumptions: [],
    openQuestions: [],
  };
  const beforeRestart = createDaemonContext({ homeStateRoot: stateRoot });
  await beforeRestart.planningWorkflows.enterOrResume({
    threadId,
    requested: true,
    intensity: 'quiet',
    depth: 'standard',
    executionTemplate: {
      workingDirectory: stateRoot,
      permissionMode: 'basic',
    },
  });
  const user = await appendTranscriptEntry(stateRoot, threadId, {
    role: 'user',
    content: 'recover the provider-journaled plan',
    timestamp: '2026-07-27T00:00:00.000Z',
  });
  const rawFunctionCall = {
    id: 'item-propose-plan-before-transcript',
    type: 'function_call',
    call_id: callId,
    name: 'propose_plan',
    arguments: JSON.stringify(toolArgs),
    status: 'completed',
  };
  const functionCalls = [
    {
      id: rawFunctionCall.id,
      callId: rawFunctionCall.call_id,
      name: rawFunctionCall.name,
      arguments: rawFunctionCall.arguments,
      replaySafe: false,
      recoveryStrategy: 'reconcile_then_replay' as const,
    },
  ];
  await appendProviderRound({
    stateRoot,
    threadId,
    runId,
    round: 0,
    providerId: beforeRestart.provider.requestOptions.providerId,
    model: beforeRestart.provider.requestOptions.model,
    replayScopeId: `sha256:${'c'.repeat(64)}` as ProviderReplayScopeId,
    precedingTranscriptEntryId: user.entryId,
    items: [rawFunctionCall],
    functionCalls,
  });

  const afterRestart = createDaemonContext({ homeStateRoot: stateRoot });
  const recovered = await recoverPendingReplaySafeToolCalls({
    agentInput: {
      runId,
      runContext: createRunContext({
        threadId,
        stateRoot,
        workingDirectory: stateRoot,
      }),
      prompt: 'unused during recovery',
      runtimeServices: afterRestart,
      approvalContext: {
        computerSessionId: 'replacement-session',
        permissionMode: 'basic',
      },
      onEvent() {},
    },
  });

  assert.equal(recovered.recoveredCallCount, 1);
  assert.equal(
    (await afterRestart.planningWorkflows.readThread(threadId))?.state,
    'awaiting_approval',
  );
  const entries = await readTranscriptEntries(stateRoot, threadId);
  assert.equal(entries.filter((entry) => entry.role === 'tool_call').length, 1);
  const resultEntry = entries.find((entry) => entry.role === 'tool_result');
  assert.equal(resultEntry?.role, 'tool_result');
  if (resultEntry?.role !== 'tool_result') {
    assert.fail('expected the provider-journaled propose_plan result');
  }
  const storedResult = JSON.parse(resultEntry.content) as { ok: boolean };
  assert.equal(storedResult.ok, true);
});

void test('restart recovery replays pending agent_wait through the durable terminal store', async (t) => {
  const stateRoot = await mkdtemp(join(tmpdir(), 'geulbat-tool-recovery-'));
  const threadId = assertThreadId(randomUUID());
  const runId = assertRunId(randomUUID());
  const childRunId = assertRunId(randomUUID());
  const childThreadId = assertThreadId(randomUUID());
  let runtimeState = await createDaemonRuntimeStateStore({
    homeStateRoot: stateRoot,
  });
  runtimeState.recordSubagentTerminalDelivery({
    ownerThreadId: threadId,
    result: {
      deliveryId: 'delivery-agent-wait-restart',
      parentRunId: runId,
      childRunId,
      childThreadId,
      subagentType: 'worker',
      terminalState: 'completed',
      result: 'durable child result after restart',
      completedAt: '2026-07-27T00:00:00.000Z',
    },
  });
  runtimeState.close();
  runtimeState = await createDaemonRuntimeStateStore({
    homeStateRoot: stateRoot,
  });
  t.after(async () => {
    runtimeState.close();
    await rm(stateRoot, { recursive: true, force: true });
  });
  const daemonContext = createDaemonContext({
    homeStateRoot: stateRoot,
    subagentLaunchRequests: runtimeState,
    subagentTerminalDeliveries: runtimeState,
  });
  await appendTranscriptEntry(stateRoot, threadId, {
    role: 'user',
    content: 'join the durable child after restart',
    timestamp: '2026-07-27T00:00:01.000Z',
  });
  await appendTranscriptEntry(stateRoot, threadId, {
    role: 'tool_call',
    content: JSON.stringify({
      id: 'item-agent-wait-restart',
      callId: 'call-agent-wait-restart',
      tool: 'agent_wait',
      args: { child_run_ids: [childRunId], wait_mode: 'all' },
      round: 1,
      recoveryStrategy: 'replay_safe',
    }),
    timestamp: '2026-07-27T00:00:02.000Z',
  });

  const recovered = await recoverPendingReplaySafeToolCalls({
    agentInput: {
      runId,
      runContext: createRunContext({
        threadId,
        stateRoot,
        workingDirectory: stateRoot,
      }),
      prompt: 'unused during recovery',
      runtimeServices: daemonContext,
      approvalContext: {
        computerSessionId: 'replacement-session',
        permissionMode: 'basic',
      },
      onEvent() {},
    },
  });

  assert.equal(recovered.recoveredCallCount, 1);
  const entries = await readTranscriptEntries(stateRoot, threadId);
  const resultEntry = entries.find((entry) => entry.role === 'tool_result');
  assert.equal(resultEntry?.role, 'tool_result');
  if (resultEntry?.role !== 'tool_result') {
    assert.fail('expected the recovered agent_wait result');
  }
  const storedResult = JSON.parse(resultEntry.content) as {
    ok: boolean;
    output?: string;
  };
  assert.equal(storedResult.ok, true);
  const output = JSON.parse(storedResult.output ?? '{}') as {
    completed?: Array<{
      childRunId?: string;
      result?: string;
      resultDigest?: string;
      resultRef?: string;
      terminalState?: string;
    }>;
  };
  assert.equal(output.completed?.length, 1);
  assert.equal(output.completed?.[0]?.childRunId, childRunId);
  assert.equal(output.completed?.[0]?.terminalState, 'completed');
  assert.equal(
    output.completed?.[0]?.result,
    'durable child result after restart',
  );
  assert.match(output.completed?.[0]?.resultRef ?? '', /^subagent-result:/u);
  assert.match(output.completed?.[0]?.resultDigest ?? '', /^sha256:/u);
});

void test('restart recovery replays a pending read_tool_output page through the durable store', async (t) => {
  const stateRoot = await mkdtemp(join(tmpdir(), 'geulbat-tool-recovery-'));
  t.after(async () => rm(stateRoot, { recursive: true, force: true }));
  const threadId = assertThreadId(randomUUID());
  const runId = assertRunId(randomUUID());
  const sourceCallId = 'call-restart-output-source';
  const outputRef = buildToolOutputRef({
    threadId,
    runId,
    callId: sourceCallId,
  });
  await writeToolOutputSnapshot({
    stateRoot,
    snapshot: buildToolOutputSnapshot({
      outputRef,
      threadId,
      runId,
      callId: sourceCallId,
      toolName: 'fetch_url',
      output: '0123456789',
    }),
  });
  const daemonContext = createDaemonContext({ homeStateRoot: stateRoot });
  await appendTranscriptEntry(stateRoot, threadId, {
    role: 'user',
    content: 'read the durable output page',
    timestamp: '2026-07-18T00:00:00.000Z',
  });
  await appendTranscriptEntry(stateRoot, threadId, {
    role: 'tool_call',
    content: JSON.stringify({
      id: 'item-read-tool-output-restart',
      callId: 'call-read-tool-output-restart',
      tool: 'read_tool_output',
      args: { outputRef, offset: 2, limit: 4 },
      round: 1,
      recoveryStrategy: 'replay_safe',
    }),
    timestamp: '2026-07-18T00:00:01.000Z',
  });

  const recovered = await recoverPendingReplaySafeToolCalls({
    agentInput: {
      runId,
      runContext: createRunContext({
        threadId,
        stateRoot,
        workingDirectory: stateRoot,
      }),
      prompt: 'unused during recovery',
      runtimeServices: daemonContext,
      approvalContext: {
        computerSessionId: 'replacement-session',
        permissionMode: 'basic',
      },
      onEvent() {},
    },
  });

  assert.equal(recovered.recoveredCallCount, 1);
  const entries = await readTranscriptEntries(stateRoot, threadId);
  const resultEntry = entries.find((entry) => entry.role === 'tool_result');
  assert.equal(resultEntry?.role, 'tool_result');
  if (resultEntry?.role !== 'tool_result') {
    assert.fail('expected the recovered read_tool_output result');
  }
  const storedResult = JSON.parse(resultEntry.content) as {
    ok: boolean;
    output?: string;
  };
  assert.equal(storedResult.ok, true);
  assert.equal(typeof storedResult.output, 'string');
  const output = JSON.parse(storedResult.output ?? '{}') as {
    content?: string;
    endOffset?: number;
    nextOffset?: number | null;
    offset?: number;
    outputRef?: string;
  };
  assert.equal(output.outputRef, outputRef);
  assert.equal(output.content, '2345');
  assert.equal(output.offset, 2);
  assert.equal(output.endOffset, 6);
  assert.equal(output.nextOffset, 6);
});

void test('restart recovery replays pending tool_search through the live builtin catalog', async (t) => {
  const stateRoot = await mkdtemp(join(tmpdir(), 'geulbat-tool-recovery-'));
  t.after(async () => rm(stateRoot, { recursive: true, force: true }));
  const threadId = assertThreadId(randomUUID());
  const runId = assertRunId(randomUUID());
  const daemonContext = createDaemonContext({ homeStateRoot: stateRoot });
  await appendTranscriptEntry(stateRoot, threadId, {
    role: 'user',
    content: 'find the file reader after restart',
    timestamp: '2026-07-18T00:00:00.000Z',
  });
  await appendTranscriptEntry(stateRoot, threadId, {
    role: 'tool_call',
    content: JSON.stringify({
      id: 'item-tool-search-restart',
      callId: 'call-tool-search-restart',
      tool: 'tool_search',
      args: { query: 'cat file' },
      round: 1,
      recoveryStrategy: 'replay_safe',
    }),
    timestamp: '2026-07-18T00:00:01.000Z',
  });

  const recovered = await recoverPendingReplaySafeToolCalls({
    agentInput: {
      runId,
      runContext: createRunContext({
        threadId,
        stateRoot,
        workingDirectory: stateRoot,
      }),
      prompt: 'unused during recovery',
      runtimeServices: daemonContext,
      approvalContext: {
        computerSessionId: 'replacement-session',
        permissionMode: 'basic',
      },
      onEvent() {},
    },
  });

  assert.equal(recovered.recoveredCallCount, 1);
  const entries = await readTranscriptEntries(stateRoot, threadId);
  const resultEntry = entries.find((entry) => entry.role === 'tool_result');
  assert.equal(resultEntry?.role, 'tool_result');
  if (resultEntry?.role !== 'tool_result') {
    assert.fail('expected the recovered tool_search result');
  }
  const storedResult = JSON.parse(resultEntry.content) as {
    ok: boolean;
    output?: string;
  };
  assert.equal(storedResult.ok, true);
  assert.equal(typeof storedResult.output, 'string');
  const output = JSON.parse(storedResult.output ?? '{}') as {
    results?: Array<{ publicName?: string }>;
  };
  assert.equal(output.results?.[0]?.publicName, 'read_file');
});

void test('restart recovery replays pending skill_search through the verified bundled catalog', async (t) => {
  const stateRoot = await mkdtemp(join(tmpdir(), 'geulbat-tool-recovery-'));
  t.after(async () => rm(stateRoot, { recursive: true, force: true }));
  const threadId = assertThreadId(randomUUID());
  const runId = assertRunId(randomUUID());
  const daemonContext = createDaemonContext({
    homeStateRoot: stateRoot,
    bundledCreatorPluginRoot: fileURLToPath(
      new URL('../../../creator-plugin', import.meta.url),
    ),
  });
  daemonContext.globalMcp.attachSessionCoordinateStore({
    readMcpSessionCoordinate: () => undefined,
    persistMcpSessionCoordinate: () => undefined,
    deleteMcpSessionCoordinate: () => undefined,
  });
  await daemonContext.plugins.initialize();
  await appendTranscriptEntry(stateRoot, threadId, {
    role: 'user',
    content: 'find the plugin creator after restart',
    timestamp: '2026-07-18T00:00:00.000Z',
  });
  await appendTranscriptEntry(stateRoot, threadId, {
    role: 'tool_call',
    content: JSON.stringify({
      id: 'item-skill-search-restart',
      callId: 'call-skill-search-restart',
      tool: 'skill_search',
      args: { query: 'create plugin', invocation: 'explicit' },
      round: 1,
      recoveryStrategy: 'replay_safe',
    }),
    timestamp: '2026-07-18T00:00:01.000Z',
  });

  const recovered = await recoverPendingReplaySafeToolCalls({
    agentInput: {
      runId,
      runContext: createRunContext({
        threadId,
        stateRoot,
        workingDirectory: stateRoot,
      }),
      prompt: 'unused during recovery',
      runtimeServices: daemonContext,
      approvalContext: {
        computerSessionId: 'replacement-session',
        permissionMode: 'basic',
      },
      onEvent() {},
    },
  });

  assert.equal(recovered.recoveredCallCount, 1);
  const entries = await readTranscriptEntries(stateRoot, threadId);
  const resultEntry = entries.find((entry) => entry.role === 'tool_result');
  assert.equal(resultEntry?.role, 'tool_result');
  if (resultEntry?.role !== 'tool_result') {
    assert.fail('expected the recovered skill_search result');
  }
  const storedResult = JSON.parse(resultEntry.content) as {
    ok: boolean;
    output?: string;
  };
  assert.equal(storedResult.ok, true);
  assert.equal(typeof storedResult.output, 'string');
  const output = JSON.parse(storedResult.output ?? '{}') as {
    results?: Array<{ name?: string }>;
  };
  assert.equal(output.results?.[0]?.name, 'plugin-creator');
});

void test('restart recovery replays pending list_commands against a surviving worker session', async (t) => {
  const stateRoot = await mkdtemp(join(tmpdir(), 'geulbat-tool-recovery-'));
  const threadId = assertThreadId(randomUUID());
  const runId = assertRunId(randomUUID());
  const beforeRestart = createDaemonContext({
    homeStateRoot: stateRoot,
    hostCommands: { inlineMaxBytes: 128 },
  });
  let beforeRestartClosed = false;
  let afterRestart: ReturnType<typeof createDaemonContext> | undefined;
  t.after(async () => {
    if (!beforeRestartClosed) {
      await beforeRestart.hostCommands.closeAll();
    }
    await afterRestart?.hostCommands.closeAll();
    await removeCommandHostWorkspace(stateRoot);
  });

  const started = await beforeRestart.hostCommands.start({
    executable: process.execPath,
    args: ['-e', "process.stdout.write('ready'); setInterval(() => {}, 1000);"],
    cwd: stateRoot,
    env: process.env,
    stateRoot,
    threadId,
    runId,
    callId: 'call-list-commands-source',
    stdinMode: 'open',
  });
  assert.equal(started.ok, true);
  if (!started.ok) {
    return;
  }
  const initial = await beforeRestart.hostCommands.waitForInitialResult({
    stateRoot,
    outputRef: started.outputRef,
    yieldTimeMs: 0,
  });
  assert.equal(initial.ok, true);
  if (!initial.ok) {
    return;
  }
  assert.equal(initial.value.status, 'running');
  await appendTranscriptEntry(stateRoot, threadId, {
    role: 'user',
    content: 'recover the command session reference',
    timestamp: '2026-07-18T00:00:00.000Z',
  });
  await appendTranscriptEntry(stateRoot, threadId, {
    role: 'tool_call',
    content: JSON.stringify({
      id: 'item-list-commands-restart',
      callId: 'call-list-commands-restart',
      tool: 'list_commands',
      args: {},
      round: 1,
      recoveryStrategy: 'replay_safe',
    }),
    timestamp: '2026-07-18T00:00:01.000Z',
  });

  const disconnected = await beforeRestart.hostCommands.closeAll();
  assert.equal(disconnected.ok, true);
  beforeRestartClosed = true;
  afterRestart = createDaemonContext({
    homeStateRoot: stateRoot,
    hostCommands: { inlineMaxBytes: 128 },
  });
  const recovered = await recoverPendingReplaySafeToolCalls({
    agentInput: {
      runId,
      runContext: createRunContext({
        threadId,
        stateRoot,
        workingDirectory: stateRoot,
      }),
      prompt: 'unused during recovery',
      runtimeServices: afterRestart,
      approvalContext: {
        computerSessionId: 'replacement-session',
        permissionMode: 'basic',
      },
      onEvent() {},
    },
  });

  assert.equal(recovered.recoveredCallCount, 1);
  const entries = await readTranscriptEntries(stateRoot, threadId);
  const resultEntry = entries.find((entry) => entry.role === 'tool_result');
  assert.equal(resultEntry?.role, 'tool_result');
  if (resultEntry?.role !== 'tool_result') {
    assert.fail('expected the recovered list_commands result');
  }
  const storedResult = JSON.parse(resultEntry.content) as {
    ok: boolean;
    output?: string;
  };
  assert.equal(storedResult.ok, true);
  assert.equal(typeof storedResult.output, 'string');
  const output = JSON.parse(storedResult.output ?? '{}') as {
    sessions?: Array<{
      outputRef?: string;
      running?: boolean;
      status?: string;
    }>;
  };
  assert.equal(output.sessions?.length, 1);
  assert.equal(output.sessions?.[0]?.outputRef, started.outputRef);
  assert.equal(output.sessions?.[0]?.running, true);
  assert.equal(output.sessions?.[0]?.status, 'running');
});

void test('restart recovery reattaches pending exec_command to the same claimed worker session', async (t) => {
  const stateRoot = await mkdtemp(join(tmpdir(), 'geulbat-tool-recovery-'));
  const threadId = assertThreadId(randomUUID());
  const runId = assertRunId(randomUUID());
  const callId = 'call-exec-command-restart';
  const commandArgs = {
    cmd: `node -e "process.stdout.write('restart:' + process.pid); process.stdin.resume()"`,
    yieldTimeMs: 0,
    stdinMode: 'open' as const,
  };
  const createRecoveryContext = () => {
    const previousRoot = process.env['GEULBAT_COMPUTER_SESSION_ROOT'];
    process.env['GEULBAT_COMPUTER_SESSION_ROOT'] = stateRoot;
    try {
      return createDaemonContext({
        homeStateRoot: stateRoot,
        hostCommands: { inlineMaxBytes: 128 },
      });
    } finally {
      if (previousRoot === undefined) {
        delete process.env['GEULBAT_COMPUTER_SESSION_ROOT'];
      } else {
        process.env['GEULBAT_COMPUTER_SESSION_ROOT'] = previousRoot;
      }
    }
  };
  const original = createRecoveryContext();
  original.computerFileRoot = stateRoot;
  let originalClosed = false;
  let interruptedArchive: HostCommandFullOutputArchiveHandle | undefined;
  let replacement: ReturnType<typeof createDaemonContext> | undefined;
  t.after(async () => {
    t.diagnostic('exec-recovery milestone: cleanup started');
    if (replacement !== undefined) {
      const sessions = await replacement.hostCommands.listThreadSessions({
        stateRoot,
        threadId,
      });
      t.diagnostic(
        `exec-recovery milestone: cleanup found ${String(sessions.length)} replacement session(s)`,
      );
      for (const session of sessions) {
        await replacement.hostCommands.interact({
          stateRoot,
          threadId,
          outputRef: session.outputRef,
          terminate: true,
          yieldTimeMs: 0,
        });
      }
      t.diagnostic('exec-recovery milestone: replacement sessions terminated');
      await replacement.hostCommands.closeAll();
      t.diagnostic('exec-recovery milestone: replacement host closed');
    }
    if (!originalClosed) {
      await original.hostCommands.closeAll();
      t.diagnostic('exec-recovery milestone: original host closed by cleanup');
    }
    await interruptedArchive?.completed;
    t.diagnostic('exec-recovery milestone: archive completion observed');
    await removeCommandHostWorkspace(stateRoot);
    t.diagnostic('exec-recovery milestone: command workspace removed');
    await rm(stateRoot, { recursive: true, force: true });
    t.diagnostic('exec-recovery milestone: cleanup completed');
  });
  await original.runCheckpoints.startRun({
    runId,
    threadId,
    request: { workingDirectory: stateRoot, permissionMode: 'full_access' },
  });
  await appendTranscriptEntry(stateRoot, threadId, {
    role: 'user',
    content: 'keep the exact command session across daemon restart',
    timestamp: '2026-07-27T00:00:00.000Z',
  });
  await appendTranscriptEntry(stateRoot, threadId, {
    role: 'tool_call',
    content: JSON.stringify({
      id: 'item-exec-command-restart',
      callId,
      tool: 'exec_command',
      args: commandArgs,
      round: 1,
      recoveryStrategy: 'reconcile_then_replay',
    }),
    timestamp: '2026-07-27T00:00:01.000Z',
  });
  let originalOutputRef: string | undefined;
  const interruptedHost: HostCommandRuntime = {
    ...original.hostCommands,
    async start(startArgs) {
      const invocation = (
        await original.runCheckpoints.readThread(threadId)
      )?.toolInvocations.find((candidate) => candidate.callId === callId);
      assert.equal(invocation?.status, 'in_flight');
      const started = await original.hostCommands.start(startArgs);
      assert.equal(started.ok, true);
      if (started.ok) {
        originalOutputRef = started.outputRef;
      }
      return started;
    },
    async waitForInitialResult(waitArgs) {
      const waited = await original.hostCommands.waitForInitialResult(waitArgs);
      assert.equal(waited.ok, true);
      throw new Error('simulated daemon loss after exec_command session claim');
    },
  };
  await assert.rejects(
    execCommandTool.execute(commandArgs, {
      kind: 'agent',
      callId,
      signal: undefined,
      runSignal: undefined,
      currentFile: undefined,
      selection: undefined,
      approvalGranted: true,
      computerSessionId: 'original-session',
      computerFileRoot: stateRoot,
      permissionMode: 'full_access',
      stateRoot,
      threadId,
      runId,
      runOwnerKind: 'root_main',
      workingDirectory: stateRoot,
      runState: undefined,
      memoryIndex: original.memoryIndex,
      runtimeServices: {
        ...original,
        hostCommands: interruptedHost,
      },
      emitAgentEvent() {},
    }),
    /simulated daemon loss/u,
  );
  t.diagnostic('exec-recovery milestone: interrupted command claimed');
  assert.match(originalOutputRef ?? '', /^command-output:/u);
  if (originalOutputRef === undefined) {
    assert.fail('expected the interrupted command output reference');
  }
  const activeArchive = await ensureHostCommandFullOutputArchive({
    hostCommands: interruptedHost,
    stateRoot,
    threadId,
    outputRef: originalOutputRef,
    pageLimitBytes: 128,
    createIfMissing: false,
    activateRelease: true,
  });
  assert.ok(activeArchive);
  if (activeArchive === null) {
    assert.fail('expected the interrupted full-output archive owner');
  }
  interruptedArchive = activeArchive;
  t.diagnostic('exec-recovery milestone: output archive activated');

  const disconnected = await original.hostCommands.closeAll();
  assert.equal(disconnected.ok, true);
  originalClosed = true;
  t.diagnostic('exec-recovery milestone: original host disconnected');
  const interruptedArchiveResult = await interruptedArchive.completed;
  t.diagnostic('exec-recovery milestone: interrupted archive settled');
  assert.equal(interruptedArchiveResult.ok, false);
  if (interruptedArchiveResult.ok) {
    assert.fail('expected the interrupted full-output archive to stop');
  }
  assert.match(interruptedArchiveResult.message, /connection was lost/u);
  replacement = createRecoveryContext();
  replacement.computerFileRoot = stateRoot;
  const recovered = await recoverPendingReplaySafeToolCalls({
    agentInput: {
      runId,
      runContext: createRunContext({
        threadId,
        stateRoot,
        workingDirectory: stateRoot,
      }),
      prompt: 'unused during recovery',
      runtimeServices: replacement,
      approvalContext: {
        computerSessionId: 'replacement-session',
        permissionMode: 'full_access',
      },
      onEvent() {},
    },
  });
  t.diagnostic('exec-recovery milestone: pending call recovered');

  assert.equal(recovered.recoveredCallCount, 1);
  const resultEntry = (await readTranscriptEntries(stateRoot, threadId)).find(
    (entry) => entry.role === 'tool_result',
  );
  assert.equal(resultEntry?.role, 'tool_result');
  if (resultEntry?.role !== 'tool_result') {
    assert.fail('expected the recovered exec_command result');
  }
  const storedResult = JSON.parse(resultEntry.content) as {
    ok: boolean;
    output?: string;
  };
  assert.equal(storedResult.ok, true);
  const output = JSON.parse(storedResult.output ?? '{}') as {
    outputRef?: string | null;
    status?: string;
  };
  assert.equal(output.outputRef, originalOutputRef);
  assert.equal(output.status, 'running');
  const sessions = await replacement.hostCommands.listThreadSessions({
    stateRoot,
    threadId,
  });
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0]?.outputRef, originalOutputRef);
  assert.deepEqual(
    await readCheckpointToolInvocations({ stateRoot, threadId }),
    [],
  );
  t.diagnostic('exec-recovery milestone: assertions completed');
});

void test('restart recovery replays set_thread_title after its durable effect without rewriting the title', async (t) => {
  const stateRoot = await mkdtemp(join(tmpdir(), 'geulbat-tool-recovery-'));
  t.after(async () => rm(stateRoot, { recursive: true, force: true }));
  const threadId = assertThreadId(randomUUID());
  const runId = assertRunId(randomUUID());
  const title = 'Restart-safe thread title';
  const beforeRestart = createDaemonContext({ homeStateRoot: stateRoot });
  await appendTranscriptEntry(stateRoot, threadId, {
    role: 'user',
    content: 'set a durable title',
    timestamp: '2026-07-18T00:00:00.000Z',
  });
  await appendTranscriptEntry(stateRoot, threadId, {
    role: 'tool_call',
    content: JSON.stringify({
      id: 'item-set-thread-title-restart',
      callId: 'call-set-thread-title-restart',
      tool: 'set_thread_title',
      args: { title },
      round: 1,
      recoveryStrategy: 'replay_safe',
    }),
    timestamp: '2026-07-18T00:00:01.000Z',
  });

  const tool = beforeRestart.toolRegistry.getTool('set_thread_title');
  assert.ok(tool);
  const firstResult = await tool.executeParsed(
    { title },
    {
      callId: 'call-set-thread-title-restart',
      threadId,
      runId,
      stateRoot,
      workingDirectory: stateRoot,
      runtimeServices: beforeRestart,
    },
  );
  assert.equal(firstResult.ok, true);
  const indexAfterFirstEffect =
    await beforeRestart.threadIndex.loadThreadIndex(stateRoot);
  assert.equal(indexAfterFirstEffect.length, 1);
  assert.equal(indexAfterFirstEffect[0]?.title, title);

  const afterRestart = createDaemonContext({ homeStateRoot: stateRoot });
  const recovered = await recoverPendingReplaySafeToolCalls({
    agentInput: {
      runId,
      runContext: createRunContext({
        threadId,
        stateRoot,
        workingDirectory: stateRoot,
      }),
      prompt: 'unused during recovery',
      runtimeServices: afterRestart,
      approvalContext: {
        computerSessionId: 'replacement-session',
        permissionMode: 'basic',
      },
      onEvent() {},
    },
  });

  assert.equal(recovered.recoveredCallCount, 1);
  const entries = await readTranscriptEntries(stateRoot, threadId);
  const resultEntry = entries.find((entry) => entry.role === 'tool_result');
  assert.equal(resultEntry?.role, 'tool_result');
  if (resultEntry?.role !== 'tool_result') {
    assert.fail('expected the recovered set_thread_title result');
  }
  const storedResult = JSON.parse(resultEntry.content) as {
    ok: boolean;
    output?: string;
  };
  assert.equal(storedResult.ok, true);
  assert.equal(typeof storedResult.output, 'string');
  assert.deepEqual(JSON.parse(storedResult.output ?? '{}'), {
    ok: true,
    skipped: 'already_titled',
    title,
  });
  assert.deepEqual(
    await afterRestart.threadIndex.loadThreadIndex(stateRoot),
    indexAfterFirstEffect,
  );
});

void test('restart recovery settles a journaled pre-transcript call before the next provider continuation', async (t) => {
  const stateRoot = await mkdtemp(join(tmpdir(), 'geulbat-tool-recovery-'));
  t.after(async () => rm(stateRoot, { recursive: true, force: true }));
  const threadId = assertThreadId(randomUUID());
  const runId = assertRunId(randomUUID());
  const daemonContext = createDaemonContext({ homeStateRoot: stateRoot });
  let executions = 0;
  daemonContext.toolRegistry.registerTool(
    defineZodTool({
      name: 'journal_restart_probe',
      description: 'Provider journal restart recovery probe.',
      argsSchema: z.strictObject({ value: z.string() }),
      sideEffectLevel: 'none',
      mayMutateComputerFiles: false,
      requiresApproval: false,
      recoveryStrategy: 'replay_safe',
      async executeParsed(args) {
        executions += 1;
        return { ok: true, output: args.value };
      },
    }),
  );
  const user = await appendTranscriptEntry(stateRoot, threadId, {
    role: 'user',
    content: 'recover journaled provider state',
    timestamp: '2026-07-18T00:00:00.000Z',
  });
  const rawFunctionCall = {
    id: 'item-journal-restart',
    type: 'function_call',
    call_id: 'call-journal-restart',
    name: 'journal_restart_probe',
    arguments: '{"value":"recovered"}',
    status: 'completed',
  };
  const replayScopeId = `sha256:${'b'.repeat(64)}` as ProviderReplayScopeId;
  await appendProviderRound({
    stateRoot,
    threadId,
    runId,
    round: 0,
    providerId: daemonContext.provider.requestOptions.providerId,
    model: daemonContext.provider.requestOptions.model,
    replayScopeId,
    precedingTranscriptEntryId: user.entryId,
    items: [rawFunctionCall],
    functionCalls: [
      {
        id: rawFunctionCall.id,
        callId: rawFunctionCall.call_id,
        name: rawFunctionCall.name,
        arguments: rawFunctionCall.arguments,
        replaySafe: true,
      },
    ],
  });

  const recovered = await recoverPendingReplaySafeToolCalls({
    agentInput: {
      runId,
      runContext: createRunContext({
        threadId,
        stateRoot,
        workingDirectory: stateRoot,
      }),
      prompt: 'unused during recovery',
      runtimeServices: daemonContext,
      approvalContext: {
        computerSessionId: 'replacement-session',
        permissionMode: 'basic',
      },
      onEvent() {},
    },
  });

  assert.equal(recovered.recoveredCallCount, 1);
  assert.equal(executions, 1);
  const entries = await readTranscriptEntries(stateRoot, threadId);
  assert.equal(entries.filter((entry) => entry.role === 'tool_call').length, 1);
  assert.equal(
    entries.filter((entry) => entry.role === 'tool_result').length,
    1,
  );

  let continuationRequests = 0;
  const result = await runAgentLoop({
    runId,
    runContext: createRunContext({
      threadId,
      stateRoot,
      workingDirectory: stateRoot,
    }),
    prompt: recovered.modelPrompt,
    runtimeServices: daemonContext,
    approvalContext: {
      computerSessionId: 'replacement-session',
      permissionMode: 'basic',
    },
    historyPort: {
      async loadInitialHistory(args) {
        return await loadExistingHistory(
          args.workspaceRoot,
          args.threadId,
          args.providerTarget,
        );
      },
    },
    callModelImpl: createScriptedProviderCallModel([
      {
        ...providerFinalAnswerRound('continued after recovery'),
        inspectInput(input) {
          continuationRequests += 1;
          assert.deepEqual(
            input.history.filter((item) => item.kind === 'user'),
            [
              {
                kind: 'user',
                text: 'recover journaled provider state',
              },
            ],
          );
          assert.deepEqual(
            input.history.filter((item) => item.kind === 'backend_item'),
            [
              {
                kind: 'backend_item',
                data: rawFunctionCall,
                providerReplayScopeId: replayScopeId,
              },
            ],
          );
          const outputs = input.history.filter(
            (item) => item.kind === 'function_call_output',
          );
          assert.equal(outputs.length, 1);
          assert.equal(outputs[0]?.callId, rawFunctionCall.call_id);
          assert.match(outputs[0]?.output ?? '', /recovered/u);
        },
      },
    ]),
    onEvent() {},
  });

  assert.deepEqual(result, {
    ok: true,
    finalProse: 'continued after recovery',
  });
  assert.equal(continuationRequests, 1);
  assert.equal(executions, 1);
});

void test('restart recovery re-emits a durable pending approval before executing the replay-safe tool', async (t) => {
  const stateRoot = await mkdtemp(join(tmpdir(), 'geulbat-tool-recovery-'));
  t.after(async () => rm(stateRoot, { recursive: true, force: true }));
  const threadId = assertThreadId(randomUUID());
  const runId = assertRunId(randomUUID());
  const toolName = 'restart_approval_probe';
  const callId = 'call-restart-approval';
  const approvalClass = toApprovalClass(toolName);
  const beforeRestart = createDaemonContext({ homeStateRoot: stateRoot });
  assert.equal(
    (
      await beforeRestart.runCheckpoints.startRun({
        runId,
        threadId,
        request: { workingDirectory: stateRoot, permissionMode: 'basic' },
      })
    ).ok,
    true,
  );
  assert.equal(
    (
      await beforeRestart.runCheckpoints.recordApprovalPending({
        threadId,
        runId,
        callId,
        approvalClass,
      })
    ).ok,
    true,
  );
  await appendTranscriptEntry(stateRoot, threadId, {
    role: 'user',
    content: 'approve and recover',
    timestamp: '2026-07-18T00:00:00.000Z',
  });
  await appendTranscriptEntry(stateRoot, threadId, {
    role: 'tool_call',
    content: JSON.stringify({
      id: 'item-restart-approval',
      callId,
      tool: toolName,
      args: { value: 'approved after restart' },
      round: 1,
      recoveryStrategy: 'replay_safe',
    }),
    timestamp: '2026-07-18T00:00:01.000Z',
  });

  let executions = 0;
  const afterRestart = createDaemonContext({ homeStateRoot: stateRoot });
  afterRestart.toolRegistry.registerTool(
    defineZodTool({
      name: toolName,
      description: 'Approval-gated restart recovery probe.',
      argsSchema: z.strictObject({ value: z.string() }),
      sideEffectLevel: 'write',
      mayMutateComputerFiles: false,
      requiresApproval: true,
      recoveryStrategy: 'replay_safe',
      async executeParsed(args) {
        assert.deepEqual(
          (await afterRestart.runCheckpoints.readThread(threadId))?.approvals,
          [
            {
              status: 'decided',
              callId,
              approvalClass,
              decision: 'approved',
              grantScope: 'once',
            },
          ],
        );
        executions += 1;
        return { ok: true, output: args.value };
      },
    }),
  );
  const events: string[] = [];
  let observeApprovalRequired: () => void = () => undefined;
  const approvalRequired = new Promise<void>((resolve) => {
    observeApprovalRequired = resolve;
  });
  const recovery = recoverPendingReplaySafeToolCalls({
    agentInput: {
      runId,
      runContext: createRunContext({
        threadId,
        stateRoot,
        workingDirectory: stateRoot,
      }),
      prompt: 'unused during recovery',
      runtimeServices: afterRestart,
      approvalContext: {
        computerSessionId: 'replacement-session',
        permissionMode: 'basic',
      },
      onEvent(event) {
        events.push(event.type);
        if (event.type === 'approval_required') {
          observeApprovalRequired();
        }
      },
    },
  });

  await approvalRequired;
  assert.deepEqual(
    (await afterRestart.runCheckpoints.readThread(threadId))?.approvals,
    [{ status: 'pending', callId, approvalClass }],
  );
  assert.equal(
    await afterRestart.approvalGate.resolveApproval(
      callId,
      runId,
      threadId,
      'approved',
      'once',
    ),
    'resolved',
  );
  assert.equal((await recovery).recoveredCallCount, 1);
  assert.equal(executions, 1);
  assert.deepEqual(events, ['tool_call', 'approval_required', 'tool_result']);
  assert.deepEqual(
    (await afterRestart.runCheckpoints.readThread(threadId))?.approvals,
    [
      {
        status: 'decided',
        callId,
        approvalClass,
        decision: 'approved',
        grantScope: 'once',
      },
    ],
  );
});

void test('restart recovery honors a durable approval decision without re-prompting before the tool effect', async (t) => {
  const stateRoot = await mkdtemp(join(tmpdir(), 'geulbat-tool-recovery-'));
  t.after(async () => rm(stateRoot, { recursive: true, force: true }));
  const threadId = assertThreadId(randomUUID());
  const runId = assertRunId(randomUUID());
  const toolName = 'restart_decided_approval_probe';
  const callId = 'call-restart-decided-approval';
  const approvalClass = toApprovalClass(toolName);
  const beforeRestart = createDaemonContext({ homeStateRoot: stateRoot });
  await beforeRestart.runCheckpoints.startRun({
    runId,
    threadId,
    request: { workingDirectory: stateRoot, permissionMode: 'basic' },
  });
  await beforeRestart.runCheckpoints.recordApprovalPending({
    threadId,
    runId,
    callId,
    approvalClass,
  });
  await beforeRestart.runCheckpoints.recordApprovalDecision({
    threadId,
    runId,
    callId,
    decision: 'approved',
    grantScope: 'once',
  });
  await appendTranscriptEntry(stateRoot, threadId, {
    role: 'user',
    content: 'continue the approved call',
    timestamp: '2026-07-18T00:00:00.000Z',
  });
  await appendTranscriptEntry(stateRoot, threadId, {
    role: 'tool_call',
    content: JSON.stringify({
      id: 'item-restart-decided-approval',
      callId,
      tool: toolName,
      args: {},
      round: 1,
      recoveryStrategy: 'replay_safe',
    }),
    timestamp: '2026-07-18T00:00:01.000Z',
  });

  let executions = 0;
  const afterRestart = createDaemonContext({ homeStateRoot: stateRoot });
  afterRestart.toolRegistry.registerTool(
    defineZodTool({
      name: toolName,
      description: 'Already-approved restart recovery probe.',
      argsSchema: z.strictObject({}),
      sideEffectLevel: 'write',
      mayMutateComputerFiles: false,
      requiresApproval: true,
      recoveryStrategy: 'replay_safe',
      async executeParsed() {
        executions += 1;
        return { ok: true, output: 'continued' };
      },
    }),
  );
  const events: string[] = [];
  const recovered = await recoverPendingReplaySafeToolCalls({
    agentInput: {
      runId,
      runContext: createRunContext({
        threadId,
        stateRoot,
        workingDirectory: stateRoot,
      }),
      prompt: 'unused during recovery',
      runtimeServices: afterRestart,
      approvalContext: {
        computerSessionId: 'replacement-session',
        permissionMode: 'basic',
      },
      onEvent(event) {
        events.push(event.type);
      },
    },
  });

  assert.equal(recovered.recoveredCallCount, 1);
  assert.equal(executions, 1);
  assert.deepEqual(events, ['tool_call', 'tool_result']);
  const entries = await readTranscriptEntries(stateRoot, threadId);
  assert.equal(entries.filter((entry) => entry.role === 'tool_call').length, 1);
  assert.equal(
    entries.filter((entry) => entry.role === 'tool_result').length,
    1,
  );
});

void test('restart recovery never blindly replays a tool without a matching strategy', async (t) => {
  const stateRoot = await mkdtemp(join(tmpdir(), 'geulbat-tool-recovery-'));
  t.after(async () => rm(stateRoot, { recursive: true, force: true }));
  const threadId = assertThreadId(randomUUID());
  const runId = assertRunId(randomUUID());
  let executions = 0;
  const daemonContext = createDaemonContext({ homeStateRoot: stateRoot });
  daemonContext.toolRegistry.registerTool(
    defineZodTool({
      name: 'opaque_restart_probe',
      description: 'Opaque restart recovery probe.',
      argsSchema: z.strictObject({}),
      sideEffectLevel: 'write',
      mayMutateComputerFiles: false,
      requiresApproval: false,
      async executeParsed() {
        executions += 1;
        return { ok: true, output: 'must not execute' };
      },
    }),
  );
  await appendTranscriptEntry(stateRoot, threadId, {
    role: 'user',
    content: 'prompt',
    timestamp: '2026-07-18T00:00:00.000Z',
  });
  await appendTranscriptEntry(stateRoot, threadId, {
    role: 'tool_call',
    content: JSON.stringify({
      id: 'item-opaque',
      callId: 'call-opaque',
      tool: 'opaque_restart_probe',
      args: {},
      round: 1,
    }),
    timestamp: '2026-07-18T00:00:01.000Z',
  });

  await recoverPendingReplaySafeToolCalls({
    agentInput: {
      runId,
      runContext: createRunContext({
        threadId,
        stateRoot,
        workingDirectory: stateRoot,
      }),
      prompt: 'unused during recovery',
      runtimeServices: daemonContext,
      approvalContext: {
        computerSessionId: 'replacement-session',
        permissionMode: 'basic',
      },
      onEvent() {},
    },
  });

  assert.equal(executions, 0);
  const result = (await readTranscriptEntries(stateRoot, threadId)).at(-1);
  assert.equal(result?.role, 'tool_result');
  assert.match(
    result?.content ?? '',
    /durable recovery strategy is unavailable/,
  );
});

void test('restart recovery reaps prior PTC runtime residue before settling an interrupted exec', async (t) => {
  const stateRoot = await mkdtemp(join(tmpdir(), 'geulbat-tool-recovery-'));
  t.after(async () => rm(stateRoot, { recursive: true, force: true }));
  const threadId = assertThreadId(randomUUID());
  const runId = assertRunId(randomUUID());
  const daemonContext = createDaemonContext({ homeStateRoot: stateRoot });
  const reapedStateRoots: string[] = [];
  daemonContext.ptc.executeCode.reapRestartResidue = async (args) => {
    reapedStateRoots.push(args.stateRoot);
    return { ok: true };
  };
  await appendTranscriptEntry(stateRoot, threadId, {
    role: 'user',
    content: 'run code',
    timestamp: '2026-07-18T00:00:00.000Z',
  });
  await appendTranscriptEntry(stateRoot, threadId, {
    role: 'tool_call',
    content: JSON.stringify({
      id: 'item-exec',
      callId: 'call-exec',
      tool: 'exec',
      args: { code: 'await neverSettles()' },
      round: 1,
    }),
    timestamp: '2026-07-18T00:00:01.000Z',
  });

  await recoverPendingReplaySafeToolCalls({
    agentInput: {
      runId,
      runContext: createRunContext({
        threadId,
        stateRoot,
        workingDirectory: stateRoot,
      }),
      prompt: 'unused during recovery',
      runtimeServices: daemonContext,
      approvalContext: {
        computerSessionId: 'replacement-session',
        permissionMode: 'basic',
      },
      onEvent() {},
    },
  });

  assert.deepEqual(reapedStateRoots, [stateRoot]);
  const result = (await readTranscriptEntries(stateRoot, threadId)).at(-1);
  assert.equal(result?.role, 'tool_result');
  assert.match(
    result?.content ?? '',
    /durable recovery strategy is unavailable/,
  );
});

void test('restart recovery reconciles exec through the same durable PTC invocation identity', async (t) => {
  const stateRoot = await mkdtemp(join(tmpdir(), 'geulbat-tool-recovery-'));
  t.after(async () => rm(stateRoot, { recursive: true, force: true }));
  const threadId = assertThreadId(randomUUID());
  const runId = assertRunId(randomUUID());
  const daemonContext = createDaemonContext({ homeStateRoot: stateRoot });
  const reapedStateRoots: string[] = [];
  const execInvocations: Array<
    | {
        runId: string;
        callId: string;
      }
    | undefined
  > = [];
  daemonContext.ptc.executeCode.reapRestartResidue = async (args) => {
    reapedStateRoots.push(args.stateRoot);
    return { ok: true };
  };
  daemonContext.ptc.executeCode.executeCode = async (args) => {
    execInvocations.push(args.invocation);
    return {
      ok: true,
      value: {
        ok: true,
        capabilityId: PTC_EXECUTE_CODE_TOOL_NAME,
        policyId: 'ptc_lab_execute_code_batch_node_v1',
        labPolicyId: 'ptc_lab_local_docker_batch_command_v1',
        profile: 'lab',
        executionClass: 'lab_execute_code',
        executionSurface: 'node_via_lab_detached_cell',
        status: 'running',
        cellId: 'ptc_cell_restart_exec',
        stdout: 'same durable exec\n',
        stderr: '',
        effectiveTimeoutMs: 60_000,
        durationMs: 25,
        toolCallbacks: { enabled: true, observed: 0 },
        sessionLifecycle: {
          mode: 'runtime_owned_reusable',
          retainedAfterExecution: true,
        },
        callbackHelp: {
          protocolVersion: 'ptc_execute_code_sdk_v1',
          helpAvailable: true,
          callbackToolCount: 0,
        },
      },
    };
  };
  await appendTranscriptEntry(stateRoot, threadId, {
    role: 'user',
    content: 'run durable code',
    timestamp: '2026-07-27T00:00:00.000Z',
  });
  await appendTranscriptEntry(stateRoot, threadId, {
    role: 'tool_call',
    content: JSON.stringify({
      id: 'item-exec-durable-cell',
      callId: 'call-exec-durable-cell',
      tool: 'exec',
      args: { code: 'await new Promise(() => {})' },
      round: 1,
      recoveryStrategy: 'durable_handle',
    }),
    timestamp: '2026-07-27T00:00:01.000Z',
  });

  const recovered = await recoverPendingReplaySafeToolCalls({
    agentInput: {
      runId,
      runContext: createRunContext({
        threadId,
        stateRoot,
        workingDirectory: stateRoot,
      }),
      prompt: 'unused during recovery',
      runtimeServices: daemonContext,
      approvalContext: {
        computerSessionId: 'replacement-session',
        permissionMode: 'basic',
      },
      onEvent() {},
    },
  });

  assert.equal(recovered.recoveredCallCount, 1);
  assert.deepEqual(reapedStateRoots, [stateRoot]);
  assert.deepEqual(execInvocations, [
    {
      runId,
      callId: 'call-exec-durable-cell',
    },
  ]);
  const result = JSON.parse(
    (await readTranscriptEntries(stateRoot, threadId)).at(-1)?.content ?? '{}',
  ) as { ok?: unknown; output?: unknown };
  assert.equal(result.ok, true);
  assert.equal(typeof result.output, 'string');
  if (typeof result.output === 'string') {
    const output = JSON.parse(result.output) as Record<string, unknown>;
    assert.equal(output['kind'], 'ptc_execute_code_cell_running');
    assert.equal(output['status'], 'running');
    assert.equal(output['cellId'], 'ptc_cell_restart_exec');
    assert.equal(output['stdout'], 'same durable exec\n');
  }
});

void test('restart recovery reattaches wait to the same durable PTC cell handle', async (t) => {
  const stateRoot = await mkdtemp(join(tmpdir(), 'geulbat-tool-recovery-'));
  t.after(async () => rm(stateRoot, { recursive: true, force: true }));
  const threadId = assertThreadId(randomUUID());
  const runId = assertRunId(randomUUID());
  const cellId = 'ptc_cell_restart_wait';
  const daemonContext = createDaemonContext({ homeStateRoot: stateRoot });
  const reapedStateRoots: string[] = [];
  const waitedCellIds: string[] = [];
  const waitInvocations: Array<
    | {
        runId: string;
        callId: string;
      }
    | undefined
  > = [];
  let newCellStarts = 0;
  daemonContext.ptc.executeCode.executeCode = async () => {
    newCellStarts += 1;
    throw new Error('restart wait recovery must not start a new PTC cell');
  };
  daemonContext.ptc.executeCode.reapRestartResidue = async (args) => {
    reapedStateRoots.push(args.stateRoot);
    return { ok: true };
  };
  daemonContext.ptc.executeCode.waitForCell = async (args) => {
    waitedCellIds.push(args.request.cellId);
    waitInvocations.push(args.invocation);
    return {
      ok: true,
      value: {
        ok: true,
        capabilityId: PTC_EXECUTE_CODE_TOOL_NAME,
        policyId: 'ptc_lab_execute_code_batch_node_v1',
        executionSurface: 'node_via_lab_detached_cell',
        status: 'completed',
        cellId,
        exitCode: 0,
        stdout: 'same durable cell completed\n',
        stderr: '',
      },
    };
  };
  await appendTranscriptEntry(stateRoot, threadId, {
    role: 'user',
    content: 'wait for the surviving PTC cell',
    timestamp: '2026-07-27T00:00:00.000Z',
  });
  await appendTranscriptEntry(stateRoot, threadId, {
    role: 'tool_call',
    content: JSON.stringify({
      id: 'item-wait-durable-cell',
      callId: 'call-wait-durable-cell',
      tool: 'wait',
      args: { cell_id: cellId, 'yield-time_ms': 1_000 },
      round: 1,
      recoveryStrategy: 'durable_handle',
    }),
    timestamp: '2026-07-27T00:00:01.000Z',
  });

  const recovered = await recoverPendingReplaySafeToolCalls({
    agentInput: {
      runId,
      runContext: createRunContext({
        threadId,
        stateRoot,
        workingDirectory: stateRoot,
      }),
      prompt: 'unused during recovery',
      runtimeServices: daemonContext,
      approvalContext: {
        computerSessionId: 'replacement-session',
        permissionMode: 'basic',
      },
      onEvent() {},
    },
  });

  assert.equal(recovered.recoveredCallCount, 1);
  assert.deepEqual(reapedStateRoots, [stateRoot]);
  assert.deepEqual(waitedCellIds, [cellId]);
  assert.deepEqual(waitInvocations, [
    {
      runId,
      callId: 'call-wait-durable-cell',
    },
  ]);
  assert.equal(newCellStarts, 0);
  const result = JSON.parse(
    (await readTranscriptEntries(stateRoot, threadId)).at(-1)?.content ?? '{}',
  ) as { ok?: unknown; output?: unknown };
  assert.equal(result.ok, true);
  assert.equal(typeof result.output, 'string');
  if (typeof result.output === 'string') {
    assert.deepEqual(JSON.parse(result.output), {
      kind: 'ptc_execute_code_cell_wait',
      capabilityId: PTC_EXECUTE_CODE_TOOL_NAME,
      policyId: 'ptc_lab_execute_code_batch_node_v1',
      executionSurface: 'node_via_lab_detached_cell',
      status: 'completed',
      cellId,
      exitCode: 0,
      stdout: 'same durable cell completed\n',
      stderr: '',
    });
  }
});
