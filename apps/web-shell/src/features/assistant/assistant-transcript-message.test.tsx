import test from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import TestRenderer, { act, type ReactTestRenderer } from 'react-test-renderer';
import type { ThreadArtifactVersion } from '@geulbat/protocol/artifacts';
import { assertRunId } from '@geulbat/protocol/ids';
import type {
  PlanningWorkflowSnapshot,
  PlanRenderingStamp,
} from '@geulbat/protocol/planning-workflow';
import type { ThreadMessage } from '@geulbat/protocol/threads';

import { createArtifactsByRefMap } from '../artifacts/artifact-transcript-lookup.js';
import { brandThreadId } from '../../lib/id-brand-helpers.js';
import { TranscriptMessage } from './assistant-transcript-message.js';
import { VisualizeWidget } from './visualize/visualize-widget.js';

(
  globalThis as typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
  }
).IS_REACT_ACT_ENVIRONMENT = true;

void test('TranscriptMessage preserves assistant prose beside a committed artifact ref', () => {
  const artifact = createThreadArtifactVersion({
    artifactId: 'art_transcript_1',
    version: 1,
    payload: '# committed artifact',
  });

  const markup = renderToStaticMarkup(
    <TranscriptMessage
      message={createAssistantMessage({
        content: 'Here is the artifact.',
        artifact,
      })}
      artifactsByRef={createArtifactsByRefMap([artifact])}
      isRunning={false}
    />,
  );

  assert.match(markup, /Here is the artifact\./);
  assert.match(markup, /committed artifact/);
});

void test('TranscriptMessage keeps artifact-looking raw text plain without metadata refs', () => {
  const artifact = createThreadArtifactVersion({
    artifactId: 'art_ghost',
    version: 1,
    payload: '# should not render',
  });

  const markup = renderToStaticMarkup(
    <TranscriptMessage
      message={{
        entryId: 'entry-raw-artifact-text',
        role: 'assistant',
        content: '{"artifactId":"art_ghost","version":1}',
        timestamp: '2026-04-29T00:00:00.000Z',
        metadata: { phase: 'final_answer' },
      }}
      artifactsByRef={createArtifactsByRefMap([artifact])}
      isRunning={false}
    />,
  );

  assert.match(markup, /artifactId/);
  assert.doesNotMatch(markup, /should not render/);
});

void test('TranscriptMessage marks stamped final specs as current or superseded', () => {
  const planStamp = {
    workflowId: 'workflow-1',
    planId: 'plan-1',
    revision: 1,
    digest: `sha256:${'a'.repeat(64)}`,
  } as const;
  const message: ThreadMessage = {
    entryId: 'entry-stamped-spec',
    role: 'assistant',
    content: '승인할 최종 명세입니다.',
    timestamp: '2026-07-26T00:00:00.000Z',
    metadata: { phase: 'final_answer', planStamp },
  };
  const snapshot = createPlanningSnapshot(planStamp);

  const current = renderToStaticMarkup(
    <TranscriptMessage
      message={message}
      artifactsByRef={createArtifactsByRefMap([])}
      planningWorkflowSnapshot={snapshot}
      isRunning={false}
    />,
  );
  const superseded = renderToStaticMarkup(
    <TranscriptMessage
      message={message}
      artifactsByRef={createArtifactsByRefMap([])}
      planningWorkflowSnapshot={{
        ...snapshot,
        revision: 2,
        digest: `sha256:${'b'.repeat(64)}`,
      }}
      isRunning={false}
    />,
  );

  assert.match(current, /현재 계획 · r1/);
  assert.match(superseded, /이전 계획 · r1/);
});

void test('VisualizeWidget marks a rendering from an older plan revision as superseded', async () => {
  const planStamp = {
    workflowId: 'workflow-visualize',
    planId: 'plan-visualize',
    revision: 1,
    digest: `sha256:${'c'.repeat(64)}`,
  } as const;
  const view = {
    mode: 'svg' as const,
    code: '<svg xmlns="http://www.w3.org/2000/svg"><text>Plan</text></svg>',
    title: 'Stamped plan visualization',
    planStamp,
  };
  let renderer!: ReactTestRenderer;

  await act(async () => {
    renderer = TestRenderer.create(
      <VisualizeWidget
        view={view}
        planningWorkflowSnapshot={createPlanningSnapshot({
          ...planStamp,
          revision: 2,
          digest: `sha256:${'d'.repeat(64)}`,
        })}
        playback="instant"
      />,
    );
  });

  const label = renderer.root.findByProps({
    className: 'plan-rendering-stamp',
  });
  assert.deepEqual(label.children, ['이전 계획 · r1']);

  await act(async () => {
    renderer.unmount();
  });
});

