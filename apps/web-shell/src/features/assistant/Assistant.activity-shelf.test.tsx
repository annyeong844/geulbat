import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import TestRenderer, {
  act,
  type ReactTestInstance,
  type ReactTestRenderer,
} from 'react-test-renderer';
import type { ThreadMessage } from '@geulbat/protocol/threads';

import { brandRunId } from '../../lib/id-brand-helpers.js';
import { createAssistantProps } from '../../test-support/create-assistant-props.js';
import {
  findButtonByText,
  renderedText,
} from '../../test-support/react-test-queries.js';
import { Assistant } from './Assistant.js';

void test('an older run completion leaves the activity shelf but remains in thread history', async () => {
  const html = renderToStaticMarkup(
    <Assistant
      {...createAssistantProps({
        conversation: {
          messages: [
            {
              entryId: 'entry-user',
              role: 'user',
              content: 'old prompt',
              timestamp: '2026-03-24T00:00:00.000Z',
            },
            {
              entryId: 'entry-assistant',
              role: 'assistant',
              content: 'old answer',
              timestamp: '2026-03-24T00:00:01.000Z',
              metadata: {
                phase: 'final_answer',
                sourceRunId: brandRunId('run-parent-1'),
              },
            },
            {
              entryId: 'entry-user-new',
              role: 'user',
              content: 'new prompt',
              timestamp: '2026-03-24T00:01:00.000Z',
            },
            {
              entryId: 'entry-assistant-new',
              role: 'assistant',
              content: 'new answer',
              timestamp: '2026-03-24T00:01:01.000Z',
              metadata: {
                phase: 'final_answer',
                sourceRunId: brandRunId('run-parent-2'),
              },
            },
          ],
        },
        activity: {
          backgroundNotifications: [
            {
              kind: 'subagent_activity',
              parentRunId: 'run-parent-1',
              childRunId: 'run-child-1',
              subagentType: 'explorer',
              state: 'completed',
            },
          ],
        },
      })}
    />,
  );

  assert.match(html, /explorer 작업 완료/u);
  assert.doesNotMatch(html, /assistant-activity-shelf/u);
  // 종료 카드는 라이브 영역 끝이 아니라 부모 런의 최종 답변 위에 귀속된다
  const cardIndex = html.indexOf('explorer 작업 완료');
  assert.ok(cardIndex > html.indexOf('old prompt'));
  assert.ok(cardIndex < html.indexOf('old answer'));
  assert.ok(cardIndex < html.indexOf('new prompt'));
});

void test('a completed subagent card omits stale runtime phase diagnostics', () => {
  const html = renderToStaticMarkup(
    <Assistant
      {...createAssistantProps({
        conversation: {
          messages: [
            {
              entryId: 'entry-assistant',
              role: 'assistant',
              content: 'final answer',
              timestamp: '2026-03-24T00:00:01.000Z',
              metadata: {
                phase: 'final_answer',
                sourceRunId: brandRunId('run-parent-done'),
              },
            },
          ],
        },
        activity: {
          subagentTerminalHistoryEntries: [
            {
              kind: 'subagent_activity',
              deliveryId: 'delivery-done',
              parentRunId: 'run-parent-done',
              childRunId: 'run-child-done',
              subagentType: 'explorer',
              runtime: {
                phase: 'provider_streaming',
                observedAt: '2026-03-24T00:00:00.500Z',
                lastTool: {
                  name: 'read_file',
                  callId: 'call-read',
                  state: 'succeeded',
                },
                partialOutputAvailable: true,
              },
              state: 'completed',
              result: '탐색 결과 요약',
            },
          ],
        },
      })}
    />,
  );

  assert.match(html, /explorer 작업 완료/u);
  // 완료 카드에 "진행: 응답 생성 중" 같은 마지막 관측 진단이 남지 않는다
  assert.doesNotMatch(html, /진행: 응답 생성 중/u);
  assert.doesNotMatch(html, /관측:/u);
  assert.doesNotMatch(html, /최근 도구:/u);
});

