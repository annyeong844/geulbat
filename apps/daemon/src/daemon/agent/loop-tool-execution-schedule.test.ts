import assert from 'node:assert/strict';
import test from 'node:test';
import { createDaemonContext } from '../context.js';
import type { FunctionCall } from '../llm/index.js';
import {
  PTC_EXECUTE_CODE_TOOL_NAME,
  PTC_EXECUTE_CODE_WAIT_TOOL_NAME,
} from '../ptc/runtime/execute-code/execute-code-runtime-contract.js';
import type { AnyTool } from '../tools/types.js';
import {
  makeTestTool,
  registerOnce,
} from '../../test-support/loop-tool-execution-test-support.js';
import {
  prepareFunctionCallSchedule,
  type FunctionCallScheduleItem,
} from './loop-tool-execution-schedule.js';

type SharedWindowScheduleItem = Extract<
  FunctionCallScheduleItem,
  { kind: 'shared_window' }
>;
type ExclusiveScheduleItem = Extract<
  FunctionCallScheduleItem,
  { kind: 'exclusive' }
>;

function registerScheduleTool(
  daemonContext: ReturnType<typeof createDaemonContext>,
  args: {
    name: string;
    sideEffectLevel: AnyTool['sideEffectLevel'];
    parallelBatchKind?: AnyTool['parallelBatchKind'];
  },
): void {
  registerOnce(
    daemonContext,
    makeTestTool({
      name: args.name,
      description: 'schedule-only test tool',
      sideEffectLevel: args.sideEffectLevel,
      ...(args.parallelBatchKind === undefined
        ? {}
        : { parallelBatchKind: args.parallelBatchKind }),
      requiresApproval: false,
      async executeParsed() {
        throw new Error('schedule tests must not execute tools');
      },
    }),
  );
}

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

function requireSharedWindow(
  schedule: readonly FunctionCallScheduleItem[],
  index: number,
): SharedWindowScheduleItem {
  const item = schedule[index];
  if (item?.kind !== 'shared_window') {
    throw new Error(`schedule item ${index} is not a shared window`);
  }
  return item;
}

function requireExclusive(
  schedule: readonly FunctionCallScheduleItem[],
  index: number,
): ExclusiveScheduleItem {
  const item = schedule[index];
  if (item?.kind !== 'exclusive') {
    throw new Error(`schedule item ${index} is not exclusive`);
  }
  return item;
}

void test('prepareFunctionCallSchedule keeps unmarked none-effect tools as barriers between read windows', () => {
  const daemonContext = createDaemonContext();
  for (const name of [
    'ptc_gate_first_read_one',
    'ptc_gate_first_read_two',
    'ptc_gate_second_read_one',
    'ptc_gate_second_read_two',
  ]) {
    registerScheduleTool(daemonContext, { name, sideEffectLevel: 'read' });
  }
  for (const name of ['ptc_gate_exec_tool', 'ptc_gate_wait_tool']) {
    registerScheduleTool(daemonContext, { name, sideEffectLevel: 'none' });
  }

  const schedule = prepareFunctionCallSchedule(
    [
      functionCall('ptc_gate_first_read_one'),
      functionCall('ptc_gate_first_read_two'),
      functionCall('ptc_gate_exec_tool'),
      functionCall('ptc_gate_wait_tool'),
      functionCall('ptc_gate_second_read_one'),
      functionCall('ptc_gate_second_read_two'),
    ],
    daemonContext.toolRegistry,
  );

  assert.equal(schedule.length, 4);
  assert.equal(schedule[0]?.kind, 'shared_window');
  assert.equal(schedule[1]?.kind, 'exclusive');
  assert.equal(schedule[2]?.kind, 'exclusive');
  assert.equal(schedule[3]?.kind, 'shared_window');
  assert.deepEqual(
    requireSharedWindow(schedule, 0).preparedFunctionCalls.map(
      ({ functionCall: call }) => call.name,
    ),
    ['ptc_gate_first_read_one', 'ptc_gate_first_read_two'],
  );
  assert.deepEqual(
    requireSharedWindow(schedule, 0).preparedFunctionCalls.map(
      ({ sharedKind }) => sharedKind,
    ),
    ['read_only', 'read_only'],
  );
  assert.equal(
    requireExclusive(schedule, 1).preparedFunctionCall.functionCall.name,
    'ptc_gate_exec_tool',
  );
  assert.equal(
    requireExclusive(schedule, 2).preparedFunctionCall.functionCall.name,
    'ptc_gate_wait_tool',
  );
  assert.deepEqual(
    requireSharedWindow(schedule, 3).preparedFunctionCalls.map(
      ({ functionCall: call }) => call.name,
    ),
    ['ptc_gate_second_read_one', 'ptc_gate_second_read_two'],
  );
});

