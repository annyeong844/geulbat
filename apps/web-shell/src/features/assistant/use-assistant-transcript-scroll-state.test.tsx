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
  scrollTopReads?: { current: number };
}): TranscriptNode {
  let scrollTop = 0;
  return {
    get scrollTop() {
      if (args.scrollTopReads) {
        args.scrollTopReads.current += 1;
      }
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
  onProgrammaticScrollProbe?: (isProgrammatic: boolean) => void;
  onUnreadChange?: (hasUnread: boolean) => void;
}) {
  const { messageCount, onLayout, onUnreadChange } = props;
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

  useLayoutEffect(() => {
    onUnreadChange?.(scrollState.hasUnreadStreamContent);
  }, [onUnreadChange, scrollState.hasUnreadStreamContent]);

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
        data-node="virtualizer-scroll-permission"
        data-enabled={scrollState.shouldApplyVirtualizerScroll()}
      />
      <button
        type="button"
        data-node="jump-to-latest"
        onClick={scrollState.handleJumpToLatest}
      />
      <button
        type="button"
        data-node="programmatic-scroll-probe"
        onClick={() =>
          props.onProgrammaticScrollProbe?.(
            scrollState.isProgrammaticTranscriptScroll(
              scrollState.transcriptRef.current?.scrollTop ?? Number.NaN,
            ),
          )
        }
      />
    </div>
  );
}

void test('auto-follow records its pre-write target without a post-write scrollTop read', async () => {
  const scrollTopReads = { current: 0 };
  const transcriptNode = createTranscriptNode({
    scrollHeight: 900,
    clientHeight: 400,
    scrollTopReads,
  });
  const programmaticScrollClassifications: boolean[] = [];
  let renderer!: ReactTestRenderer;

  await act(async () => {
    renderer = TestRenderer.create(
      <TranscriptScrollProbe
        messageCount={1}
        onLayout={() => {}}
        onProgrammaticScrollProbe={(isProgrammatic) =>
          programmaticScrollClassifications.push(isProgrammatic)
        }
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

  // TranscriptScrollProbe reads once to capture the committed layout. The
  // auto-follow owner must not add another read after assigning scrollTop.
  assert.equal(scrollTopReads.current, 1);
  renderer.root
    .findByProps({ 'data-node': 'programmatic-scroll-probe' })
    .props.onClick();
  transcriptNode.scrollTop = 499;
  renderer.root
    .findByProps({ 'data-node': 'programmatic-scroll-probe' })
    .props.onClick();
  assert.deepEqual(programmaticScrollClassifications, [true, false]);

  await act(async () => renderer.unmount());
});

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

void test('a delayed auto-follow scroll event cannot lock out a newer bottom layout', async () => {
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

void test('a settling answer that shrinks the transcript keeps the reader in place', async () => {
  // 답변이 끝나면 스트리밍 라이브 테일이 정착 메시지로 교체되면서 콘텐츠
  // 높이가 줄어든다. 그것은 "바닥으로 내려가라"는 신호가 아니다.
  const transcriptNode = createTranscriptNode({
    scrollHeight: 1_200,
    clientHeight: 400,
  });
  const unreadStates: boolean[] = [];
  let renderer!: ReactTestRenderer;

  await act(async () => {
    renderer = TestRenderer.create(
      <TranscriptScrollProbe
        messageCount={1}
        onLayout={() => {}}
        onUnreadChange={(unread) => unreadStates.push(unread)}
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
  assert.equal(transcriptNode.scrollTop, 800);

  // 사용자가 위로 올려 읽는다.
  transcriptNode.scrollTop = 250;
  await act(async () => {
    renderer.root.findByProps({ 'data-node': 'transcript' }).props.onScroll();
  });
  assert.equal(transcriptNode.scrollTop, 250);
  unreadStates.length = 0;

  // 답변 정착으로 높이가 줄어 250이 바닥 근처(690-250-400=40)가 된다.
  transcriptNode.scrollHeight = 690;
  await act(async () => {
    renderer.update(
      <TranscriptScrollProbe
        messageCount={2}
        onLayout={() => {}}
        onUnreadChange={(unread) => unreadStates.push(unread)}
      />,
    );
  });

  // 읽던 자리를 지킨다 — 새 바닥(290)으로 끌어내리지 않는다.
  assert.equal(transcriptNode.scrollTop, 250);
  // 줄어든 것은 새 내용이 아니므로 "새 메시지 보기"를 띄우지 않는다.
  assert.equal(
    unreadStates.includes(true),
    false,
    'a shrinking transcript must not announce unread content',
  );

  await act(async () => renderer.unmount());
});

void test('only history mode admits virtualizer correction writes', async () => {
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
  assert.equal(
    renderer.root.findByProps({
      'data-node': 'virtualizer-scroll-permission',
    }).props['data-enabled'],
    false,
  );

  transcriptNode.scrollTop = 250;
  await act(async () => {
    renderer.root.findByProps({ 'data-node': 'transcript' }).props.onScroll();
  });
  assert.equal(
    renderer.root.findByProps({
      'data-node': 'virtualizer-scroll-permission',
    }).props['data-enabled'],
    true,
  );
  transcriptNode.scrollHeight = 1_500;
  await act(async () => {
    renderer.update(
      <TranscriptScrollProbe messageCount={2} onLayout={() => {}} />,
    );
  });

  assert.equal(transcriptNode.scrollTop, 250);
  assert.equal(
    renderer.root.findByProps({
      'data-node': 'virtualizer-scroll-permission',
    }).props['data-enabled'],
    true,
  );

  await act(async () => {
    renderer.root
      .findByProps({ 'data-node': 'jump-to-latest' })
      .props.onClick();
  });
  assert.equal(transcriptNode.scrollTop, 1_100);
  assert.equal(
    renderer.root.findByProps({
      'data-node': 'virtualizer-scroll-permission',
    }).props['data-enabled'],
    false,
  );

  await act(async () => renderer.unmount());
});