void test('TranscriptMessage replays settled visualize calls instantly and can defer runtime boot', async () => {
  const view = {
    mode: 'html' as const,
    code: '<section><h2>Settled visualization</h2><p>Ready.</p></section>',
    title: 'Settled visualization',
  };
  let historyRenderer!: ReactTestRenderer;
  let instantRenderer!: ReactTestRenderer;
  let replayRenderer!: ReactTestRenderer;
  let deferredRenderer!: ReactTestRenderer;
  await act(async () => {
    historyRenderer = TestRenderer.create(
      <TranscriptMessage
        message={{
          entryId: 'entry-settled-visualize',
          role: 'tool_call',
          content: JSON.stringify({ tool: 'visualize', args: view }),
          timestamp: '2026-07-19T00:00:00.000Z',
        }}
        artifactsByRef={createArtifactsByRefMap([])}
        isRunning={false}
      />,
    );
    instantRenderer = TestRenderer.create(
      <VisualizeWidget view={view} playback="instant" />,
    );
    replayRenderer = TestRenderer.create(<VisualizeWidget view={view} />);
    deferredRenderer = TestRenderer.create(
      <TranscriptMessage
        message={{
          entryId: 'entry-deferred-visualize',
          role: 'tool_call',
          content: JSON.stringify({ tool: 'visualize', args: view }),
          timestamp: '2026-07-19T00:00:00.000Z',
        }}
        artifactsByRef={createArtifactsByRefMap([])}
        isRunning={false}
        deferVisualizeRuntimeBoot
      />,
    );
  });

  const historyFrame = historyRenderer.root.findByType('iframe');
  const instantFrame = instantRenderer.root.findByType('iframe');
  const replayFrame = replayRenderer.root.findByType('iframe');
  assert.equal(historyFrame.props.src, instantFrame.props.src);
  assert.notEqual(historyFrame.props.src, replayFrame.props.src);
  assert.equal(
    deferredRenderer.root.findAllByProps({ className: 'visualize-widget' })
      .length,
    1,
  );
  assert.equal(deferredRenderer.root.findAllByType('iframe').length, 0);

  await act(async () => {
    historyRenderer.unmount();
    instantRenderer.unmount();
    replayRenderer.unmount();
    deferredRenderer.unmount();
  });
});

void test('VisualizeWidget keeps its iframe mounted after deferred boot becomes active again', async () => {
  const view = {
    mode: 'html' as const,
    code: '<section>Stable visualization</section>',
    title: 'Stable visualization',
  };
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(
      <VisualizeWidget view={view} deferRuntimeBoot />,
    );
  });
  assert.equal(renderer.root.findAllByType('iframe').length, 0);

  await act(async () => {
    renderer.update(<VisualizeWidget view={view} />);
  });
  const mountedFrame = renderer.root.findByType('iframe');

  await act(async () => {
    renderer.update(<VisualizeWidget view={view} deferRuntimeBoot />);
  });
  assert.equal(renderer.root.findByType('iframe'), mountedFrame);

  await act(async () => {
    renderer.unmount();
  });
});

function createAssistantMessage(args: {
  content: string;
  artifact: Pick<ThreadArtifactVersion, 'artifactId' | 'version'>;
}): ThreadMessage {
  const { content, artifact } = args;
  return {
    entryId: `entry-${artifact.artifactId}-${artifact.version}`,
    role: 'assistant',
    content,
    timestamp: '2026-04-29T00:00:00.000Z',
    metadata: {
      phase: 'final_answer',
      artifactRefs: [
        { artifactId: artifact.artifactId, version: artifact.version },
      ],
      activeArtifactRef: {
        artifactId: artifact.artifactId,
        version: artifact.version,
      },
    },
  };
}

function createThreadArtifactVersion(args: {
  artifactId: string;
  version: number;
  payload: string;
}): ThreadArtifactVersion {
  return {
    artifactId: args.artifactId,
    version: args.version,
    parentVersion: null,
    baseVersion: null,
    renderer: 'markdown',
    payload: args.payload,
    digest: `digest-${args.artifactId}`,
    contentHash: `hash-${args.artifactId}`,
    createdAt: '2026-04-29T00:00:00.000Z',
    createdByRunId: 'run-1',
    previewValidation: { ok: true },
    title: null,
    persistenceEpoch: 0,
    sourceRef: {
      kind: 'thread-file',
      workingDirectory: 'computer-root',
      threadId: brandThreadId('00000000-0000-4000-8000-000000000001'),
      runId: 'run-1',
      filePath: 'notes/demo.md',
      messageTimestamp: '2026-04-29T00:00:00.000Z',
    },
  };
}

function createPlanningSnapshot(
  planStamp: PlanRenderingStamp,
): Extract<PlanningWorkflowSnapshot, { state: 'awaiting_approval' }> {
  return {
    state: 'awaiting_approval',
    threadId: brandThreadId('00000000-0000-4000-8000-000000000001'),
    intensity: 'visual',
    depth: 'deep',
    createdAt: '2026-07-26T00:00:00.000Z',
    updatedAt: '2026-07-26T00:00:01.000Z',
    ...planStamp,
    draft: {
      schemaVersion: 'plan_draft_v1',
      outcome: 'Render a stamped spec',
      steps: [],
      decisions: [],
      assumptions: [],
      openQuestions: [],
    },
    proposalRunId: assertRunId('run-plan'),
  };
}
