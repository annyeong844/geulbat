import test from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import TestRenderer, {
  act,
  type ReactTestInstance,
  type ReactTestRenderer,
} from 'react-test-renderer';

import { Assistant } from './Assistant.js';
import {
  createCommittedArtifact,
  createCommittedArtifactMessage,
} from '../../test-support/thread-artifact-fixtures.js';
import { makeApprovalRequiredFixture } from '../../test-support/protocol-fixtures.js';
import { brandRunId } from '../../lib/id-brand-helpers.js';

(
  globalThis as typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
  }
).IS_REACT_ACT_ENVIRONMENT = true;

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

void test('cross-provider model selection waits for confirmation and successful compaction', async () => {
  const prepared: string[] = [];
  const selected: string[] = [];
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(
      <Assistant
        messages={[PROVIDER_TRANSITION_MESSAGE]}
        backgroundNotifications={[]}
        transcriptEntries={[]}
        finalAnswerText=""
        streamError={null}
        isRunning={false}
        modelId="grok-4.5"
        reasoningEffort="high"
        onModelIdChange={(modelId) => selected.push(modelId)}
        onPrepareProviderTransition={async (modelId) => {
          prepared.push(modelId);
        }}
        onSend={() => {}}
        onStartArtifactRun={() => {}}
        onCancel={() => {}}
      />,
    );
  });

  const openModelMenu = async () => {
    const toggle = renderer.root.findByProps({ title: '모델과 사고 강도' });
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
  assert.deepEqual(prepared, []);
  assert.deepEqual(selected, []);
  assert.ok(renderer.root.findByProps({ role: 'alertdialog' }));

  const cancel = findButtonByText(renderer, '전환 취소');
  assert.ok(cancel);
  await act(async () => {
    cancel.props.onClick();
  });
  assert.equal(renderer.root.findAllByProps({ role: 'alertdialog' }).length, 0);
  assert.deepEqual(selected, []);

  await openModelMenu();
  await chooseGpt();
  const confirm = findButtonByText(renderer, '문맥 압축 후 전환');
  assert.ok(confirm);
  await act(async () => {
    await confirm.props.onClick();
  });

  assert.deepEqual(prepared, ['gpt-5.6-sol']);
  assert.deepEqual(selected, ['gpt-5.6-sol']);
  assert.equal(renderer.root.findAllByProps({ role: 'alertdialog' }).length, 0);
  await act(async () => renderer.unmount());
});

void test('failed provider preparation keeps the current model and dialog open', async () => {
  const selected: string[] = [];
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(
      <Assistant
        messages={[PROVIDER_TRANSITION_MESSAGE]}
        backgroundNotifications={[]}
        transcriptEntries={[]}
        finalAnswerText=""
        streamError={null}
        isRunning={false}
        modelId="grok-4.5"
        reasoningEffort="high"
        onModelIdChange={(modelId) => selected.push(modelId)}
        onPrepareProviderTransition={async () => {
          throw new Error('문맥이 바뀌어 전환하지 않았어요.');
        }}
        onSend={() => {}}
        onStartArtifactRun={() => {}}
        onCancel={() => {}}
      />,
    );
  });

  const toggle = renderer.root.findByProps({ title: '모델과 사고 강도' });
  await act(async () => {
    toggle.findByType('button').props.onClick({ stopPropagation() {} });
  });
  const row = findButtonByText(renderer, 'GPT-5.6 Sol');
  assert.ok(row);
  await act(async () => row.props.onClick());
  const confirm = findButtonByText(renderer, '문맥 압축 후 전환');
  assert.ok(confirm);
  await act(async () => {
    await confirm.props.onClick();
  });

  assert.deepEqual(selected, []);
  assert.ok(renderer.root.findByProps({ role: 'alertdialog' }));
  assert.match(renderedText(renderer.root), /문맥이 바뀌어 전환하지 않았어요/u);
  await act(async () => renderer.unmount());
});

