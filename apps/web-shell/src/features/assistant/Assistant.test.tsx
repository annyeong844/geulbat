import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import TestRenderer, {
  act,
  type ReactTestInstance,
  type ReactTestRenderer,
} from 'react-test-renderer';
import type {
  PrepareProviderTransitionRequest,
  ThreadMessage,
} from '@geulbat/protocol/threads';
import type { RunAttachmentInput } from '@geulbat/protocol/run-contract';

import { Assistant, type AssistantComposerControls } from './Assistant.js';
import { AssistantComposer } from './AssistantComposer.js';
import { PlanningWorkflowCard } from './run-plan/planning-workflow-card.js';
import {
  createCommittedArtifact,
  createCommittedArtifactMessage,
} from '../../test-support/thread-artifact-fixtures.js';
import { makeApprovalRequiredFixture } from '../../test-support/protocol-fixtures.js';
import { createAssistantProps } from '../../test-support/create-assistant-props.js';
import { brandRunId } from '../../lib/id-brand-helpers.js';
import { assertRunId, assertThreadId } from '@geulbat/protocol/ids';
import type {
  PlanningWorkflowSnapshot,
  PlanWorkflowCommand,
} from '@geulbat/protocol/planning-workflow';

(
  globalThis as typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
  }
).IS_REACT_ACT_ENVIRONMENT = true;

// 컴포저 컨트롤 한 벌은 값·핸들러가 짝으로 필수라, 검사할 항목만 덮어쓰고
// 나머지는 여기서 합성한다.
function composerControls(
  overrides: Partial<AssistantComposerControls> = {},
): AssistantComposerControls {
  return {
    permissionMode: 'basic',
    onPermissionModeChange: () => {},
    planModeRequested: false,
    onPlanModeRequestedChange: () => {},
    planModeIntensity: 'visual',
    onPlanModeIntensityChange: () => {},
    planModeDepth: 'standard',
    onPlanModeDepthChange: () => {},
    modelId: 'gpt-5.6-sol',
    onModelIdChange: () => {},
    reasoningEffort: 'medium',
    onReasoningEffortChange: () => {},
    serviceTier: 'standard',
    onServiceTierChange: () => {},
    subagentModelRouting: { mode: 'auto' },
    onSubagentModelRoutingChange: () => {},
    ...overrides,
  };
}

function awaitingPlanningSnapshot(
  threadId: ReturnType<typeof assertThreadId>,
): Extract<PlanningWorkflowSnapshot, { state: 'awaiting_approval' }> {
  return {
    state: 'awaiting_approval',
    workflowId: 'workflow-card',
    threadId,
    intensity: 'visual',
    depth: 'deep',
    planId: 'plan-card',
    revision: 2,
    digest:
      'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    draft: {
      schemaVersion: 'plan_draft_v1',
      outcome: '승인 카드로 자동 인계',
      steps: [
        {
          id: 'handoff',
          text: '정확한 revision을 실행으로 넘긴다',
          acceptanceCriteria: ['사용자 재입력이 없다'],
        },
      ],
      decisions: [],
      assumptions: [],
      openQuestions: [],
    },
    proposalRunId: assertRunId('run-plan-card'),
    createdAt: '2026-07-26T00:00:00.000Z',
    updatedAt: '2026-07-26T00:00:01.000Z',
  };
}

void test('trusted planning card approves the exact daemon revision without a new user prompt', async () => {
  const commands: PlanWorkflowCommand[] = [];
  const threadId = assertThreadId('123e4567-e89b-42d3-a456-426614174028');
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(
      <Assistant
        {...createAssistantProps({
          conversation: {
            threadId: threadId,
          },
          runActions: {
            onSend: () => {
              assert.fail('approval must not send a user prompt');
            },
          },
          workflow: {
            planningWorkflow: {
              busy: false,
              snapshot: awaitingPlanningSnapshot(threadId),
              async onCommand(command) {
                commands.push(command);
              },
            },
          },
        })}
      />,
    );
  });

  const approve = findButtonByText(renderer, '이 계획 승인');
  assert.ok(approve);
  await act(async () => {
    approve.props.onClick();
    await Promise.resolve();
  });
  assert.deepEqual(commands, [
    {
      kind: 'approve',
      threadId,
      workflowId: 'workflow-card',
      planId: 'plan-card',
      revision: 2,
      digest:
        'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    },
  ]);
  await act(async () => renderer.unmount());
});

void test('the approval card restores its matching persisted visualization inline', async () => {
  const threadId = assertThreadId('123e4567-e89b-42d3-a456-426614174031');
  const snapshot = awaitingPlanningSnapshot(threadId);
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(
      <Assistant
        {...createAssistantProps({
          conversation: {
            threadId,
            messages: [
              {
                entryId: 'entry-plan-visualization',
                role: 'tool_call',
                content: JSON.stringify({
                  tool: 'visualize',
                  args: {
                    mode: 'svg',
                    title: '승인할 계획 그림',
                    code: '<svg role="img" aria-label="승인할 계획"></svg>',
                    planStamp: {
                      workflowId: snapshot.workflowId,
                      planId: snapshot.planId,
                      revision: snapshot.revision,
                      digest: snapshot.digest,
                    },
                  },
                }),
                timestamp: '2026-07-26T00:00:02.000Z',
              },
            ],
          },
          workflow: {
            planningWorkflow: {
              busy: false,
              snapshot,
              async onCommand() {},
            },
          },
        })}
      />,
    );
  });

  assert.equal(
    renderer.root.findAll(
      (node) => node.props.className === 'planning-workflow-visualization',
    ).length,
    1,
  );
  assert.ok(findButtonByText(renderer, '그림 다시 만들기'));
  await act(async () => renderer.unmount());
});

