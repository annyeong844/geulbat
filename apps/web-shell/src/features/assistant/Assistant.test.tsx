import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import TestRenderer, { act, type ReactTestRenderer } from 'react-test-renderer';
import type {
  PrepareProviderTransitionRequest,
  ThreadMessage,
} from '@geulbat/protocol/threads';
import type { RunAttachmentInput } from '@geulbat/protocol/run-contract';

import { Assistant, type AssistantComposerControls } from './Assistant.js';
import { AssistantComposer } from './AssistantComposer.js';
import { PlanningWorkflowCard } from './run-plan/planning-workflow-card.js';
import { makeApprovalRequiredFixture } from '../../test-support/protocol-fixtures.js';
import { createAssistantProps } from '../../test-support/create-assistant-props.js';
import {
  findButtonByText,
  renderedText,
} from '../../test-support/react-test-queries.js';
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
              // quiet는 그림 없이도 바로 승인한다
              snapshot: {
                ...awaitingPlanningSnapshot(threadId),
                intensity: 'quiet',
              },
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

void test('visual approval waits for a diagram and auto-requests explain_visual', async () => {
  const commands: PlanWorkflowCommand[] = [];
  const threadId = assertThreadId('123e4567-e89b-42d3-a456-426614174041');
  const snapshot = awaitingPlanningSnapshot(threadId);
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(
      <PlanningWorkflowCard
        workflow={{
          busy: false,
          snapshot,
          async onCommand(command) {
            commands.push(command);
          },
        }}
      />,
    );
  });
  await act(async () => {
    await Promise.resolve();
  });

  assert.deepEqual(commands, [
    {
      kind: 'explain_visual',
      threadId,
      workflowId: snapshot.workflowId,
      planId: snapshot.planId,
      revision: snapshot.revision,
      digest: snapshot.digest,
    },
  ]);
  const approve = findButtonByText(renderer, '이 계획 승인');
  assert.ok(approve);
  assert.equal(approve.props.disabled, true);
  assert.match(renderedText(renderer.root), /그림 준비/u);
  await act(async () => renderer.unmount());
});

void test('visual approval keeps feedback, revision, and cancel usable while the diagram is rendering', async () => {
  const threadId = assertThreadId('123e4567-e89b-42d3-a456-426614174043');
  const snapshot = awaitingPlanningSnapshot(threadId);
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(
      <PlanningWorkflowCard
        workflow={{
          busy: true,
          snapshot,
          async onCommand() {},
        }}
      />,
    );
  });

  const approve = findButtonByText(renderer, '이 계획 승인');
  const revise = findButtonByText(renderer, '수정 요청');
  const cancel = findButtonByText(renderer, '취소');
  assert.ok(approve);
  assert.ok(revise);
  assert.ok(cancel);
  assert.equal(approve.props.disabled, true);
  assert.equal(revise.props.disabled, false);
  assert.equal(cancel.props.disabled, false);
  assert.equal(
    renderer.root.findByProps({
      placeholder: '바꿔야 할 점을 적어주세요.',
    }).props.disabled,
    false,
  );
  assert.match(
    renderedText(renderer.root),
    /계획을 검토·수정·취소할 수 있습니다/u,
  );

  await act(async () => renderer.unmount());
});

void test('visual approval enables only after the matching diagram is present', async () => {
  const commands: PlanWorkflowCommand[] = [];
  const threadId = assertThreadId('123e4567-e89b-42d3-a456-426614174042');
  const snapshot = awaitingPlanningSnapshot(threadId);
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(
      <PlanningWorkflowCard
        workflow={{
          busy: false,
          snapshot,
          async onCommand(command) {
            commands.push(command);
          },
        }}
        visualization={{
          mode: 'svg',
          title: '승인할 계획 그림',
          code: '<svg role="img" aria-label="승인할 계획"></svg>',
          planStamp: {
            workflowId: snapshot.workflowId,
            planId: snapshot.planId,
            revision: snapshot.revision,
            digest: snapshot.digest,
          },
        }}
      />,
    );
  });

  // 이미 그림이 있으면 auto explain_visual 을 보내지 않는다.
  assert.deepEqual(commands, []);
  const approve = findButtonByText(renderer, '이 계획 승인');
  assert.ok(approve);
  assert.equal(approve.props.disabled, false);
  await act(async () => {
    approve.props.onClick();
    await Promise.resolve();
  });
  assert.deepEqual(commands, [
    {
      kind: 'approve',
      threadId,
      workflowId: snapshot.workflowId,
      planId: snapshot.planId,
      revision: snapshot.revision,
      digest: snapshot.digest,
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
  assert.ok(findButtonByText(renderer, '크게 보기'));
  await act(async () => renderer.unmount());
});

void test('planning approval leads with the user goal and demotes file paths to metadata', async () => {
  const threadId = assertThreadId('123e4567-e89b-42d3-a456-426614174044');
  const snapshot = awaitingPlanningSnapshot(threadId);
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(
      <PlanningWorkflowCard
        workflow={{
          busy: false,
          snapshot: {
            ...snapshot,
            intensity: 'quiet',
            draft: {
              ...snapshot.draft,
              outcome:
                'planning-workflow-card.tsx 한 파일의 승인 카드 경험을 개선한다.',
              steps: [
                {
                  id: 'card-goal',
                  text: '사용자 목표를 제목에 먼저 표시한다.',
                  acceptanceCriteria: [
                    'apps/web-shell/src/features/assistant/run-plan/planning-workflow-card.tsx는 관련 파일 메타로만 보인다.',
                  ],
                },
              ],
            },
          },
          async onCommand() {},
        }}
      />,
    );
  });

  const title = renderer.root.findByProps({
    className: 'planning-workflow-card-title',
  });
  assert.equal(renderedText(title), '승인 카드 경험을 개선한다.');
  const targets = renderer.root.findByProps({ 'aria-label': '관련 파일' });
  assert.match(renderedText(targets), /관련 파일/u);
  assert.match(renderedText(targets), /planning-workflow-card\.tsx/u);
  assert.equal(
    targets.findAllByType('code').length,
    1,
    'the basename and full path should collapse to one metadata item',
  );
  await act(async () => renderer.unmount());
});

