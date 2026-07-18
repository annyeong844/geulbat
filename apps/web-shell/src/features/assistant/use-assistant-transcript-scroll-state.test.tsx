import test from 'node:test';
import assert from 'node:assert/strict';
import React, { useLayoutEffect } from 'react';
import TestRenderer, { act, type ReactTestRenderer } from 'react-test-renderer';

import { useAssistantTranscriptScrollState } from './use-assistant-transcript-scroll-state.js';

(
  globalThis as typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
  }
).IS_REACT_ACT_ENVIRONMENT = true;

interface TranscriptNode {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
  scrollTo(options: ScrollToOptions): void;
}

function createTranscriptNode(args: {
  scrollHeight: number;
  clientHeight: number;
  animatedScrollCalls?: ScrollBehavior[];
}): TranscriptNode {
  let scrollTop = 0;
  return {
    get scrollTop() {
      return scrollTop;
    },
    set scrollTop(value) {
      scrollTop = Math.max(
        0,
        Math.min(value, Math.max(0, this.scrollHeight - this.clientHeight)),
      );
    },
    scrollHeight: args.scrollHeight,
    clientHeight: args.clientHeight,
    scrollTo(options) {
      args.animatedScrollCalls?.push(options.behavior ?? 'auto');
      this.scrollTop = options.top ?? this.scrollTop;
    },
  };
}

function TranscriptScrollProbe(props: {
  messageCount: number;
  onLayout: (scrollTop: number) => void;
}) {
  const { messageCount, onLayout } = props;
  const scrollState = useAssistantTranscriptScrollState({
    isRunning: false,
    messageCount,
    backgroundNotificationCount: 0,
    transcriptEntryCount: 0,
    finalAnswerText: '',
    activeArtifactKey: null,
    streamError: null,
  });

  useLayoutEffect(() => {
    onLayout(scrollState.transcriptRef.current?.scrollTop ?? -1);
  }, [messageCount, onLayout, scrollState.transcriptRef]);

  return (
    <div
      ref={scrollState.transcriptRef}
      data-node="transcript"
      onScroll={scrollState.handleTranscriptScroll}
    >
      <div ref={scrollState.contentRef} data-node="content" />
      <div ref={scrollState.bottomRef} data-node="bottom" />
      <button
        type="button"
        data-node="virtualizer-update"
        onClick={scrollState.handleVirtualizerUpdate}
      />
    </div>
  );
}

void test('message lifecycle follows the transcript before the updated frame can paint', async () => {
  const animatedScrollCalls: ScrollBehavior[] = [];
  const transcriptNode = createTranscriptNode({
    scrollHeight: 900,
    clientHeight: 400,
    animatedScrollCalls,
  });
  const layoutSnapshots: number[] = [];
  let renderer!: ReactTestRenderer;

  await act(async () => {
    renderer = TestRenderer.create(
      <TranscriptScrollProbe
        messageCount={1}
        onLayout={(scrollTop) => layoutSnapshots.push(scrollTop)}
      />,
      {
        createNodeMock(element) {
          const elementProps = element.props;
          if (
            typeof elementProps === 'object' &&
            elementProps !== null &&
            'data-node' in elementProps &&
            elementProps['data-node'] === 'transcript'
          ) {
            return transcriptNode;
          }
          return {};
        },
      },
    );
  });

  assert.equal(transcriptNode.scrollTop, 500);
  layoutSnapshots.length = 0;
  animatedScrollCalls.length = 0;
  transcriptNode.scrollHeight = 1_200;

  await act(async () => {
    renderer.update(
      <TranscriptScrollProbe
        messageCount={2}
        onLayout={(scrollTop) => layoutSnapshots.push(scrollTop)}
      />,
    );
  });

  assert.deepEqual(layoutSnapshots, [800]);
  assert.deepEqual(animatedScrollCalls, []);
  assert.equal(transcriptNode.scrollTop, 800);

  await act(async () => renderer.unmount());
});

void test('a delayed virtualizer scroll event cannot lock out a newer bottom layout', async () => {
  const transcriptNode = createTranscriptNode({
    scrollHeight: 900,
    clientHeight: 400,
  });
  let renderer!: ReactTestRenderer;

  await act(async () => {
    renderer = TestRenderer.create(
      <TranscriptScrollProbe messageCount={1} onLayout={() => {}} />,
      {
        createNodeMock(element) {
          const elementProps = element.props;
          if (
            typeof elementProps === 'object' &&
            elementProps !== null &&
            'data-node' in elementProps &&
            elementProps['data-node'] === 'transcript'
          ) {
            return transcriptNode;
          }
          return {};
        },
      },
    );
  });
  assert.equal(transcriptNode.scrollTop, 500);

  await act(async () => {
    renderer.root
      .findByProps({ 'data-node': 'virtualizer-update' })
      .props.onClick();
  });
  transcriptNode.scrollHeight = 1_200;
  await act(async () => {
    renderer.root.findByProps({ 'data-node': 'transcript' }).props.onScroll();
  });
  await act(async () => {
    renderer.update(
      <TranscriptScrollProbe messageCount={2} onLayout={() => {}} />,
    );
  });

  assert.equal(transcriptNode.scrollTop, 800);

  await act(async () => renderer.unmount());
});

void test('virtualizer updates preserve an explicit user scroll lock', async () => {
  const transcriptNode = createTranscriptNode({
    scrollHeight: 1_200,
    clientHeight: 400,
  });
  let renderer!: ReactTestRenderer;

  await act(async () => {
    renderer = TestRenderer.create(
      <TranscriptScrollProbe messageCount={1} onLayout={() => {}} />,
      {
        createNodeMock(element) {
          const elementProps = element.props;
          if (
            typeof elementProps === 'object' &&
            elementProps !== null &&
            'data-node' in elementProps &&
            elementProps['data-node'] === 'transcript'
          ) {
            return transcriptNode;
          }
          return {};
        },
      },
    );
  });
  assert.equal(transcriptNode.scrollTop, 800);

  transcriptNode.scrollTop = 250;
  await act(async () => {
    renderer.root.findByProps({ 'data-node': 'transcript' }).props.onScroll();
  });
  transcriptNode.scrollHeight = 1_500;
  await act(async () => {
    renderer.root
      .findByProps({ 'data-node': 'virtualizer-update' })
      .props.onClick();
    renderer.update(
      <TranscriptScrollProbe messageCount={2} onLayout={() => {}} />,
    );
  });

  assert.equal(transcriptNode.scrollTop, 250);

  await act(async () => renderer.unmount());
});
