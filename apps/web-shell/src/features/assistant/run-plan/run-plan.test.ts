import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ThreadMessage } from '@geulbat/protocol/threads';

import type { RunTranscriptEntry } from '../../../lib/run-transcript-entry.js';

import {
  readRunPlanFromToolArgs,
  readRunPlanFromToolCallContent,
  resolveLatestLiveRunPlan,
  resolveLatestRunPlan,
  resolveRunPlanHistory,
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

// Assistant는 재계산 빈도를 나누기 위해 두 조각을 따로 부른다(라이브 조회는
// 스트리밍 델타마다, settled 기록 훑기는 메시지가 바뀔 때만). 그 조합이 합성
// 함수와 같은 답을 주지 않으면 화면의 계획이 조용히 달라진다.
void test('나눠 부른 조각의 조합은 합성 함수와 같은 계획을 준다', () => {
  const cases: ReadonlyArray<{
    label: string;
    messages: ThreadMessage[];
    transcriptEntries: RunTranscriptEntry[];
  }> = [
    {
      label: '라이브 계획이 있을 때',
      messages: [
        planCallMessage([{ step: '옛 계획', status: 'pending' }], 'm1'),
      ],
      transcriptEntries: [
        {
          kind: 'tool_activity',
          tool: 'update_plan',
          state: 'running',
          args: { plan: [{ step: '라이브', status: 'in_progress' }] },
        } as RunTranscriptEntry,
      ],
    },
    {
      label: '라이브 계획이 없을 때',
      messages: [
        planCallMessage([{ step: 'settled', status: 'pending' }], 'm1'),
      ],
      transcriptEntries: [],
    },
    {
      label: '양쪽 모두 없을 때',
      messages: [],
      transcriptEntries: [],
    },
  ];

  for (const { label, messages, transcriptEntries } of cases) {
    const composed = resolveLatestRunPlan({ messages, transcriptEntries });
    const split =
      resolveLatestLiveRunPlan(transcriptEntries) ??
      resolveRunPlanHistory(messages).pendingPlan;
    assert.deepEqual(split, composed, label);
  }
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

void test('최종 답변으로 닫힌 계획은 다음 실행의 현재 계획으로 새지 않는다', () => {
  const plan = resolveLatestRunPlan({
    messages: [
      planCallMessage(
        [{ step: '이미 끝난 작업', status: 'completed' }],
        'settled-plan',
      ),
      {
        entryId: 'settled-answer',
        role: 'assistant',
        content: '완료했습니다.',
        timestamp: '2026-07-17T09:01:00.000Z',
        metadata: {
          phase: 'final_answer',
          sourceRunId: 'run-settled',
        },
      } as ThreadMessage,
    ],
    transcriptEntries: [],
  });

  assert.equal(plan, null);
});

void test('최종 답변이 먼저 나와도 미완료 계획은 백그라운드 작업이 끝날 때까지 남는다', () => {
  const messages: ThreadMessage[] = [
    planCallMessage(
      [
        { step: '평가자 회수', status: 'in_progress' },
        { step: '최종 종합', status: 'pending' },
      ],
      'background-plan',
    ),
    {
      entryId: 'early-answer',
      role: 'assistant',
      content: '평가자들은 계속 작업 중입니다.',
      timestamp: '2026-07-17T09:01:00.000Z',
      metadata: {
        phase: 'final_answer',
        sourceRunId: 'run-background',
      },
    } as ThreadMessage,
  ];

  assert.deepEqual(resolveRunPlanHistory(messages).pendingPlan, [
    { step: '평가자 회수', status: 'in_progress' },
    { step: '최종 종합', status: 'pending' },
  ]);
});

void test('실행 중 스티어링 질문은 진행 중인 계획을 끄지 않는다', () => {
  const plan = [
    { step: '원인 확인', status: 'completed' },
    { step: '회귀 검증', status: 'in_progress' },
  ];
  const messages: ThreadMessage[] = [
    planCallMessage(plan, 'steer-plan'),
    {
      entryId: 'steer-question',
      role: 'user',
      content: '그럼 승인 창은 왜 아직 남아 있나요?',
      timestamp: '2026-07-17T09:01:00.000Z',
      metadata: { source: 'interject' },
    } as ThreadMessage,
  ];

  assert.deepEqual(resolveRunPlanHistory(messages).pendingPlan, plan);

  messages.push({
    entryId: 'next-turn',
    role: 'user',
    content: '새 작업을 시작해 주세요.',
    timestamp: '2026-07-17T09:02:00.000Z',
  });
  assert.equal(resolveRunPlanHistory(messages).pendingPlan, null);
});

void test('한 스레드의 여러 계획은 각각 뒤따르는 최종 답변 run에 귀속된다', () => {
  const messages: ThreadMessage[] = [
    planCallMessage([{ step: '첫 계획', status: 'completed' }], 'plan-1'),
    {
      entryId: 'answer-1',
      role: 'assistant',
      content: '첫 답변',
      timestamp: '2026-07-17T09:01:00.000Z',
      metadata: { phase: 'final_answer', sourceRunId: 'run-1' },
    } as ThreadMessage,
    {
      entryId: 'user-2',
      role: 'user',
      content: '다음 작업',
      timestamp: '2026-07-17T09:02:00.000Z',
    },
    planCallMessage([{ step: '둘째 계획', status: 'in_progress' }], 'plan-2'),
    {
      entryId: 'answer-2',
      role: 'assistant',
      content: '둘째 답변',
      timestamp: '2026-07-17T09:03:00.000Z',
      metadata: { phase: 'final_answer', sourceRunId: 'run-2' },
    } as ThreadMessage,
  ];

  const history = resolveRunPlanHistory(messages);

  assert.deepEqual(history.plansByRunId.get('run-1'), [
    { step: '첫 계획', status: 'completed' },
  ]);
  assert.deepEqual(history.plansByRunId.get('run-2'), [
    { step: '둘째 계획', status: 'in_progress' },
  ]);
  assert.deepEqual(history.pendingPlan, [
    { step: '둘째 계획', status: 'in_progress' },
  ]);
});
