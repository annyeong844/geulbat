import assert from 'node:assert/strict';
import test from 'node:test';
import type { FunctionCall } from '../llm/index.js';
import {
  createFunctionCallRunStateFixture,
  makeTestTool,
  registerOnce,
} from '../../test-support/loop-tool-execution-test-support.js';
import { testThreadId } from '../../test-support/thread-id.js';
import { processFunctionCalls } from './loop-tool-execution.js';

function functionCall(
  name: string,
  toolArgs: Record<string, unknown> = {},
): FunctionCall {
  return {
    id: `fc-${name}`,
    callId: `call-${name}`,
    name,
    arguments: JSON.stringify(toolArgs),
  };
}

void test('processFunctionCalls passes one admitted snapshot to every PTC cell beside a subagent launch', async () => {
  const fixture = await createFunctionCallRunStateFixture({
    threadId: testThreadId(162),
    runId: 'run-ptc-shared-resource-window',
    workspacePrefix: 'geulbat-ptc-shared-resource-window-',
  });
  const executedTools: string[] = [];
  const observedSnapshotIds: string[] = [];
  let subagentExecutions = 0;

  registerOnce(
    fixture.daemonContext,
    makeTestTool({
      name: 'ptc_resource_subagent',
      description: 'subagent launch beside PTC cells',
      sideEffectLevel: 'none',
      parallelBatchKind: 'subagent_launch',
      requiresApproval: false,
      async executeParsed() {
        subagentExecutions += 1;
        executedTools.push('subagent');
        return {
          ok: true,
          output: JSON.stringify({
            ok: true,
            childRunId: 'child-ptc-shared-resource-window',
          }),
        };
      },
    }),
  );
  for (const name of ['ptc_resource_cell_one', 'ptc_resource_cell_two']) {
    registerOnce(
      fixture.daemonContext,
      makeTestTool({
        name,
        description: 'PTC cell receiving a shared resource snapshot',
        sideEffectLevel: 'none',
        parallelBatchKind: 'ptc_cell',
        requiresApproval: false,
        async executeParsed(_args, context) {
          observedSnapshotIds.push(
            context.resourceSnapshotRef?.snapshotId ?? '',
          );
          executedTools.push(name);
          return { ok: true, output: `${name} complete` };
        },
      }),
    );
  }

  const result = await processFunctionCalls({
    functionCalls: [
      functionCall('ptc_resource_cell_one'),
      functionCall('ptc_resource_subagent', {
        task: 'inspect the shared PTC resource window',
      }),
      functionCall('ptc_resource_cell_two'),
    ],
    round: 0,
    history: fixture.history,
    runtime: fixture.makeRuntime(),
  });
  const transcriptRoles = await fixture.readTranscriptRoles();

  assert.deepEqual(result, { ok: true, value: undefined });
  assert.equal(subagentExecutions, 1);
  assert.equal(observedSnapshotIds.length, 2);
  assert.notEqual(observedSnapshotIds[0], '');
  assert.notEqual(observedSnapshotIds[1], '');
  assert.equal(observedSnapshotIds[0], observedSnapshotIds[1]);
  assert.deepEqual(executedTools.sort(), [
    'ptc_resource_cell_one',
    'ptc_resource_cell_two',
    'subagent',
  ]);
  assert.equal(fixture.history.length, 3);
  assert.equal(transcriptRoles.length, 6);
  assert.deepEqual(transcriptRoles, [
    'tool_call',
    'tool_call',
    'tool_call',
    'tool_result',
    'tool_result',
    'tool_result',
  ]);
});