void test('a failed plan execution retries the preserved exact revision', async () => {
  const commands: PlanWorkflowCommand[] = [];
  const threadId = assertThreadId('123e4567-e89b-42d3-a456-426614174032');
  const approved = awaitingPlanningSnapshot(threadId);
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(
      <PlanningWorkflowCard
        workflow={{
          busy: false,
          snapshot: {
            ...approved,
            state: 'execution_failed',
            executionRunId: assertRunId('run-plan-card-failed'),
          },
          async onCommand(command) {
            commands.push(command);
          },
        }}
      />,
    );
  });

  const retry = findButtonByText(renderer, '이 계획 다시 실행');
  assert.ok(retry);
  await act(async () => {
    retry.props.onClick();
    await Promise.resolve();
  });
  assert.deepEqual(commands, [
    {
      kind: 'retry_execution',
      threadId,
      workflowId: approved.workflowId,
      planId: approved.planId,
      revision: approved.revision,
      digest: approved.digest,
    },
  ]);
  await act(async () => renderer.unmount());
});

void test('a collecting workflow occupies no card space while the planning run is busy', async () => {
  const threadId = assertThreadId('123e4567-e89b-42d3-a456-426614174029');
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(
      <PlanningWorkflowCard
        workflow={{
          busy: true,
          snapshot: {
            state: 'collecting',
            workflowId: 'workflow-collecting-busy',
            threadId,
            intensity: 'visual',
            depth: 'deep',
            createdAt: '2026-07-26T00:00:00.000Z',
            updatedAt: '2026-07-26T00:00:01.000Z',
          },
          async onCommand() {},
        }}
      />,
    );
  });

  assert.equal(renderer.toJSON(), null);
  await act(async () => renderer.unmount());
});

void test('an idle collecting workflow leaves only a compact cancel control', async () => {
  const threadId = assertThreadId('123e4567-e89b-42d3-a456-426614174030');
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(
      <PlanningWorkflowCard
        workflow={{
          busy: false,
          snapshot: {
            state: 'collecting',
            workflowId: 'workflow-collecting-idle',
            threadId,
            intensity: 'quiet',
            depth: 'deep',
            createdAt: '2026-07-26T00:00:00.000Z',
            updatedAt: '2026-07-26T00:00:01.000Z',
          },
          async onCommand() {},
        }}
      />,
    );
  });

  const text = renderedText(renderer.root);
  assert.match(text, /심층 계획 진행 중/u);
  assert.match(text, /계획 취소/u);
  assert.doesNotMatch(text, /계획을 정리하고 있어요|조사가 끝나면/u);
  assert.equal(
    renderer.root.findByType('section').props.className,
    'planning-workflow-collecting-control',
  );
  await act(async () => renderer.unmount());
});

function renderedText(node: ReactTestInstance | string): string {
  if (typeof node === 'string') {
    return node;
  }
  return node.children
    .map((child) => renderedText(child as ReactTestInstance | string))
    .join('');
}

function findButtonByText(renderer: ReactTestRenderer, text: string) {
  return renderer.root
    .findAllByType('button')
    .find((button) => renderedText(button).includes(text));
}

const PROVIDER_TRANSITION_MESSAGE = {
  entryId: 'entry-provider-transition',
  role: 'user' as const,
  content: '긴 대화를 계속해 주세요',
  timestamp: '2026-07-17T00:00:00.000Z',
};