void test('a visual plan opens a large dialog from its compact card preview', async () => {
  const threadId = assertThreadId('123e4567-e89b-42d3-a456-426614174045');
  const snapshot = awaitingPlanningSnapshot(threadId);
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(
      <PlanningWorkflowCard
        workflow={{
          busy: false,
          snapshot,
          async onCommand() {},
        }}
        visualization={{
          mode: 'svg',
          title: '승인 흐름',
          code: '<svg role="img" aria-label="승인 흐름"></svg>',
          planStamp: {
            workflowId: snapshot.workflowId,
            planId: snapshot.planId,
            revision: snapshot.revision,
            digest: snapshot.digest,
          },
        }}
      />,
    );
  });

  const open = findButtonByText(renderer, '크게 보기');
  assert.ok(open);
  await act(async () => open.props.onClick());
  const dialog = renderer.root.findByProps({ role: 'dialog' });
  assert.equal(dialog.props['aria-modal'], 'true');
  assert.match(renderedText(dialog), /승인 카드로 자동 인계/u);

  const close = renderer.root.findByProps({
    'aria-label': '계획 그림 크게 보기 닫기 (Esc)',
  });
  await act(async () => close.props.onClick());
  assert.equal(
    renderer.root.findAll((node) => node.props.role === 'dialog').length,
    0,
  );
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

void test('a completed plan record stays dismissed for the unchanged terminal snapshot', async () => {
  const threadId = assertThreadId('123e4567-e89b-42d3-a456-426614174034');
  const props = createAssistantProps({
    conversation: { threadId },
    workflow: {
      planningWorkflow: {
        busy: false,
        snapshot: {
          ...awaitingPlanningSnapshot(threadId),
          state: 'completed',
          executionRunId: assertRunId('run-completed-plan-record'),
        },
        async onCommand() {},
      },
    },
  });
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(<Assistant {...props} />);
  });

  const dismiss = renderer.root.findByProps({
    'aria-label': '실행 완료 기록 치우기',
  });
  await act(async () => dismiss.props.onClick());
  assert.equal(
    renderer.root.findAllByProps({ className: 'planning-workflow-card' })
      .length,
    0,
  );

  await act(async () => renderer.update(<Assistant {...props} />));
  assert.equal(
    renderer.root.findAllByProps({ className: 'planning-workflow-card' })
      .length,
    0,
  );
  await act(async () => renderer.unmount());
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

void test('assistant renders one clickable pending steer and disables repeat flush after acknowledgement', async () => {
  let flushCount = 0;
  const steering = {
    pendingSteers: [{ receivedSeq: 7, text: 'CSS부터요' }],
    pendingSteerFlushRequested: false,
    onCancelSteer: () => {},
    onFlushSteers: () => {
      flushCount += 1;
    },
  };
  const props = createAssistantProps({
    conversation: {
      transcriptEntries: [
        {
          kind: 'user_text',
          text: 'CSS부터요',
          pendingSteerSeq: 7,
        },
      ],
    },
    runState: {
      isRunning: true,
    },
    steering,
  });
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(<Assistant {...props} />);
  });

  assert.equal(renderedText(renderer.root).match(/CSS부터요/gu)?.length, 1);
  assert.equal(
    renderer.root.findAllByProps({ className: 'pending-steer-list' }).length,
    0,
  );
  const pendingBubble = renderer.root.findByProps({
    className: 'pending-steer-message is-flushable',
  });
  act(() => {
    pendingBubble.props.onClick();
  });
  assert.equal(flushCount, 1);

  await act(async () => {
    renderer.update(
      <Assistant
        {...props}
        steering={{
          ...steering,
          pendingSteerFlushRequested: true,
        }}
      />,
    );
  });
  const acknowledgedBubble = renderer.root.findByProps({
    className: 'pending-steer-message',
  });
  assert.equal(acknowledgedBubble.props.onClick, undefined);

  await act(async () => renderer.unmount());
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
