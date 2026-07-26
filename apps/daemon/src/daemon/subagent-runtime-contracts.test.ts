import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import type {
  AgentLaunchToolRaw,
  KnownToolResultSuccessEventPayload,
} from '@geulbat/protocol/run-events';
import { isToolResultEventPayload } from '@geulbat/protocol/run-events';

import type { HistoryItem } from './llm/index.js';
import { recordToolResult } from './agent/loop-tool-support.js';
import { buildChildLaunchPayload } from './subagent-runtime-contracts.js';
import { makeRunContext } from '../test-support/run-context.js';
import { testThreadId } from '../test-support/thread-id.js';

type LaunchTool = 'agent_spawn' | 'agent_send_input';
type LaunchEventFixture = KnownToolResultSuccessEventPayload<LaunchTool>;

const CHILD_THREAD_ID = testThreadId(3_801);

const SPAWN_STARTED_RAW = {
  ok: true,
  childRunId: 'fixture-child-spawn',
  childThreadId: CHILD_THREAD_ID,
  subagentType: 'explorer',
  launchState: 'started',
  modelId: 'gpt-5.6-sol',
  reasoningEffort: 'medium',
  selectionSource: 'inherited',
} satisfies AgentLaunchToolRaw;

const CONTINUATION_STARTED_RAW = {
  ...SPAWN_STARTED_RAW,
} satisfies AgentLaunchToolRaw;

const SPAWN_REJECTED_RAW = {
  ok: false,
  launchState: 'rejected',
  subagentType: 'worker',
  errorCode: 'too_many_child_runs',
  error: 'maximum 1 concurrent child agent allowed',
  effectiveMax: 1,
} satisfies AgentLaunchToolRaw;

const CONTINUATION_REJECTED_RAW = {
  ok: false,
  launchState: 'rejected',
  subagentType: 'explorer',
  errorCode: 'invalid_args',
  error: 'child run is not terminal; wait for completion or stop it first',
} satisfies AgentLaunchToolRaw;

const SAME_ROUND_STARTED_RAW = [
  {
    ...SPAWN_STARTED_RAW,
    childRunId: 'fixture-child-wave-a',
    childThreadId: testThreadId(3_802),
  },
  {
    ...SPAWN_STARTED_RAW,
    childRunId: 'fixture-child-wave-b',
    childThreadId: testThreadId(3_803),
    subagentType: 'worker',
  },
] satisfies readonly AgentLaunchToolRaw[];

const SAME_ROUND_REJECTED_RAW = [
  {
    ...SPAWN_REJECTED_RAW,
    subagentType: 'explorer',
  },
  SPAWN_REJECTED_RAW,
] satisfies readonly AgentLaunchToolRaw[];

const SUBAGENT_LAUNCH_EVENT_CONTRACT_FIXTURES = {
  agentSpawn: {
    success: {
      callId: 'call-fixture-spawn-success',
      step: 2,
      tool: 'agent_spawn',
      ok: true,
      computerFilesMayHaveChanged: false,
      displayText: JSON.stringify(SPAWN_STARTED_RAW),
      raw: SPAWN_STARTED_RAW,
    } satisfies KnownToolResultSuccessEventPayload<'agent_spawn'>,
    rejection: {
      callId: 'call-fixture-spawn-rejection',
      step: 2,
      tool: 'agent_spawn',
      ok: true,
      computerFilesMayHaveChanged: false,
      displayText: JSON.stringify(SPAWN_REJECTED_RAW),
      raw: SPAWN_REJECTED_RAW,
    } satisfies KnownToolResultSuccessEventPayload<'agent_spawn'>,
  },
  continuation: {
    success: {
      callId: 'call-fixture-continuation-success',
      step: 3,
      tool: 'agent_send_input',
      ok: true,
      computerFilesMayHaveChanged: false,
      displayText: JSON.stringify(CONTINUATION_STARTED_RAW),
      raw: CONTINUATION_STARTED_RAW,
    } satisfies KnownToolResultSuccessEventPayload<'agent_send_input'>,
    rejection: {
      callId: 'call-fixture-continuation-rejection',
      step: 3,
      tool: 'agent_send_input',
      ok: true,
      computerFilesMayHaveChanged: false,
      displayText: JSON.stringify(CONTINUATION_REJECTED_RAW),
      raw: CONTINUATION_REJECTED_RAW,
    } satisfies KnownToolResultSuccessEventPayload<'agent_send_input'>,
  },
  sameRound: {
    success: SAME_ROUND_STARTED_RAW.map(
      (raw, index) =>
        ({
          callId: `call-fixture-wave-success-${index + 1}`,
          step: 4,
          tool: 'agent_spawn',
          ok: true,
          computerFilesMayHaveChanged: false,
          displayText: JSON.stringify(raw),
          raw,
        }) satisfies KnownToolResultSuccessEventPayload<'agent_spawn'>,
    ),
    rejection: SAME_ROUND_REJECTED_RAW.map(
      (raw, index) =>
        ({
          callId: `call-fixture-wave-rejection-${index + 1}`,
          step: 4,
          tool: 'agent_spawn',
          ok: true,
          computerFilesMayHaveChanged: false,
          displayText: JSON.stringify(raw),
          raw,
        }) satisfies KnownToolResultSuccessEventPayload<'agent_spawn'>,
    ),
  },
} as const;