void test('ask_user answer waits for done and stays dismissed through live-to-settled handoff', async () => {
  const sent: string[] = [];
  const liveEntries = [
    {
      kind: 'tool_activity' as const,
      tool: 'ask_user',
      state: 'running' as const,
      callId: 'call-ask-handoff',
      args: {
        question: '계속할까요?',
        options: [
          { label: '계속', description: '다음 턴을 시작합니다.' },
          { label: '중지', description: '여기서 멈춥니다.' },
        ],
      },
    },
    {
      kind: 'tool_activity' as const,
      tool: 'ask_user',
      state: 'completed' as const,
      callId: 'call-ask-handoff',
    },
  ];
  const settledMessages: ThreadMessage[] = [
    {
      entryId: 'ask-handoff-call',
      role: 'tool_call',
      content: JSON.stringify({
        callId: 'call-ask-handoff',
        tool: 'ask_user',
        args: liveEntries[0]?.args,
      }),
      timestamp: '2026-07-22T00:00:00.000Z',
    },
    {
      entryId: 'ask-handoff-result',
      role: 'tool_result',
      content: JSON.stringify({
        callId: 'call-ask-handoff',
        tool: 'ask_user',
        ok: true,
        output: '{"asked":true}',
      }),
      timestamp: '2026-07-22T00:00:01.000Z',
    },
  ];
  const render = (props: {
    isRunning: boolean;
    isSettling: boolean;
    messages: ThreadMessage[];
    transcriptEntries: typeof liveEntries;
  }) => (
    <Assistant
      {...createAssistantProps({
        conversation: {
          threadId: 'thread-ask-handoff',
          messages: props.messages,
          transcriptEntries: props.transcriptEntries,
        },
        runState: {
          isRunning: props.isRunning,
          isSettling: props.isSettling,
        },
        runActions: {
          onSend: async () => {
            assert.fail('ask_user answer must use the new-turn-only sender');
          },
          onSendNewTurn: async (prompt) => {
            sent.push(prompt);
          },
        },
      })}
    />
  );

  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(
      render({
        isRunning: true,
        isSettling: false,
        messages: [],
        transcriptEntries: liveEntries,
      }),
    );
  });
  const continueButton = findButtonByText(renderer, '계속');
  assert.ok(continueButton);
  await act(async () => {
    continueButton.props.onClick();
    await Promise.resolve();
  });
  assert.deepEqual(sent, []);
  assert.equal(
    renderer.root.findAllByProps({ className: 'ask-user-card' }).length,
    0,
  );

  await act(async () => {
    renderer.update(
      render({
        isRunning: false,
        isSettling: true,
        messages: settledMessages,
        transcriptEntries: [],
      }),
    );
  });
  assert.deepEqual(sent, []);
  assert.equal(
    renderer.root.findAllByProps({ className: 'ask-user-card' }).length,
    0,
  );

  await act(async () => {
    renderer.update(
      render({
        isRunning: false,
        isSettling: false,
        messages: settledMessages,
        transcriptEntries: [],
      }),
    );
    await Promise.resolve();
    await Promise.resolve();
  });
  assert.deepEqual(sent, ['계속']);
  assert.equal(
    renderer.root.findAllByProps({ className: 'ask-user-card' }).length,
    0,
  );
  await act(async () => renderer.unmount());
});

void test('cross-provider model selection switches immediately without an eager recovery prompt', async () => {
  const selected: string[] = [];
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(
      <Assistant
        {...createAssistantProps({
          conversation: {
            messages: [PROVIDER_TRANSITION_MESSAGE],
          },
          runState: {
            streamError:
              '[llm_context_length_exceeded] previous attempt failed',
            streamErrorCode: 'llm_context_length_exceeded',
          },
          composerControls: composerControls({
            modelId: 'grok-4.5',
            reasoningEffort: 'high',
            onModelIdChange: (modelId) => selected.push(modelId),
          }),
        })}
      />,
    );
  });

  const openModelMenu = async () => {
    const toggle = renderer.root.findByProps({
      title: '모델, 사고 강도와 속도',
    });
    await act(async () => {
      toggle.findByType('button').props.onClick({ stopPropagation() {} });
    });
  };
  const chooseGpt = async () => {
    const row = findButtonByText(renderer, 'GPT-5.6 Sol');
    assert.ok(row);
    await act(async () => {
      row.props.onClick();
    });
  };

  await openModelMenu();
  await chooseGpt();
  assert.deepEqual(selected, ['gpt-5.6-sol']);
  assert.equal(renderer.root.findAllByProps({ role: 'alertdialog' }).length, 0);
  await act(async () => renderer.unmount());
});

void test('actual target overflow asks for source-provider handoff before retrying the failed prompt', async () => {
  const prepared: PrepareProviderTransitionRequest[] = [];
  const regenerated: string[] = [];
  const selected: string[] = [];
  let renderer!: ReactTestRenderer;
  const render = (props: {
    modelId: 'grok-4.5' | 'gpt-5.6-sol';
    isStarting?: boolean;
    streamError?: string | null;
    streamErrorCode?: 'llm_context_length_exceeded' | null;
  }) => (
    <Assistant
      {...createAssistantProps({
        conversation: {
          messages: [PROVIDER_TRANSITION_MESSAGE],
        },
        runState: {
          streamError: props.streamError ?? null,
          streamErrorCode: props.streamErrorCode ?? null,
          ...(props.isStarting === undefined
            ? {}
            : { isStarting: props.isStarting }),
        },
        runActions: {
          onPrepareProviderTransition: async (request) => {
            prepared.push(request);
          },
          onRegenerate: async (prompt) => {
            regenerated.push(prompt);
          },
        },
        composerControls: composerControls({
          modelId: props.modelId,
          reasoningEffort: 'high',
          onModelIdChange: (modelId) => selected.push(modelId),
        }),
      })}
    />
  );
  await act(async () => {
    renderer = TestRenderer.create(render({ modelId: 'grok-4.5' }));
  });

  const toggle = renderer.root.findByProps({
    title: '모델, 사고 강도와 속도',
  });
  await act(async () => {
    toggle.findByType('button').props.onClick({ stopPropagation() {} });
  });
  const row = findButtonByText(renderer, 'GPT-5.6 Sol');
  assert.ok(row);
  await act(async () => row.props.onClick());
  assert.deepEqual(selected, ['gpt-5.6-sol']);
  assert.equal(renderer.root.findAllByProps({ role: 'alertdialog' }).length, 0);

  await act(async () => {
    renderer.update(render({ modelId: 'gpt-5.6-sol', isStarting: true }));
  });
  await act(async () => {
    renderer.update(
      render({
        modelId: 'gpt-5.6-sol',
        streamError: '[llm_context_length_exceeded] context limit exceeded',
        streamErrorCode: 'llm_context_length_exceeded',
      }),
    );
  });

  assert.ok(renderer.root.findByProps({ role: 'alertdialog' }));
  assert.match(renderedText(renderer.root), /대상 문맥 한계를 넘었거나/u);
  const confirm = findButtonByText(renderer, '압축 후 다시 시도');
  assert.ok(confirm);
  await act(async () => {
    await confirm.props.onClick();
  });

  assert.deepEqual(prepared, [
    {
      sourceModelId: 'grok-4.5',
      targetModelId: 'gpt-5.6-sol',
      reasoningEffort: 'high',
    },
  ]);
  assert.deepEqual(regenerated, ['긴 대화를 계속해 주세요']);
  assert.equal(renderer.root.findAllByProps({ role: 'alertdialog' }).length, 0);
  await act(async () => renderer.unmount());
});

