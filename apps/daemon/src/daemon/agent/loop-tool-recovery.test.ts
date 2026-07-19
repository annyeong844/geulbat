import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { assertRunId, assertThreadId } from '@geulbat/protocol/ids';
import type { ProviderReplayScopeId } from '@geulbat/protocol/provider-auth';
import { toApprovalClass } from '@geulbat/protocol/run-approval';
import { z } from 'zod';

import { createDaemonContext } from '../context.js';
import { createRunContext } from '../run-context.js';
import {
  appendTranscriptEntry,
  readTranscriptEntries,
} from '../sessions/transcript-log.js';
import { appendProviderRound } from '../sessions/provider-round-journal.js';
import { defineZodTool } from '../tools/zod-tool.js';
import {
  createScriptedProviderCallModel,
  providerFinalAnswerRound,
} from '../../test-support/provider-response-fixtures.js';
import { loadExistingHistory } from './loop-history.js';
import { recoverPendingReplaySafeToolCalls } from './loop-tool-recovery.js';
import { runAgentLoop } from './run-agent-loop.js';

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
        sessionId: 'replacement-session',
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
    providerId: daemonContext.providerRequestOptions.providerId,
    model: daemonContext.providerRequestOptions.model,
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
        sessionId: 'replacement-session',
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
      sessionId: 'replacement-session',
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
        sessionId: 'replacement-session',
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
        sessionId: 'replacement-session',
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
        sessionId: 'replacement-session',
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
  daemonContext.ptcExecuteCode.reapRestartResidue = async (args) => {
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
        sessionId: 'replacement-session',
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