void test('background notifications render after transcript content so auto-scroll keeps them visible', () => {
  const html = renderToStaticMarkup(
    <Assistant
      messages={[
        {
          entryId: 'entry-user',
          role: 'user',
          content: 'prompt',
          timestamp: '2026-03-24T00:00:00.000Z',
        },
        {
          entryId: 'entry-assistant',
          role: 'assistant',
          content: 'answer',
          timestamp: '2026-03-24T00:00:01.000Z',
        },
      ]}
      backgroundNotifications={[
        {
          kind: 'subagent_activity',
          childRunId: 'run-child-1',
          subagentType: 'explorer',
          state: 'completed',
        },
      ]}
      transcriptEntries={[]}
      finalAnswerText=""
      streamError={null}
      isRunning={false}
      onSend={() => {}}
      onStartArtifactRun={() => {}}
      onCancel={() => {}}
    />,
  );

  assert.match(html, /explorer 작업 완료/);
  assert.ok(
    html.indexOf('answer') < html.indexOf('explorer 작업 완료'),
    'background completion notice should render after prior transcript blocks',
  );
});

void test('assistant transcript exposes a polite live region for streamed updates', () => {
  const html = renderToStaticMarkup(
    <Assistant
      messages={[]}
      backgroundNotifications={[]}
      transcriptEntries={[{ kind: 'assistant_text', text: 'Thinking...' }]}
      finalAnswerText=""
      streamError={null}
      isRunning={true}
      onSend={() => {}}
      onStartArtifactRun={() => {}}
      onCancel={() => {}}
    />,
  );

  assert.match(html, /role="log"/);
  assert.match(html, /aria-label="Assistant transcript"/);
  assert.match(html, /aria-live="polite"/);
  assert.match(html, /aria-relevant="additions text"/);
  assert.match(html, /aria-atomic="false"/);
  assert.match(html, /aria-busy="true"/);
});

void test('assistant keeps child session drill-down available in the single Home shell', () => {
  const html = renderToStaticMarkup(
    <Assistant
      messages={[]}
      backgroundNotifications={[]}
      transcriptEntries={[
        {
          kind: 'subagent_activity',
          childRunId: 'child-run-1',
          childThreadId: '00000000-0000-4000-8000-000000000777',
          subagentType: 'explorer',
          state: 'completed',
        },
      ]}
      finalAnswerText=""
      streamError={null}
      isRunning={false}
      onSend={() => {}}
      onStartArtifactRun={() => {}}
      onCancel={() => {}}
    />,
  );

  assert.match(html, /트랜스크립트 보기/);
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
      messages={settledMessages}
      backgroundNotifications={[]}
      transcriptEntries={[]}
      finalAnswerText=""
      streamError={null}
      isRunning={false}
      onSend={() => {}}
      onStartArtifactRun={() => {}}
      onCancel={() => {}}
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
      messages={settledMessages}
      backgroundNotifications={[]}
      transcriptEntries={[]}
      finalAnswerText=""
      streamError={null}
      isRunning={true}
      onSend={() => {}}
      onStartArtifactRun={() => {}}
      onCancel={() => {}}
    />,
  );
  assert.doesNotMatch(runningHtml, /답변 다시 시도/);

  // 마지막 메시지가 사용자 질문이고 에러도 없으면 재시도 대상이 없다
  const pendingHtml = renderToStaticMarkup(
    <Assistant
      messages={settledMessages.slice(0, 1)}
      backgroundNotifications={[]}
      transcriptEntries={[]}
      finalAnswerText=""
      streamError={null}
      isRunning={false}
      onSend={() => {}}
      onStartArtifactRun={() => {}}
      onCancel={() => {}}
    />,
  );
  assert.doesNotMatch(pendingHtml, /답변 다시 시도/);
});

void test('assistant offers retry when the run failed with a stream error', () => {
  const html = renderToStaticMarkup(
    <Assistant
      messages={[
        {
          entryId: 'entry-user-1',
          role: 'user' as const,
          content: '요약해줘',
          timestamp: '2026-07-11T00:00:00.000Z',
        },
      ]}
      backgroundNotifications={[]}
      transcriptEntries={[]}
      finalAnswerText=""
      streamError="[internal] provider request failed"
      isRunning={false}
      onSend={() => {}}
      onStartArtifactRun={() => {}}
      onCancel={() => {}}
    />,
  );
  assert.match(html, /답변 다시 시도/);
});