void test('structurally incompatible transition keeps the selected target and an actionable recovery dialog', async () => {
  const selected: string[] = [];
  const prepared: PrepareProviderTransitionRequest[] = [];
  let renderer!: ReactTestRenderer;
  const render = (props: {
    modelId: 'gpt-5.6-sol' | 'gpt-5.6-luna';
    isStarting?: boolean;
    streamError?: string | null;
    streamErrorCode?:
      | 'llm_context_length_exceeded'
      | 'provider_transition_required'
      | null;
  }) => (
    <Assistant
      {...createAssistantProps({
        conversation: {
          messages: [PROVIDER_TRANSITION_MESSAGE],
        },
        runState: {
          streamError: props.streamError ?? null,
          streamErrorCode: props.streamErrorCode ?? null,
          ...(props.isStarting === undefined
            ? {}
            : { isStarting: props.isStarting }),
        },
        runActions: {
          onPrepareProviderTransition: async (request) => {
            prepared.push(request);
            throw new Error('문맥이 바뀌어 압축하지 않았어요.');
          },
          onRegenerate: () => {
            assert.fail('failed preparation must not retry the prompt');
          },
        },
        composerControls: composerControls({
          modelId: props.modelId,
          reasoningEffort: 'high',
          onModelIdChange: (modelId) => selected.push(modelId),
        }),
      })}
    />
  );
  await act(async () => {
    renderer = TestRenderer.create(render({ modelId: 'gpt-5.6-sol' }));
  });
  const toggle = renderer.root.findByProps({
    title: '모델, 사고 강도와 속도',
  });
  await act(async () => {
    toggle.findByType('button').props.onClick({ stopPropagation() {} });
  });
  const row = findButtonByText(renderer, 'GPT-5.6 Luna');
  assert.ok(row);
  await act(async () => row.props.onClick());
  await act(async () => {
    renderer.update(render({ modelId: 'gpt-5.6-luna', isStarting: true }));
  });
  await act(async () => {
    renderer.update(
      render({
        modelId: 'gpt-5.6-luna',
        streamError:
          '[provider_transition_required] provider transition requires a portable context handoff',
        streamErrorCode: 'provider_transition_required',
      }),
    );
  });
  assert.deepEqual(selected, ['gpt-5.6-luna']);
  assert.match(renderedText(renderer.root), /reasoning\/tool-call/u);
  const confirm = findButtonByText(renderer, '압축 후 다시 시도');
  assert.ok(confirm);
  await act(async () => {
    await confirm.props.onClick();
  });

  assert.ok(renderer.root.findByProps({ role: 'alertdialog' }));
  assert.match(renderedText(renderer.root), /문맥이 바뀌어 압축하지 않았어요/u);
  assert.deepEqual(prepared, [
    {
      sourceModelId: 'gpt-5.6-sol',
      targetModelId: 'gpt-5.6-luna',
      reasoningEffort: 'high',
    },
  ]);
  assert.deepEqual(selected, ['gpt-5.6-luna']);
  await act(async () => renderer.unmount());
});

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

void test('assistant transcript exposes a polite live region for streamed updates', () => {
  const html = renderToStaticMarkup(
    <Assistant
      {...createAssistantProps({
        conversation: {
          transcriptEntries: [{ kind: 'assistant_text', text: 'Thinking...' }],
        },
        runState: {
          isRunning: true,
        },
      })}
    />,
  );

  assert.match(html, /role="log"/);
  assert.match(html, /aria-label="Assistant transcript"/);
  assert.match(html, /aria-live="polite"/);
  assert.match(html, /aria-relevant="additions text"/);
  assert.match(html, /aria-atomic="false"/);
  assert.match(html, /aria-busy="true"/);
});

void test('assistant keeps child session drill-down available in the active run shelf', async () => {
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(
      <Assistant
        {...createAssistantProps({
          conversation: {
            transcriptEntries: [
              {
                kind: 'subagent_activity',
                parentRunId: 'active-run-1',
                childRunId: 'child-run-1',
                childThreadId: '00000000-0000-4000-8000-000000000777',
                subagentType: 'explorer',
                state: 'spawned',
              },
            ],
          },
          runState: {
            isRunning: true,
          },
        })}
      />,
    );
  });

  assert.match(renderedText(renderer.root), /트랜스크립트 보기/u);
  await act(async () => renderer.unmount());
});