void test('prepareFunctionCallSchedule shares public exec and non-terminating wait with reads', () => {
  const daemonContext = createDaemonContext();
  for (const name of [
    'public_ptc_read_before',
    'public_ptc_read_between',
    'public_ptc_read_after',
  ]) {
    registerScheduleTool(daemonContext, { name, sideEffectLevel: 'read' });
  }

  const schedule = prepareFunctionCallSchedule(
    [
      functionCall('public_ptc_read_before'),
      functionCall(PTC_EXECUTE_CODE_TOOL_NAME, { code: 'return 1' }),
      functionCall('public_ptc_read_between'),
      functionCall(PTC_EXECUTE_CODE_WAIT_TOOL_NAME, {
        cell_id: 'ptc_cell_public_gate',
      }),
      functionCall('public_ptc_read_after'),
    ],
    daemonContext.toolRegistry,
  );
  const sharedWindow = requireSharedWindow(schedule, 0);

  assert.equal(schedule.length, 1);
  assert.equal(schedule[0]?.kind, 'shared_window');
  assert.deepEqual(
    sharedWindow.preparedFunctionCalls.map(
      ({ functionCall: call }) => call.name,
    ),
    [
      'public_ptc_read_before',
      PTC_EXECUTE_CODE_TOOL_NAME,
      'public_ptc_read_between',
      PTC_EXECUTE_CODE_WAIT_TOOL_NAME,
      'public_ptc_read_after',
    ],
  );
  assert.deepEqual(
    sharedWindow.preparedFunctionCalls.map(({ sharedKind }) => sharedKind),
    ['read_only', 'ptc_cell', 'read_only', 'ptc_cell', 'read_only'],
  );
  assert.equal(
    sharedWindow.preparedFunctionCalls[3]?.toolArgs.terminate,
    undefined,
  );
});

void test('prepareFunctionCallSchedule keeps a terminating public wait exclusive', () => {
  const daemonContext = createDaemonContext();
  for (const name of [
    'public_ptc_terminate_read_before',
    'public_ptc_terminate_read_after',
  ]) {
    registerScheduleTool(daemonContext, { name, sideEffectLevel: 'read' });
  }

  const schedule = prepareFunctionCallSchedule(
    [
      functionCall('public_ptc_terminate_read_before'),
      functionCall(PTC_EXECUTE_CODE_WAIT_TOOL_NAME, {
        cell_id: 'ptc_cell_public_terminate_gate',
        terminate: true,
      }),
      functionCall('public_ptc_terminate_read_after'),
    ],
    daemonContext.toolRegistry,
  );

  assert.equal(schedule.length, 3);
  assert.equal(schedule[0]?.kind, 'shared_window');
  assert.equal(schedule[1]?.kind, 'exclusive');
  assert.equal(schedule[2]?.kind, 'shared_window');
  assert.deepEqual(
    requireSharedWindow(schedule, 0).preparedFunctionCalls.map(
      ({ functionCall: call }) => call.name,
    ),
    ['public_ptc_terminate_read_before'],
  );
  assert.equal(
    requireExclusive(schedule, 1).preparedFunctionCall.functionCall.name,
    PTC_EXECUTE_CODE_WAIT_TOOL_NAME,
  );
  assert.equal(
    requireExclusive(schedule, 1).preparedFunctionCall.toolArgs.terminate,
    true,
  );
  assert.deepEqual(
    requireSharedWindow(schedule, 2).preparedFunctionCalls.map(
      ({ functionCall: call }) => call.name,
    ),
    ['public_ptc_terminate_read_after'],
  );
});

void test('prepareFunctionCallSchedule groups explicit PTC cells with reads and subagent launches', () => {
  const daemonContext = createDaemonContext();
  registerScheduleTool(daemonContext, {
    name: 'ptc_window_read_before',
    sideEffectLevel: 'read',
  });
  registerScheduleTool(daemonContext, {
    name: 'ptc_window_subagent',
    sideEffectLevel: 'none',
    parallelBatchKind: 'subagent_launch',
  });
  for (const name of ['ptc_window_cell_one', 'ptc_window_cell_two']) {
    registerScheduleTool(daemonContext, {
      name,
      sideEffectLevel: 'none',
      parallelBatchKind: 'ptc_cell',
    });
  }
  registerScheduleTool(daemonContext, {
    name: 'ptc_window_read_after',
    sideEffectLevel: 'read',
  });

  const schedule = prepareFunctionCallSchedule(
    [
      functionCall('ptc_window_read_before'),
      functionCall('ptc_window_subagent'),
      functionCall('ptc_window_cell_one'),
      functionCall('ptc_window_cell_two'),
      functionCall('ptc_window_read_after'),
    ],
    daemonContext.toolRegistry,
  );
  const sharedWindow = requireSharedWindow(schedule, 0);

  assert.equal(schedule.length, 1);
  assert.equal(schedule[0]?.kind, 'shared_window');
  assert.deepEqual(
    sharedWindow.preparedFunctionCalls.map(
      ({ functionCall: call }) => call.name,
    ),
    [
      'ptc_window_read_before',
      'ptc_window_subagent',
      'ptc_window_cell_one',
      'ptc_window_cell_two',
      'ptc_window_read_after',
    ],
  );
  assert.deepEqual(
    sharedWindow.preparedFunctionCalls.map(({ sharedKind }) => sharedKind),
    ['read_only', 'subagent_launch', 'ptc_cell', 'ptc_cell', 'read_only'],
  );
});