void test('assistant composer renders the selected current model', () => {
  const html = renderToStaticMarkup(
    <Assistant
      messages={[]}
      backgroundNotifications={[]}
      transcriptEntries={[]}
      finalAnswerText=""
      streamError={null}
      isRunning={false}
      modelId="grok-4.5"
      reasoningEffort="high"
      onSend={() => {}}
      onStartArtifactRun={() => {}}
      onCancel={() => {}}
    />,
  );

  assert.match(html, /Grok 4\.5 높음 ∨/);
});

void test('assistant requests the native folder picker when the user chooses the start location', async () => {
  let chooseCount = 0;
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(
      <Assistant
        messages={[]}
        backgroundNotifications={[]}
        transcriptEntries={[]}
        finalAnswerText=""
        streamError={null}
        isRunning={false}
        workingDirectory="home/user"
        browseStartPath="home/user"
        onChooseWorkingDirectory={async () => {
          chooseCount += 1;
        }}
        onSend={() => {}}
        onStartArtifactRun={() => {}}
        onCancel={() => {}}
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
        messages={[]}
        backgroundNotifications={[]}
        transcriptEntries={[]}
        finalAnswerText=""
        streamError={null}
        isRunning={false}
        workingDirectory="home/user"
        browseStartPath="home/user"
        onChooseWorkingDirectory={() => {
          chooseCount += 1;
          return selection;
        }}
        onSend={() => {}}
        onStartArtifactRun={() => {}}
        onCancel={() => {}}
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
        messages={[]}
        backgroundNotifications={[]}
        transcriptEntries={[]}
        finalAnswerText=""
        streamError={null}
        isRunning={false}
        workingDirectory="home/user"
        browseStartPath="home/user"
        onChooseWorkingDirectory={async () => {
          throw new Error('native dialog unavailable');
        }}
        onSend={() => {}}
        onStartArtifactRun={() => {}}
        onCancel={() => {}}
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
      messages={[]}
      backgroundNotifications={[]}
      transcriptEntries={[]}
      finalAnswerText=""
      streamError={null}
      isRunning={false}
      modelId="grok-4.5"
      reasoningEffort="high"
      subagentModelRouting={{
        mode: 'fixed',
        choice: { modelId: 'gpt-5.6-luna', reasoningEffort: 'xhigh' },
      }}
      onSend={() => {}}
      onStartArtifactRun={() => {}}
      onCancel={() => {}}
    />,
  );

  // 고정 라우팅은 통합 피커 안(서브패널)으로 들어갔다 — 트리거 라벨은
  // 루트 모델만 보여주고, 고정 상태는 메뉴를 열어야 보인다.
  assert.match(html, /Grok 4\.5 높음 ∨/);
});

void test('assistant keeps legacy transcript envelope content as plain text without preview controls', () => {
  const html = renderToStaticMarkup(
    <Assistant
      messages={[
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
      ]}
      backgroundNotifications={[]}
      transcriptEntries={[]}
      finalAnswerText=""
      streamError={null}
      isRunning={false}
      onSend={() => {}}
      onStartArtifactRun={() => {}}
      onCancel={() => {}}
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
      messages={[createCommittedArtifactMessage(artifact)]}
      artifacts={[artifact]}
      backgroundNotifications={[]}
      transcriptEntries={[]}
      finalAnswerText=""
      streamError={null}
      isRunning={false}
      onSend={() => {}}
      onStartArtifactRun={() => {}}
      onCancel={() => {}}
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
      messages={[
        createCommittedArtifactMessage(artifact, {
          content: 'Here is the normalized artifact.',
        }),
      ]}
      artifacts={[artifact]}
      backgroundNotifications={[]}
      transcriptEntries={[]}
      finalAnswerText=""
      streamError={null}
      isRunning={false}
      onSend={() => {}}
      onStartArtifactRun={() => {}}
      onCancel={() => {}}
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
      messages={[]}
      artifacts={[]}
      activeArtifact={artifact}
      backgroundNotifications={[]}
      transcriptEntries={[]}
      finalAnswerText="Here is the live answer."
      streamError={null}
      isRunning={true}
      onSend={() => {}}
      onStartArtifactRun={() => {}}
      onCancel={() => {}}
    />,
  );

  assert.match(html, /Here is the live answer\./);
  assert.match(html, /live title/);
});