void test('assistant restores terminal worker diagnostics and drill-down from durable thread history', () => {
  const html = renderToStaticMarkup(
    <Assistant
      {...createAssistantProps({
        activity: {
          subagentTerminalHistoryEntries: [
            {
              kind: 'subagent_activity',
              deliveryId: 'delivery-history',
              parentRunId: 'parent-run-history',
              childRunId: 'child-run-retry',
              childThreadId: '00000000-0000-4000-8000-000000000778',
              subagentType: 'worker',
              capabilities: [],
              toolSurface: 'worker',
              runtime: {
                phase: 'tool_running',
                observedAt: '2026-07-23T10:00:00.000Z',
                lastTool: {
                  name: 'apply_patch',
                  callId: 'call-patch',
                  state: 'failed',
                },
                partialOutputAvailable: true,
                previousChildRunId: brandRunId('child-run-original'),
              },
              state: 'failed',
              reason: 'daemon_restart',
              result: '재시작 전에 남긴 부분 결과',
            },
          ],
        },
      })}
    />,
  );

  assert.match(html, /재시작 전에 남긴 부분 결과/u);
  assert.match(html, /최근 도구: apply_patch \(실패\)/u);
  assert.match(html, /부분 출력: 있음/u);
  assert.match(html, /재시도 원본: child-run-original/u);
  assert.match(html, /종료 원인: 데몬 재시작/u);
  assert.match(html, /트랜스크립트 보기/u);
  assert.doesNotMatch(html, /assistant-activity-shelf/u);
});

void test('assistant offers retry after a settled answer and hides it mid-run', () => {
  const settledMessages = [
    {
      entryId: 'entry-user-1',
      role: 'user' as const,
      content: '요약해줘',
      timestamp: '2026-07-11T00:00:00.000Z',
    },
    {
      entryId: 'entry-assistant-1',
      role: 'assistant' as const,
      content: '요약입니다.',
      timestamp: '2026-07-11T00:00:01.000Z',
    },
  ];

  const idleHtml = renderToStaticMarkup(
    <Assistant
      {...createAssistantProps({
        conversation: {
          messages: settledMessages,
        },
      })}
    />,
  );
  assert.match(idleHtml, /답변 다시 시도/);
  // 질문/답변 원터치 복사 버튼도 메시지마다 노출
  assert.match(idleHtml, /메시지 복사/);
  // 마지막 질문에는 인라인 수정 버튼이 붙는다 (hover 시 노출은 CSS 담당)
  assert.match(idleHtml, /질문 수정/);
  assert.match(idleHtml, /user-actions/);
  assert.match(idleHtml, /assistant-actions/);

  const runningHtml = renderToStaticMarkup(
    <Assistant
      {...createAssistantProps({
        conversation: {
          messages: settledMessages,
        },
        runState: {
          isRunning: true,
        },
      })}
    />,
  );
  assert.doesNotMatch(runningHtml, /답변 다시 시도/);

  // 마지막 메시지가 사용자 질문이고 에러도 없으면 재시도 대상이 없다
  const pendingHtml = renderToStaticMarkup(
    <Assistant
      {...createAssistantProps({
        conversation: {
          messages: settledMessages.slice(0, 1),
        },
      })}
    />,
  );
  assert.doesNotMatch(pendingHtml, /답변 다시 시도/);
});

void test('assistant offers retry when the run failed with a stream error', () => {
  const html = renderToStaticMarkup(
    <Assistant
      {...createAssistantProps({
        conversation: {
          messages: [
            {
              entryId: 'entry-user-1',
              role: 'user' as const,
              content: '요약해줘',
              timestamp: '2026-07-11T00:00:00.000Z',
            },
          ],
        },
        runState: {
          streamError: '[internal] provider request failed',
        },
      })}
    />,
  );
  assert.match(html, /답변 다시 시도/);
});

void test('failed approved execution offers only the exact-plan retry', () => {
  const threadId = assertThreadId('123e4567-e89b-42d3-a456-426614174033');
  const html = renderToStaticMarkup(
    <Assistant
      {...createAssistantProps({
        conversation: {
          threadId,
          messages: [
            {
              entryId: 'entry-user-approved-plan',
              role: 'user',
              content: '리뷰만 해줘',
              timestamp: '2026-07-26T00:00:00.000Z',
            },
          ],
        },
        runState: {
          streamError: '[llm_connect_timeout] provider request failed',
        },
        workflow: {
          planningWorkflow: {
            busy: false,
            snapshot: {
              ...awaitingPlanningSnapshot(threadId),
              state: 'execution_failed',
              executionRunId: assertRunId('run-approved-plan-timeout'),
            },
            async onCommand() {},
          },
        },
      })}
    />,
  );

  assert.match(html, /이 계획 다시 실행/u);
  assert.doesNotMatch(html, /답변 다시 시도/u);
});

void test('assistant composer renders the selected current model', () => {
  const html = renderToStaticMarkup(
    <Assistant
      {...createAssistantProps({
        composerControls: composerControls({
          modelId: 'grok-4.5',
          reasoningEffort: 'high',
        }),
      })}
    />,
  );

  assert.match(html, /Grok 4\.5 높음/);
});

