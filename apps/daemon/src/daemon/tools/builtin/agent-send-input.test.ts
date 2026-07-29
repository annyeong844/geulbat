import assert from 'node:assert/strict';
import test from 'node:test';

import { assertRunId as assertValidRunId } from '@geulbat/protocol/ids';

import {
  composeAgentLoopUserPrompt,
  createAgentLoopPromptPort,
} from '../../agent/loop-prompt.js';
import { createSubagentRunLauncher } from '../../agent/subagent-support.js';
import { readTranscriptEntries } from '../../sessions/transcript-log.js';
import { createAgentSendInputTestFixture } from '../../../test-support/agent-send-input-test-support.js';
import { testRunId } from '../../../test-support/run-id.js';
import { testThreadId } from '../../../test-support/thread-id.js';
import { createAgentSpawnTool } from './agent-spawn.js';
import {
  agentSendInputTool,
  createAgentSendInputTool,
} from './agent-send-input.js';
import { agentWaitTool } from './agent-wait.js';

void test('agent_send_input rejects malformed handles and blank tasks at the parser boundary', async () => {
  const malformedHandle = await agentSendInputTool.execute(
    {
      child_run_id: 'run with spaces',
      task: 'follow-up',
    },
    {
      callId: 'call-send-input-malformed-handle',
      stateRoot: '/tmp/home-state',
    },
  );

  assert.equal(malformedHandle.ok, false);
  assert.equal(malformedHandle.errorCode, 'invalid_args');
  assert.match(malformedHandle.error ?? '', /child_run_id.*valid child run id/);

  const blankTask = await agentSendInputTool.execute(
    {
      child_run_id: testRunId('send-input-parser-boundary-child'),
      task: '   ',
    },
    {
      callId: 'call-send-input-blank-task',
      stateRoot: '/tmp/home-state',
    },
  );

  assert.equal(blankTask.ok, false);
  assert.equal(blankTask.errorCode, 'invalid_args');
  assert.match(blankTask.error ?? '', /task.*required/);
});

void test('agent_send_input continues one spawned child thread and updates agent_wait', async (t) => {
  const fixture = await createAgentSendInputTestFixture(t, {
    ownerThreadId: testThreadId(31),
    workspacePrefix: 'geulbat-agent-send-input-',
  });
  const outputs = ['first child answer', 'second child answer'];
  const startBackgroundRun = createSubagentRunLauncher({
    runAgentLoop: async () => {
      const next = outputs.shift();
      assert.ok(next);
      return { ok: true, finalProse: next };
    },
  }).startBackgroundRun;
  const spawnTool = createAgentSpawnTool({ startBackgroundRun });
  const sendInputTool = createAgentSendInputTool({ startBackgroundRun });
  const firstParentRunId = testRunId('send-input-parent-1');
  const secondParentRunId = testRunId('send-input-parent-2');

  const spawned = await spawnTool.execute(
    { task: 'first task', subagent_type: 'explorer' },
    fixture.makeStandaloneContext({
      callId: 'call-spawn',
      runId: firstParentRunId,
      computerSessionId: 'send-input-seed-session',
    }),
  );

  assert.equal(spawned.ok, true);
  const spawnPayload = JSON.parse(spawned.output) as {
    ok: boolean;
    childRunId: string;
    childThreadId: string;
  };
  const childRunId = assertValidRunId(spawnPayload.childRunId);
  assert.equal(spawnPayload.ok, true);
  await fixture.waitForChildStatus(childRunId, 'completed');

  const continued = await sendInputTool.execute(
    { child_run_id: childRunId, task: 'second task' },
    fixture.makeStandaloneContext({
      callId: 'call-continue',
      runId: secondParentRunId,
      computerSessionId: 'send-input-continue-session',
    }),
  );

  assert.equal(continued.ok, true);
  assert.deepEqual(JSON.parse(continued.output), {
    ok: true,
    childRunId: spawnPayload.childRunId,
    childThreadId: spawnPayload.childThreadId,
    subagentType: 'explorer',
    launchState: 'started',
    modelId: 'gpt-5.6-sol',
    reasoningEffort: 'medium',
    selectionSource: 'inherited',
  });
  await fixture.waitForChildStatus(childRunId, 'completed');

  const transcript = await readTranscriptEntries(
    fixture.stateRoot,
    spawnPayload.childThreadId,
  );
  assert.deepEqual(
    transcript.map((entry) => ({
      role: entry.role,
      content: entry.content,
    })),
    [
      { role: 'user', content: 'first task' },
      { role: 'assistant', content: 'first child answer' },
      { role: 'user', content: 'second task' },
      { role: 'assistant', content: 'second child answer' },
    ],
  );
  assert.equal(transcript[1]?.metadata?.sourceRunId, childRunId);
  assert.equal(transcript[3]?.metadata?.sourceRunId, childRunId);

  const waited = await agentWaitTool.execute(
    { child_run_ids: [childRunId] },
    fixture.makeStandaloneContext({
      callId: 'call-wait-after-continuation',
      runId: secondParentRunId,
    }),
  );
  assert.equal(waited.ok, true);
  const waitPayload = JSON.parse(waited.output) as {
    completed: Array<{ childRunId: string; result: string }>;
  };
  assert.equal(waitPayload.completed[0]?.childRunId, childRunId);
  assert.equal(waitPayload.completed[0]?.result, 'second child answer');
});