function flattenLaunchEventFixtures(): readonly LaunchEventFixture[] {
  return [
    SUBAGENT_LAUNCH_EVENT_CONTRACT_FIXTURES.agentSpawn.success,
    SUBAGENT_LAUNCH_EVENT_CONTRACT_FIXTURES.agentSpawn.rejection,
    SUBAGENT_LAUNCH_EVENT_CONTRACT_FIXTURES.continuation.success,
    SUBAGENT_LAUNCH_EVENT_CONTRACT_FIXTURES.continuation.rejection,
    ...SUBAGENT_LAUNCH_EVENT_CONTRACT_FIXTURES.sameRound.success,
    ...SUBAGENT_LAUNCH_EVENT_CONTRACT_FIXTURES.sameRound.rejection,
  ];
}

void test('launch-style tool_result fixtures keep launch decisions inside an outer success event', () => {
  for (const fixture of flattenLaunchEventFixtures()) {
    assert.equal(isToolResultEventPayload(fixture), true);
    assert.equal(fixture.ok, true);
    assert.equal(
      fixture.raw.launchState,
      fixture.raw.ok ? 'started' : 'rejected',
    );
  }
  assert.deepEqual(
    SUBAGENT_LAUNCH_EVENT_CONTRACT_FIXTURES.continuation.success.raw,
    SUBAGENT_LAUNCH_EVENT_CONTRACT_FIXTURES.agentSpawn.success.raw,
  );
});

void test('daemon launch payload recording reproduces the public event fixtures byte for byte', async () => {
  const stateRoot = await mkdtemp(join(tmpdir(), 'geulbat-launch-contract-'));
  const history: HistoryItem[] = [];
  const emitted: Array<{ type: string; payload: unknown }> = [];

  try {
    for (const fixture of flattenLaunchEventFixtures()) {
      const toolResult = buildChildLaunchPayload(fixture.raw);
      assert.deepEqual(toolResult, {
        ok: true,
        output: JSON.stringify(fixture.raw),
      });

      await recordToolResult({
        functionCall: {
          id: `fc-${fixture.callId}`,
          callId: fixture.callId,
          name: fixture.tool,
          arguments: '{}',
        },
        round: fixture.step,
        toolResult,
        computerFilesMayHaveChanged: false,
        runContext: makeRunContext({
          threadId: CHILD_THREAD_ID,
          stateRoot,
        }),
        runId: 'run-launch-contract-fixture',
        history,
        emit(type, payload) {
          emitted.push({ type, payload });
        },
      });
    }

    assert.deepEqual(
      emitted,
      flattenLaunchEventFixtures().map((payload) => ({
        type: 'tool_result',
        payload,
      })),
    );
  } finally {
    await rm(stateRoot, { recursive: true, force: true });
  }
});

void test('same-round fixtures preserve all-started or all-rejected batch decisions', () => {
  assert.deepEqual(
    SUBAGENT_LAUNCH_EVENT_CONTRACT_FIXTURES.sameRound.success.map(
      ({ raw }) => raw.launchState,
    ),
    ['started', 'started'],
  );
  assert.deepEqual(
    SUBAGENT_LAUNCH_EVENT_CONTRACT_FIXTURES.sameRound.rejection.map(
      ({ raw }) => ({
        launchState: raw.launchState,
        errorCode: raw.ok ? undefined : raw.errorCode,
        effectiveMax: raw.ok ? undefined : raw.effectiveMax,
      }),
    ),
    [
      {
        launchState: 'rejected',
        errorCode: 'too_many_child_runs',
        effectiveMax: 1,
      },
      {
        launchState: 'rejected',
        errorCode: 'too_many_child_runs',
        effectiveMax: 1,
      },
    ],
  );
});