void test('assistant requests the native folder picker when the user chooses the start location', async () => {
  let chooseCount = 0;
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(
      <Assistant
        {...createAssistantProps({
          workspace: {
            workingDirectory: 'home/user',
            browseStartPath: 'home/user',
            onChooseWorkingDirectory: async () => {
              chooseCount += 1;
            },
          },
        })}
      />,
    );
  });

  const plusButton = renderer.root
    .findAllByType('button')
    .find((button) => button.props.title === '첨부와 도구');
  assert.ok(plusButton);
  act(() => {
    plusButton.props.onClick();
  });

  const startLocation = findButtonByText(renderer, '시작 위치');
  assert.ok(startLocation);
  await act(async () => {
    startLocation.props.onClick();
  });

  assert.equal(chooseCount, 1);
  assert.equal(renderer.root.findAllByProps({ role: 'dialog' }).length, 0);
  await act(async () => renderer.unmount());
});

void test('assistant uses the cross-platform Computer browser for cwd when browse metadata is available', async (t) => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ root: 'computer', tree: [] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  let nativeChooseCount = 0;
  let selectedPath: string | null = null;
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(
      <Assistant
        {...createAssistantProps({
          workspace: {
            workingDirectory: 'home/writer',
            browseEnabled: true,
            browsePath: 'home/writer/projects',
            browseStartPath: 'home/writer',
            browseShortcuts: [
              { label: 'Fedora', path: '' },
              { label: 'Archive', path: 'volumes/archive' },
            ],
            onSelectWorkingDirectory: (path) => {
              selectedPath = path;
            },
            onChooseWorkingDirectory: async () => {
              nativeChooseCount += 1;
            },
          },
        })}
      />,
    );
  });

  const plusButton = renderer.root
    .findAllByType('button')
    .find((button) => button.props.title === '첨부와 도구');
  assert.ok(plusButton);
  act(() => {
    plusButton.props.onClick();
  });
  const startLocation = findButtonByText(renderer, '시작 위치');
  assert.ok(startLocation);
  await act(async () => {
    startLocation.props.onClick();
  });

  assert.equal(renderer.root.findAllByProps({ role: 'dialog' }).length, 1);
  assert.ok(findButtonByText(renderer, 'Fedora'));
  assert.ok(findButtonByText(renderer, 'Archive'));
  assert.equal(nativeChooseCount, 0);

  const useFolder = findButtonByText(renderer, '이 폴더 사용');
  assert.ok(useFolder);
  await act(async () => {
    useFolder.props.onClick();
  });
  assert.equal(selectedPath, 'home/writer');
  assert.equal(renderer.root.findAllByProps({ role: 'dialog' }).length, 0);

  await act(async () => renderer.unmount());
});

void test('assistant keeps the native picker single-flight until the selection settles', async () => {
  let chooseCount = 0;
  let finishSelection: (() => void) | undefined;
  const selection = new Promise<void>((resolve) => {
    finishSelection = resolve;
  });
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(
      <Assistant
        {...createAssistantProps({
          workspace: {
            workingDirectory: 'home/user',
            browseStartPath: 'home/user',
            onChooseWorkingDirectory: () => {
              chooseCount += 1;
              return selection;
            },
          },
        })}
      />,
    );
  });

  const openPlusMenu = () => {
    renderer.root
      .findAllByType('button')
      .find((button) => button.props.title === '첨부와 도구')
      ?.props.onClick();
  };
  act(openPlusMenu);
  const firstStartLocation = findButtonByText(renderer, '시작 위치');
  assert.ok(firstStartLocation);
  await act(async () => {
    firstStartLocation.props.onClick();
    await Promise.resolve();
  });

  assert.equal(chooseCount, 1);
  act(openPlusMenu);
  const pendingStartLocation = findButtonByText(renderer, '시작 위치');
  assert.ok(pendingStartLocation);
  assert.equal(pendingStartLocation.props.disabled, true);
  assert.match(
    renderedText(pendingStartLocation),
    /폴더 선택 창이 열려 있어요/u,
  );

  if (finishSelection === undefined) {
    throw new Error('selection completion was not captured');
  }
  const completeSelection = finishSelection;
  await act(async () => {
    completeSelection();
    await selection;
  });
  const settledStartLocation = findButtonByText(renderer, '시작 위치');
  assert.ok(settledStartLocation);
  assert.equal(settledStartLocation.props.disabled, false);
  assert.equal(chooseCount, 1);
  await act(async () => renderer.unmount());
});

void test('assistant exposes native folder picker failures without changing the cwd', async () => {
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(
      <Assistant
        {...createAssistantProps({
          workspace: {
            workingDirectory: 'home/user',
            browseStartPath: 'home/user',
            onChooseWorkingDirectory: async () => {
              throw new Error('native dialog unavailable');
            },
          },
        })}
      />,
    );
  });

  act(() => {
    renderer.root
      .findAllByType('button')
      .find((button) => button.props.title === '첨부와 도구')
      ?.props.onClick();
  });
  const startLocation = findButtonByText(renderer, '시작 위치');
  assert.ok(startLocation);
  await act(async () => {
    startLocation.props.onClick();
  });

  assert.match(
    renderer.root.findByProps({ role: 'alert' }).children.join(''),
    /native dialog unavailable/u,
  );
  await act(async () => renderer.unmount());
});