void test('assistant treats live finalAnswerText as plain transcript text instead of parsing a streaming artifact preview', () => {
  const html = renderToStaticMarkup(
    <Assistant
      messages={[]}
      backgroundNotifications={[]}
      transcriptEntries={[]}
      finalAnswerText={
        '<!-- GEULBAT_ARTIFACT {"renderer":"html5","digest":"romance-fantasy-character-map-v2"} -->\n<!DOCTYPE html><html lang="ko"><body><section>hello</section></body></html>\n<!-- /GEULBAT_ARTIFACT -->'
      }
      streamError={null}
      isRunning={true}
      onSend={() => {}}
      onStartArtifactRun={() => {}}
      onCancel={() => {}}
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
      messages={[]}
      backgroundNotifications={[]}
      transcriptEntries={[]}
      finalAnswerText={
        '<!-- GEULBAT_ARTIFACT {"renderer":"html5","digest":"creative-html-v1"} -->\n* { box-sizing: border-box; }\nhtml, body { margin: 0; }\nbody { min-height: 100vh; }'
      }
      streamError={null}
      isRunning={true}
      onSend={() => {}}
      onStartArtifactRun={() => {}}
      onCancel={() => {}}
    />,
  );

  assert.doesNotMatch(html, /<iframe/);
  assert.match(html, /\* \{ box-sizing/);
});

void test('assistant does not reconstruct artifacts from commentary plus final answer fragments', () => {
  const html = renderToStaticMarkup(
    <Assistant
      messages={[]}
      backgroundNotifications={[]}
      transcriptEntries={[
        {
          kind: 'assistant_text',
          text: '<!-- GEULBAT_ARTIFACT {"renderer":"html5","digest":"romance-fantasy-character-map-v2"} -->\n<!DOCTYPE html><html lang="ko"><head><style>body{color:red;}</style></head>',
        },
      ]}
      finalAnswerText={
        '<body><section>hello</section></body></html>\n<!-- /GEULBAT_ARTIFACT -->'
      }
      streamError={null}
      isRunning={true}
      onSend={() => {}}
      onStartArtifactRun={() => {}}
      onCancel={() => {}}
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
      messages={[]}
      backgroundNotifications={[]}
      transcriptEntries={[
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
      ]}
      finalAnswerText=""
      streamError={null}
      isRunning
      onSend={() => {}}
      onStartArtifactRun={() => {}}
      onCancel={() => {}}
    />,
  );

  assert.match(html, /Thinking/);
  assert.match(html, /write_file/);
  assert.match(html, /실행 중/);
  assert.match(html, /Write hello.txt/);
  assert.doesNotMatch(html, /\[tool_call:/);
});

void test('assistant keeps transcript content visible when a stream error is also present', () => {
  const html = renderToStaticMarkup(
    <Assistant
      messages={[]}
      backgroundNotifications={[]}
      transcriptEntries={[{ kind: 'assistant_text', text: 'Still here' }]}
      finalAnswerText=""
      streamError="[internal] socket down"
      isRunning={false}
      onSend={() => {}}
      onStartArtifactRun={() => {}}
      onCancel={() => {}}
    />,
  );

  assert.match(html, /Still here/);
  assert.match(html, /\[internal\] socket down/);
});

void test('assistant shows a live run status row while a run is active', () => {
  const runningHtml = renderToStaticMarkup(
    <Assistant
      messages={[]}
      backgroundNotifications={[]}
      transcriptEntries={[
        { kind: 'tool_activity', tool: 'read_file', state: 'running' },
      ]}
      finalAnswerText=""
      streamError={null}
      isRunning
      onSend={() => {}}
      onStartArtifactRun={() => {}}
      onCancel={() => {}}
    />,
  );

  assert.equal(runningHtml.match(/run-status-row/g)?.length ?? 0, 1);
  assert.match(runningHtml, /read_file 실행 중/);

  const idleHtml = renderToStaticMarkup(
    <Assistant
      messages={[]}
      backgroundNotifications={[]}
      transcriptEntries={[]}
      finalAnswerText=""
      streamError={null}
      isRunning={false}
      onSend={() => {}}
      onStartArtifactRun={() => {}}
      onCancel={() => {}}
    />,
  );
  assert.doesNotMatch(idleHtml, /run-status-row/);
});