void test('an unowned legacy completion does not become a global transcript tail', () => {
  const html = renderToStaticMarkup(
    <Assistant
      {...createAssistantProps({
        conversation: {
          messages: [
            {
              entryId: 'entry-assistant',
              role: 'assistant',
              content: 'newest answer',
              timestamp: '2026-03-24T00:00:01.000Z',
              metadata: {
                phase: 'final_answer',
                sourceRunId: brandRunId('run-current'),
              },
            },
          ],
        },
        activity: {
          backgroundNotifications: [
            {
              kind: 'subagent_activity',
              childRunId: 'run-legacy-child',
              subagentType: 'worker',
              state: 'completed',
            },
          ],
        },
      })}
    />,
  );

  assert.match(html, /newest answer/u);
  assert.doesNotMatch(html, /worker 작업 완료/u);
});

void test('a settled thread moves completed workers from the activity shelf into transcript history', async () => {
  const messages: ThreadMessage[] = [
    {
      entryId: 'entry-plan-old',
      role: 'tool_call',
      content: JSON.stringify({
        callId: 'call-plan-old',
        tool: 'update_plan',
        args: {
          plan: [{ step: '오래된 계획', status: 'completed' }],
        },
      }),
      timestamp: '2026-03-24T00:00:00.000Z',
    },
    {
      entryId: 'entry-answer-old',
      role: 'assistant',
      content: 'old answer',
      timestamp: '2026-03-24T00:00:01.000Z',
      metadata: {
        phase: 'final_answer',
        sourceRunId: brandRunId('run-old'),
      },
    },
    {
      entryId: 'entry-user-new',
      role: 'user',
      content: 'new prompt',
      timestamp: '2026-03-24T00:01:00.000Z',
    },
    {
      entryId: 'entry-plan-new',
      role: 'tool_call',
      content: JSON.stringify({
        callId: 'call-plan-new',
        tool: 'update_plan',
        args: {
          plan: [{ step: '보이는 계획', status: 'completed' }],
        },
      }),
      timestamp: '2026-03-24T00:01:01.000Z',
    },
    {
      entryId: 'entry-answer-new',
      role: 'assistant',
      content: 'new answer',
      timestamp: '2026-03-24T00:01:02.000Z',
      metadata: {
        phase: 'final_answer',
        sourceRunId: brandRunId('run-new'),
      },
    },
  ];
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(
      <Assistant
        {...createAssistantProps({
          conversation: {
            messages: messages,
          },
          activity: {
            backgroundNotifications: [
              {
                kind: 'subagent_activity',
                parentRunId: 'run-old',
                childRunId: 'child-old',
                subagentType: 'explorer',
                state: 'completed',
                result: '오래된 결과',
              },
              {
                kind: 'subagent_activity',
                parentRunId: 'run-new',
                childRunId: 'child-new',
                subagentType: 'worker',
                state: 'completed',
                result: '보이는 결과',
              },
            ],
          },
        })}
      />,
    );
  });
  // 코워크식 수명 — 런이 끝난 스레드에서는 셸프가 아예 mount되지 않는다.
  // 과거 답변으로 스크롤해도 셸프가 숨었다 나타났다 하지 않아야 한다.
  assert.equal(
    renderer.root.findAllByProps({ className: 'assistant-activity-shelf' })
      .length,
    0,
  );
  assert.match(renderedText(renderer.root), /보이는 결과/u);
  assert.match(renderedText(renderer.root), /오래된 결과/u);

  await act(async () => renderer.unmount());
});