void test('assistant composer renders a fixed Luna xhigh subagent route independently from the root model', () => {
  const html = renderToStaticMarkup(
    <Assistant
      {...createAssistantProps({
        composerControls: composerControls({
          modelId: 'grok-4.5',
          reasoningEffort: 'high',
          subagentModelRouting: {
            mode: 'fixed',
            choice: { modelId: 'gpt-5.6-luna', reasoningEffort: 'xhigh' },
          },
        }),
      })}
    />,
  );

  // 고정 라우팅은 통합 피커 안(서브패널)으로 들어갔다 — 트리거 라벨은
  // 루트 모델만 보여주고, 고정 상태는 메뉴를 열어야 보인다.
  assert.match(html, /Grok 4\.5 높음/);
});

void test('assistant keeps legacy transcript envelope content as plain text without preview controls', () => {
  const html = renderToStaticMarkup(
    <Assistant
      {...createAssistantProps({
        conversation: {
          messages: [
            {
              entryId: 'entry-legacy-artifact-envelope',
              role: 'assistant',
              content:
                '<!-- GEULBAT_ARTIFACT {"renderer":"markdown","digest":"요약"} -->\n# title\n<!-- /GEULBAT_ARTIFACT -->',
              timestamp: '2026-03-24T00:00:01.000Z',
              metadata: {
                sourceFile: 'episodes/ch01.md',
                sourceRunId: brandRunId('run-1'),
                phase: 'final_answer',
              },
            },
          ],
        },
      })}
    />,
  );

  assert.doesNotMatch(html, /Show/);
  assert.doesNotMatch(html, /Apply/);
  assert.doesNotMatch(html, /Export/);
  assert.doesNotMatch(html, /원본 열기/);
  assert.match(html, /title/);
  assert.match(html, /요약/);
});

void test('assistant renders committed artifact objects from versioned refs without reparsing transcript text', () => {
  const artifact = createCommittedArtifact({
    artifactId: 'art_1',
    renderer: 'markdown',
    payload: '# title',
    digest: '요약',
  });

  const html = renderToStaticMarkup(
    <Assistant
      {...createAssistantProps({
        conversation: {
          messages: [createCommittedArtifactMessage(artifact)],
        },
        artifacts: {
          versions: [artifact],
        },
      })}
    />,
  );

  assert.match(html, /보기/);
  assert.match(html, /적용/);
  assert.match(html, /내보내기/);
  assert.match(html, /title/);
  assert.doesNotMatch(html, /요약/);
});

void test('assistant keeps assistant prose visible when a committed artifact ref is present', () => {
  const artifact = createCommittedArtifact({
    artifactId: 'art_backfilled_1',
    renderer: 'markdown',
    payload: '# normalized title',
    digest: 'normalized-digest',
  });

  const html = renderToStaticMarkup(
    <Assistant
      {...createAssistantProps({
        conversation: {
          messages: [
            createCommittedArtifactMessage(artifact, {
              content: 'Here is the normalized artifact.',
            }),
          ],
        },
        artifacts: {
          versions: [artifact],
        },
      })}
    />,
  );

  assert.match(html, /Here is the normalized artifact\./);
  assert.match(html, /normalized title/);
});

void test('assistant keeps live final answer prose visible alongside the committed artifact object', () => {
  const artifact = createCommittedArtifact({
    artifactId: 'art_live_1',
    renderer: 'markdown',
    payload: '# live title',
    digest: 'live-digest',
  });

  const html = renderToStaticMarkup(
    <Assistant
      {...createAssistantProps({
        conversation: {
          finalAnswerText: 'Here is the live answer.',
        },
        artifacts: {
          versions: [],
          activeVersion: artifact,
        },
        runState: {
          isRunning: true,
        },
      })}
    />,
  );

  assert.match(html, /Here is the live answer\./);
  assert.match(html, /live title/);
});

void test('assistant treats live finalAnswerText as plain transcript text instead of parsing a streaming artifact preview', () => {
  const html = renderToStaticMarkup(
    <Assistant
      {...createAssistantProps({
        conversation: {
          finalAnswerText:
            '<!-- GEULBAT_ARTIFACT {"renderer":"html5","digest":"romance-fantasy-character-map-v2"} -->\n<!DOCTYPE html><html lang="ko"><body><section>hello</section></body></html>\n<!-- /GEULBAT_ARTIFACT -->',
        },
        runState: {
          isRunning: true,
        },
      })}
    />,
  );

  assert.match(html, /assistant/);
  assert.doesNotMatch(html, /<iframe/);
  assert.match(
    html,
    /&lt;!-- GEULBAT_ARTIFACT \{&quot;renderer&quot;:&quot;html5&quot;,&quot;digest&quot;:&quot;romance-fantasy-character-map-v2&quot;\} --&gt;/,
  );
});