void test('agent_send_input continues a nested child owned by a child thread', async (t) => {
  const ownerThreadId = testThreadId(35);
  const childThreadId = testThreadId(36);
  const childRunId = testRunId('send-input-nested-child');
  const continuedParentRunId = testRunId('send-input-nested-parent-2');
  const fixture = await createAgentSendInputTestFixture(t, {
    ownerThreadId,
    workspacePrefix: 'geulbat-agent-send-input-nested-',
  });
  const seeded = fixture.registerChild({
    childRunId,
    childThreadId,
    parentRunId: testRunId('send-input-nested-parent-1'),
    subagentType: 'explorer',
  });
  assert.equal(seeded?.status, 'completed');

  const sendInputTool = createAgentSendInputTool({
    startBackgroundRun: createSubagentRunLauncher({
      runAgentLoop: async (input) => {
        const { promptContext } = createAgentLoopPromptPort().buildPromptBundle(
          {
            threadId: childThreadId,
          },
        );
        assert.equal(
          input.prompt,
          composeAgentLoopUserPrompt({
            prompt: 'nested follow-up',
            promptContext,
          }),
        );
        assert.equal(input.runContext.threadId, childThreadId);
        return { ok: true, finalProse: 'nested follow-up answer' };
      },
    }).startBackgroundRun,
  });
  const continued = await sendInputTool.execute(
    { child_run_id: childRunId, task: 'nested follow-up' },
    fixture.makeStandaloneContext({
      callId: 'call-nested-continue',
      runId: continuedParentRunId,
      parentRunId: testRunId('send-input-top-parent'),
    }),
  );

  assert.equal(continued.ok, true);
  assert.deepEqual(JSON.parse(continued.output), {
    ok: true,
    childRunId,
    childThreadId,
    subagentType: 'explorer',
    launchState: 'started',
    modelId: 'gpt-5.6-sol',
    reasoningEffort: 'medium',
    selectionSource: 'inherited',
  });
  await fixture.waitForChildStatus(childRunId, 'completed');
  assert.equal(
    fixture.daemonContext.childRuns.getChildRun(childRunId)?.result,
    'nested follow-up answer',
  );
});

void test('agent_send_input rejects a child handle that is still running', async (t) => {
  const childRunId = testRunId('send-input-busy-child');
  const fixture = await createAgentSendInputTestFixture(t, {
    ownerThreadId: testThreadId(32),
    workspacePrefix: 'geulbat-agent-send-input-busy-',
  });
  const seeded = fixture.registerChild({
    childRunId,
    childThreadId: testThreadId(33),
    parentRunId: testRunId('send-input-busy-parent'),
    subagentType: 'explorer',
    terminalState: null,
  });
  assert.equal(seeded?.status, 'running');

  const rejected = await agentSendInputTool.execute(
    { child_run_id: childRunId, task: 'follow-up' },
    fixture.makeStandaloneContext({
      callId: 'call-continue-busy',
      runId: testRunId('send-input-busy-parent-2'),
    }),
  );

  assert.equal(rejected.ok, true);
  const payload = JSON.parse(rejected.output) as {
    ok: boolean;
    launchState: string;
    errorCode: string;
  };
  assert.equal(payload.ok, false);
  assert.equal(payload.launchState, 'rejected');
  assert.equal(payload.errorCode, 'invalid_args');
});

void test('agent_send_input continues retained terminal child metadata', async (t) => {
  const ownerThreadId = testThreadId(36);
  const childRunId = testRunId('send-input-terminal-child');
  const fixture = await createAgentSendInputTestFixture(t, {
    ownerThreadId,
    workspacePrefix: 'geulbat-agent-send-input-retained-terminal-',
  });
  fixture.registerChild({
    childRunId,
    childThreadId: testThreadId(37),
    parentRunId: testRunId('send-input-terminal-parent'),
    subagentType: 'explorer',
    capabilities: ['ptc'],
    modelPin: {
      modelId: 'gpt-5.6-luna',
      providerRunSelection: {
        providerModel: {
          providerId: 'openai_codex_direct',
          model: 'gpt-5.6-luna',
        },
        reasoningEffort: 'xhigh',
      },
      selectionSource: 'user_fixed',
    },
    subagentModelRouting: {
      mode: 'fixed',
      choice: { modelId: 'gpt-5.6-luna', reasoningEffort: 'xhigh' },
    },
  });

  let continuedTask: string | undefined;
  const sendInputTool = createAgentSendInputTool({
    startBackgroundRun: async (input) => {
      continuedTask = input.task;
      assert.equal(input.ultraReasoning, true);
      assert.deepEqual(input.capabilities, ['ptc']);
      assert.deepEqual(input.modelPin, {
        modelId: 'gpt-5.6-luna',
        providerRunSelection: {
          providerModel: {
            providerId: 'openai_codex_direct',
            model: 'gpt-5.6-luna',
          },
          reasoningEffort: 'xhigh',
        },
        selectionSource: 'user_fixed',
      });
      assert.deepEqual(input.subagentModelRouting, {
        mode: 'fixed',
        choice: { modelId: 'gpt-5.6-luna', reasoningEffort: 'xhigh' },
      });
      return { ok: true, output: 'continued' };
    },
  });
  const parentRunId = testRunId('send-input-terminal-top');
  await fixture.startParentCheckpoint({
    runId: parentRunId,
    permissionMode: 'full_access',
  });

  const result = await sendInputTool.execute(
    { child_run_id: childRunId, task: 'continue retained child' },
    fixture.makeAgentContext({
      callId: 'call-send-input-terminal',
      runId: parentRunId,
      permissionMode: 'full_access',
      computerSessionId: 'send-input-terminal-session',
      ultraReasoning: true,
      approvalGranted: true,
    }),
  );

  assert.equal(result.ok, true);
  assert.equal(continuedTask, 'continue retained child');
});