void test('an active answer stacks its unfinished TODO and live subagent in the same shelf', async () => {
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(
      <Assistant
        {...createAssistantProps({
          conversation: {
            transcriptEntries: [
              {
                kind: 'tool_activity',
                tool: 'update_plan',
                state: 'completed',
                args: {
                  plan: [{ step: '현재 계획', status: 'in_progress' }],
                },
              },
              {
                kind: 'subagent_activity',
                parentRunId: 'run-active',
                childRunId: 'child-active',
                subagentType: 'explorer',
                state: 'spawned',
              },
            ],
            finalAnswerText: '진행 중인 답변',
          },
          runState: {
            isRunning: true,
          },
        })}
      />,
    );
  });

  const shelves = renderer.root.findAllByProps({
    className: 'assistant-activity-shelf',
  });
  assert.equal(shelves.length, 1);
  assert.match(renderedText(shelves[0]!), /현재 계획/u);
  assert.match(renderedText(shelves[0]!), /explorer/u);
  // 셸프는 컴포저 바로 위 계약 — 실행 중 화면에서 검증한다
  const composer = renderer.root.findByProps({ className: 'composer' });
  const composerRegion = renderer.root.findByProps({
    className: 'composer-region',
  });
  const findComposerRegionSlot = (node: ReactTestInstance) => {
    let current: ReactTestInstance | null = node;
    while (current !== null && current.parent !== composerRegion) {
      current = current.parent;
    }
    return current;
  };
  const shelfSlot = findComposerRegionSlot(shelves[0]!);
  const composerSlot = findComposerRegionSlot(composer);
  if (shelfSlot === null || composerSlot === null) {
    assert.fail('activity shelf and composer must belong to composer region');
  }
  const siblingInstances = composerRegion.children.filter(
    (child): child is ReactTestInstance => typeof child !== 'string',
  );
  assert.equal(
    siblingInstances.indexOf(shelfSlot) + 1,
    siblingInstances.indexOf(composerSlot),
  );
  assert.equal(
    renderer.root.findAllByProps({ className: 'background-work-chip' }).length,
    0,
  );

  await act(async () => renderer.unmount());
});

void test('completed TODO leaves the shelf while completed workers remain visible until the parent answer settles', async () => {
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(
      <Assistant
        {...createAssistantProps({
          conversation: {
            transcriptEntries: [
              {
                kind: 'tool_activity',
                tool: 'update_plan',
                state: 'completed',
                args: {
                  plan: [
                    { step: '완료한 계획 1', status: 'completed' },
                    { step: '완료한 계획 2', status: 'completed' },
                  ],
                },
              },
              {
                kind: 'subagent_activity',
                parentRunId: 'run-active',
                childRunId: 'child-completed',
                subagentType: 'explorer',
                state: 'completed',
                result: '완료 결과',
              },
            ],
            finalAnswerText: '아직 답변을 작성하는 중',
          },
          runState: {
            isRunning: true,
          },
        })}
      />,
    );
  });

  assert.equal(
    renderer.root.findAllByProps({ className: 'assistant-activity-shelf' })
      .length,
    1,
  );
  assert.doesNotMatch(renderedText(renderer.root), /완료한 계획/u);
  assert.match(renderedText(renderer.root), /완료 결과/u);
  assert.equal(renderedText(renderer.root).split('완료 결과').length - 1, 1);
  await act(async () => renderer.unmount());
});

void test('a child that outlives the parent answer keeps the activity shelf and its stop control mounted', async () => {
  let stopped: { parentRunId: string; childRunId: string } | null = null;
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(
      <Assistant
        {...createAssistantProps({
          conversation: {
            messages: [
              {
                entryId: 'entry-background-plan',
                role: 'tool_call',
                content: JSON.stringify({
                  callId: 'call-background-plan',
                  tool: 'update_plan',
                  args: {
                    plan: [
                      { step: '백그라운드 결과 회수', status: 'in_progress' },
                    ],
                  },
                }),
                timestamp: '2026-07-22T00:00:00.000Z',
              },
              {
                entryId: 'entry-parent-answer',
                role: 'assistant',
                content: '백그라운드에서 계속 작업합니다.',
                timestamp: '2026-07-22T00:00:01.000Z',
                metadata: {
                  phase: 'final_answer',
                  sourceRunId: brandRunId('run-parent-1'),
                },
              },
            ],
          },
          activity: {
            backgroundNotifications: [
              {
                kind: 'subagent_activity',
                parentRunId: 'run-parent-1',
                childRunId: 'run-child-1',
                subagentType: 'worker',
                state: 'spawned',
              },
            ],
            onStopChildRun: (request) => {
              stopped = request;
            },
          },
        })}
      />,
    );
  });

  const shelf = renderer.root.findByProps({
    className: 'assistant-activity-shelf',
  });
  assert.match(renderedText(shelf), /worker/u);
  assert.match(renderedText(shelf), /백그라운드 결과 회수/u);
  const stop = findButtonByText(renderer, '중지');
  assert.ok(stop);
  await act(async () => stop.props.onClick());
  assert.deepEqual(stopped, {
    parentRunId: 'run-parent-1',
    childRunId: 'run-child-1',
  });
  await act(async () => renderer.unmount());
});