void test('assistant keeps incomplete live artifact transport as plain text instead of a pending preview shell', () => {
  const html = renderToStaticMarkup(
    <Assistant
      {...createAssistantProps({
        conversation: {
          finalAnswerText:
            '<!-- GEULBAT_ARTIFACT {"renderer":"html5","digest":"creative-html-v1"} -->\n* { box-sizing: border-box; }\nhtml, body { margin: 0; }\nbody { min-height: 100vh; }',
        },
        runState: {
          isRunning: true,
        },
      })}
    />,
  );

  assert.doesNotMatch(html, /<iframe/);
  assert.match(html, /\* \{ box-sizing/);
});

void test('assistant does not reconstruct artifacts from commentary plus final answer fragments', () => {
  const html = renderToStaticMarkup(
    <Assistant
      {...createAssistantProps({
        conversation: {
          transcriptEntries: [
            {
              kind: 'assistant_text',
              text: '<!-- GEULBAT_ARTIFACT {"renderer":"html5","digest":"romance-fantasy-character-map-v2"} -->\n<!DOCTYPE html><html lang="ko"><head><style>body{color:red;}</style></head>',
            },
          ],
          finalAnswerText:
            '<body><section>hello</section></body></html>\n<!-- /GEULBAT_ARTIFACT -->',
        },
        runState: {
          isRunning: true,
        },
      })}
    />,
  );

  assert.match(html, /assistant/);
  assert.doesNotMatch(html, /<iframe/);
  assert.match(
    html,
    /&lt;body&gt;&lt;section&gt;hello&lt;\/section&gt;&lt;\/body&gt;&lt;\/html&gt;/,
  );
});

void test('assistant renders structured run transcript entries without relying on string markers', () => {
  const html = renderToStaticMarkup(
    <Assistant
      {...createAssistantProps({
        conversation: {
          transcriptEntries: [
            { kind: 'assistant_text', text: 'Thinking...' },
            { kind: 'tool_activity', tool: 'write_file', state: 'running' },
            {
              kind: 'approval_request',
              pendingApproval: makeApprovalRequiredFixture({
                argumentsPreview: {
                  path: 'hello.txt',
                  content: 'Hello',
                },
              }),
            },
          ],
        },
        runState: {
          isRunning: true,
        },
      })}
    />,
  );

  assert.match(html, /Thinking/);
  assert.match(html, /write_file/);
  assert.match(html, /실행 중/);
  assert.match(html, /승인 요청 · 파일 쓰기/u);
  assert.match(html, /hello\.txt/u);
  assert.doesNotMatch(html, /\[tool_call:/);
});

void test('assistant keeps transcript content visible when a stream error is also present', () => {
  const html = renderToStaticMarkup(
    <Assistant
      {...createAssistantProps({
        conversation: {
          transcriptEntries: [{ kind: 'assistant_text', text: 'Still here' }],
        },
        runState: {
          streamError: '[internal] socket down',
        },
      })}
    />,
  );

  assert.match(html, /Still here/);
  assert.match(html, /\[internal\] socket down/);
});

void test('assistant shows a live run status row while a run is active', () => {
  const runningHtml = renderToStaticMarkup(
    <Assistant
      {...createAssistantProps({
        conversation: {
          transcriptEntries: [
            { kind: 'tool_activity', tool: 'read_file', state: 'running' },
          ],
        },
        runState: {
          isRunning: true,
        },
      })}
    />,
  );

  assert.equal(
    runningHtml.match(/<div class="run-status-row/g)?.length ?? 0,
    1,
  );
  assert.match(runningHtml, /read_file 실행 중/);

  const idleHtml = renderToStaticMarkup(
    <Assistant {...createAssistantProps({})} />,
  );
  assert.doesNotMatch(idleHtml, /run-status-row/);
});

void test('assistant sends queued attachments with a fallback prompt and clears them on success', async () => {
  const sent: Array<{
    prompt: string;
    attachments: RunAttachmentInput[] | undefined;
  }> = [];
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(
      <Assistant
        {...createAssistantProps({
          runActions: {
            onSend: async (prompt, attachments) => {
              sent.push({ prompt, attachments });
            },
          },
          attachments: {
            onUploadFiles: async () => [
              {
                name: 'note.txt',
                contentRef: 'binary-input://ref-1',
                mimeType: 'text/plain',
              },
            ],
          },
        })}
      />,
    );
  });

  // 컴포저 경계로 업로드를 구동한다 — Assistant의 uploadFiles가 첨부 큐에 넣는다.
  const uploadedFile = new File([], 'note.txt', { type: 'text/plain' });
  const uploadedFiles: FileList = {
    0: uploadedFile,
    length: 1,
    item: (index: number) => (index === 0 ? uploadedFile : null),
    [Symbol.iterator]: () => [uploadedFile][Symbol.iterator](),
  };
  await act(async () => {
    await renderer.root
      .findByType(AssistantComposer)
      .props.onUploadFiles(uploadedFiles);
  });
  assert.equal(
    renderer.root.findByType(AssistantComposer).props.attachments.length,
    1,
  );

  // 본문 없이 전송해도 첨부만 있으면 fallback 프롬프트로 나가고, 성공 후 큐가
  // 비워진다. handleSend를 훅으로 걷어낸 뒤에도 이 계약이 유지되는지 못박는다.
  await act(async () => {
    await renderer.root.findByType(AssistantComposer).props.onSend('');
  });

  assert.deepEqual(sent, [
    {
      prompt: '첨부한 파일을 확인해 주세요.',
      attachments: [
        {
          name: 'note.txt',
          contentRef: 'binary-input://ref-1',
          mimeType: 'text/plain',
        },
      ],
    },
  ]);
  assert.equal(
    renderer.root.findByType(AssistantComposer).props.attachments.length,
    0,
  );

  await act(async () => renderer.unmount());
});
