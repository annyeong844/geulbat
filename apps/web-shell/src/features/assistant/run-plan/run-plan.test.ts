import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ThreadMessage } from '@geulbat/protocol/threads';

import {
  readRunPlanFromToolArgs,
  readRunPlanFromToolCallContent,
  resolveLatestRunPlan,
} from './run-plan.js';

function planCallMessage(
  plan: Array<{ step: string; status: string }>,
  entryId: string,
): ThreadMessage {
  return {
    entryId,
    role: 'tool_call',
    content: JSON.stringify({
      callId: entryId,
      tool: 'update_plan',
      args: { plan },
    }),
    timestamp: '2026-07-17T09:00:00.000Z',
  } as ThreadMessage;
}

void test('update_plan args에서 계획 단계를 읽는다', () => {
  assert.deepEqual(
    readRunPlanFromToolArgs({
      plan: [
        { step: '저장소 스캔', status: 'completed' },
        { step: '결과 검증', status: 'in_progress' },
      ],
    }),
    [
      { step: '저장소 스캔', status: 'completed' },
      { step: '결과 검증', status: 'in_progress' },
    ],
  );
  assert.equal(readRunPlanFromToolArgs({ plan: [] }), null);
  assert.equal(
    readRunPlanFromToolArgs({ plan: [{ step: '', status: 'pending' }] }),
    null,
  );
  assert.equal(
    readRunPlanFromToolArgs({ plan: [{ step: 'x', status: 'done' }] }),
    null,
  );
});

void test('다른 도구의 tool_call은 계획으로 읽지 않는다', () => {
  assert.equal(
    readRunPlanFromToolCallContent(
      JSON.stringify({ tool: 'read_file', args: { plan: [] } }),
    ),
    null,
  );
});

void test('라이브 엔트리가 settled 메시지보다 우선하고, 최신 계획이 이긴다', () => {
  const plan = resolveLatestRunPlan({
    messages: [
      planCallMessage([{ step: '옛 계획', status: 'pending' }], 'old-1'),
      planCallMessage([{ step: '중간 계획', status: 'pending' }], 'old-2'),
    ],
    transcriptEntries: [
      {
        kind: 'tool_activity',
        tool: 'update_plan',
        state: 'running',
        args: {
          plan: [
            { step: '스캔', status: 'completed' },
            { step: '검증', status: 'in_progress' },
          ],
        },
      },
    ],
  });

  assert.deepEqual(plan, [
    { step: '스캔', status: 'completed' },
    { step: '검증', status: 'in_progress' },
  ]);
});

void test('라이브 계획이 없으면 settled의 최신 계획으로 폴백한다', () => {
  const plan = resolveLatestRunPlan({
    messages: [
      planCallMessage([{ step: '옛 계획', status: 'pending' }], 'old-1'),
      planCallMessage([{ step: '최신 계획', status: 'in_progress' }], 'old-2'),
    ],
    transcriptEntries: [],
  });

  assert.deepEqual(plan, [{ step: '최신 계획', status: 'in_progress' }]);
});
