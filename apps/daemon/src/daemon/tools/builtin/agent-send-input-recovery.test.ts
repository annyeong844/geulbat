import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createAgentLoopPromptPort,
  composeAgentLoopUserPrompt,
} from '../../agent/loop-prompt.js';
import { createSubagentRunLauncher } from '../../agent/subagent-support.js';
import { createDaemonContext } from '../../context.js';
import {
  appendTranscriptEntry,
  readTranscriptEntries,
} from '../../sessions/transcript-log.js';
import { createAgentSendInputTestFixture } from '../../../test-support/agent-send-input-test-support.js';
import { testRunId } from '../../../test-support/run-id.js';
import { TEST_INHERITED_SOL_MODEL_PIN } from '../../../test-support/subagent-model-routing.js';
import { testThreadId } from '../../../test-support/thread-id.js';
import { createAgentSendInputTool } from './agent-send-input.js';

void test('agent_send_input replays one prepared child delivery after daemon replacement without duplicating transcript input', async (t) => {
  const ownerThreadId = testThreadId(38);
  const childThreadId = testThreadId(39);
  const parentRunId = testRunId('send-input-restart-parent');
  const childRunId = testRunId('send-input-restart-child');
  const callId = 'call-send-input-restart';
  const task = 'deliver this follow-up exactly once';
  const deliveryEntryId =
    'agent-send-input:call-send-input-restart:child-input';
  const deliveryTimestamp = '2026-07-29T00:00:00.000Z';
  const fixture = await createAgentSendInputTestFixture(t, {
    ownerThreadId,
    workspacePrefix: 'geulbat-agent-send-input-restart-',
  });
  fixture.registerChild({
    childRunId,
    childThreadId,
    parentRunId: testRunId('send-input-restart-original-parent'),
    subagentType: 'explorer',
  });
  await fixture.startParentCheckpoint({
    runId: parentRunId,
    permissionMode: 'full_access',
  });

  const recorded =
    await fixture.daemonContext.runCheckpoints.recordToolInvocation({
      threadId: ownerThreadId,
      runId: parentRunId,
      invocation: {
        callId,
        toolName: 'agent_send_input',
        recoveryStrategy: 'reconcile_then_replay',
        recoveryState: {
          schemaVersion: 1,
          childRunId,
          childThreadId,
          taskDigest: `sha256:${createHash('sha256').update(task).digest('hex')}`,
          childInput: {
            entryId: deliveryEntryId,
            timestamp: deliveryTimestamp,
          },
          priorChildCheckpoint: null,
        },
      },
    });
  assert.equal(recorded.ok, true);
  const { promptContext } = createAgentLoopPromptPort().buildPromptBundle({
    threadId: childThreadId,
  });
  const modelPrompt = composeAgentLoopUserPrompt({
    prompt: task,
    promptContext,
  });
  await appendTranscriptEntry(fixture.stateRoot, childThreadId, {
    entryId: deliveryEntryId,
    role: 'user',
    content: task,
    timestamp: deliveryTimestamp,
    ...(modelPrompt === task
      ? {}
      : { metadata: { hiddenPrompt: modelPrompt } }),
  });

  const replacementContext = createDaemonContext({
    homeStateRoot: fixture.stateRoot,
  });
  replacementContext.childRuns.registerChildRun({
    childRunId,
    childThreadId,
    parentRunId: testRunId('send-input-restart-original-parent'),
    ownerThreadId,
    subagentType: 'explorer',
    capabilities: [],
    modelPin: TEST_INHERITED_SOL_MODEL_PIN,
    subagentModelRouting: { mode: 'auto' },
  });
  replacementContext.childRuns.markChildTerminal({
    childRunId,
    terminalState: 'completed',
    result: 'original child result',
  });
  let replacementExecutions = 0;
  const replacementTool = createAgentSendInputTool({
    startBackgroundRun: createSubagentRunLauncher({
      runAgentLoop: async () => {
        replacementExecutions += 1;
        return {
          ok: true,
          finalProse: 'replacement child result',
        };
      },
    }).startBackgroundRun,
  });

  const replayed = await replacementTool.execute(
    { child_run_id: childRunId, task },
    fixture.makeAgentContext({
      callId,
      runId: parentRunId,
      permissionMode: 'full_access',
      computerSessionId: 'send-input-restart-session',
      approvalGranted: true,
      runtimeServices: replacementContext,
    }),
  );
  assert.equal(replayed.ok, true);
  await fixture.waitForChildStatus(childRunId, 'completed', replacementContext);

  const matchingInputs = (
    await readTranscriptEntries(fixture.stateRoot, childThreadId)
  ).filter((entry) => entry.role === 'user' && entry.content === task);
  assert.equal(replacementExecutions, 1);
  assert.equal(matchingInputs.length, 1);
  const parentCheckpoint =
    await replacementContext.runCheckpoints.readThread(ownerThreadId);
  assert.equal(parentCheckpoint?.toolInvocations.length, 1);
  assert.equal(parentCheckpoint?.toolInvocations[0]?.status, 'reconciled');
  assert.deepEqual(parentCheckpoint?.toolInvocations[0]?.result, replayed);

  const conflictingReplay = await replacementTool.execute(
    {
      child_run_id: childRunId,
      task: 'a different follow-up must not reuse the durable delivery',
    },
    fixture.makeAgentContext({
      callId,
      runId: parentRunId,
      permissionMode: 'full_access',
      computerSessionId: 'send-input-restart-session',
      approvalGranted: true,
      runtimeServices: replacementContext,
    }),
  );
  assert.equal(conflictingReplay.ok, false);
  assert.match(
    conflictingReplay.error ?? '',
    /agent_send_input recovery state conflicts/,
  );
  assert.equal(replacementExecutions, 1);
  assert.equal(
    (await readTranscriptEntries(fixture.stateRoot, childThreadId)).filter(
      (entry) =>
        entry.role === 'user' &&
        entry.content ===
          'a different follow-up must not reuse the durable delivery',
    ).length,
    0,
  );
});
