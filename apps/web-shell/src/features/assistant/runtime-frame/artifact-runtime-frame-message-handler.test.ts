import test from 'node:test';
import assert from 'node:assert/strict';
import { resetArtifactBackchannelRateLimitForTests } from './artifact-backchannel-rate-limit.js';
import {
  ARTIFACT_RUNTIME_HOST_MESSAGE_KIND,
  ARTIFACT_RUNTIME_HOST_RESIZE_ACTION,
  createArtifactRuntimeHostBootMessage,
} from './artifact-runtime-host.js';
import { handleArtifactRuntimeFrameMessageEvent } from './artifact-runtime-frame-message-handler.js';
import {
  createBridgeResponder,
  createIframeRef,
  createMessageEvent,
  createReadyMessage,
  FakeFrameWindow,
  RUNTIME_DOCUMENT,
  RUNTIME_HOST_ORIGIN,
  SCOPE_HANDLE,
} from '../../../test-support/artifact-runtime-frame-message-handler.js';

void test('handleArtifactRuntimeFrameMessageEvent ignores messages outside the runtime frame origin and source', async () => {
  const frameWindow = new FakeFrameWindow();
  const otherFrameWindow = new FakeFrameWindow();
  const bridgeCalls: Array<{
    source: MessageEventSource | null;
    data: unknown;
  }> = [];
  const responder = createBridgeResponder(async (source, data) => {
    bridgeCalls.push({ source, data });
    return null;
  });
  let readyCount = 0;

  await handleArtifactRuntimeFrameMessageEvent(
    createMessageEvent({
      source: otherFrameWindow,
      data: createReadyMessage(),
    }),
    {
      iframeRef: createIframeRef(frameWindow),
      runtimeDocument: RUNTIME_DOCUMENT,
      runtimeHostOrigin: RUNTIME_HOST_ORIGIN,
      scopeHandle: SCOPE_HANDLE,
      bridgeResponder: responder,
      markHostReady() {
        readyCount += 1;
      },
      setFrameHeight() {},
    },
  );

  await handleArtifactRuntimeFrameMessageEvent(
    createMessageEvent({
      source: frameWindow,
      origin: 'https://untrusted.example.test',
      data: createReadyMessage(),
    }),
    {
      iframeRef: createIframeRef(frameWindow),
      runtimeDocument: RUNTIME_DOCUMENT,
      runtimeHostOrigin: RUNTIME_HOST_ORIGIN,
      scopeHandle: SCOPE_HANDLE,
      bridgeResponder: responder,
      markHostReady() {
        readyCount += 1;
      },
      setFrameHeight() {},
    },
  );

  assert.equal(readyCount, 0);
  assert.deepEqual(bridgeCalls, []);
  assert.deepEqual(frameWindow.postedMessages, []);
});

void test('handleArtifactRuntimeFrameMessageEvent completes the host ready handshake', async () => {
  const frameWindow = new FakeFrameWindow();
  let readyCount = 0;

  await handleArtifactRuntimeFrameMessageEvent(
    createMessageEvent({
      source: frameWindow,
      data: createReadyMessage(),
    }),
    {
      iframeRef: createIframeRef(frameWindow),
      runtimeDocument: RUNTIME_DOCUMENT,
      runtimeHostOrigin: RUNTIME_HOST_ORIGIN,
      scopeHandle: SCOPE_HANDLE,
      bridgeResponder: createBridgeResponder(),
      markHostReady() {
        readyCount += 1;
      },
      setFrameHeight() {},
    },
  );

  assert.equal(readyCount, 1);
  assert.deepEqual(frameWindow.postedMessages, [
    {
      message: createArtifactRuntimeHostBootMessage(RUNTIME_DOCUMENT),
      targetOrigin: RUNTIME_HOST_ORIGIN,
    },
  ]);
});

void test('handleArtifactRuntimeFrameMessageEvent applies resize and generated snapshot messages', async () => {
  const frameWindow = new FakeFrameWindow();
  const iframeRef = createIframeRef(frameWindow);
  const frameHeights: number[] = [];
  const textSnapshots: Array<unknown> = [];
  const binarySnapshots: Array<unknown> = [];
  const blob = new Blob(['bytes'], { type: 'application/octet-stream' });
  const baseArgs = {
    iframeRef,
    runtimeDocument: RUNTIME_DOCUMENT,
    runtimeHostOrigin: RUNTIME_HOST_ORIGIN,
    scopeHandle: SCOPE_HANDLE,
    bridgeResponder: createBridgeResponder(),
    markHostReady() {},
    setFrameHeight(height: number) {
      frameHeights.push(height);
    },
    onGeneratedTextExportSnapshotChange(snapshot: unknown) {
      textSnapshots.push(snapshot);
    },
    onGeneratedBinaryExportSnapshotChange(snapshot: unknown) {
      binarySnapshots.push(snapshot);
    },
  };

  await handleArtifactRuntimeFrameMessageEvent(
    createMessageEvent({
      source: frameWindow,
      data: {
        kind: ARTIFACT_RUNTIME_HOST_MESSAGE_KIND,
        action: ARTIFACT_RUNTIME_HOST_RESIZE_ACTION,
        height: 320.2,
      },
    }),
    baseArgs,
  );
  await handleArtifactRuntimeFrameMessageEvent(
    createMessageEvent({
      source: frameWindow,
      data: {
        kind: 'geulbat.runtime.generated_text_export',
        scopeHandle: SCOPE_HANDLE,
        action: 'set_snapshot',
        snapshot: {
          content: 'hello',
          mimeType: 'text/plain',
          fileNameHint: 'hello.txt',
        },
      },
    }),
    baseArgs,
  );
  await handleArtifactRuntimeFrameMessageEvent(
    createMessageEvent({
      source: frameWindow,
      data: {
        kind: 'geulbat.runtime.generated_text_export',
        scopeHandle: SCOPE_HANDLE,
        action: 'clear_snapshot',
      },
    }),
    baseArgs,
  );
  await handleArtifactRuntimeFrameMessageEvent(
    createMessageEvent({
      source: frameWindow,
      data: {
        kind: 'geulbat.runtime.generated_binary_export',
        scopeHandle: SCOPE_HANDLE,
        action: 'set_snapshot',
        snapshot: {
          blob,
          fileNameHint: 'preview.bin',
        },
      },
    }),
    baseArgs,
  );
  await handleArtifactRuntimeFrameMessageEvent(
    createMessageEvent({
      source: frameWindow,
      data: {
        kind: 'geulbat.runtime.generated_binary_export',
        scopeHandle: SCOPE_HANDLE,
        action: 'clear_snapshot',
      },
    }),
    baseArgs,
  );

  assert.deepEqual(frameHeights, [321]);
  assert.deepEqual(textSnapshots, [
    {
      content: 'hello',
      mimeType: 'text/plain',
      fileNameHint: 'hello.txt',
    },
    null,
  ]);
  assert.deepEqual(binarySnapshots, [
    {
      blob,
      fileNameHint: 'preview.bin',
    },
    null,
  ]);
});

void test('handleArtifactRuntimeFrameMessageEvent round-trips agent tool requests back to the frame', async () => {
  const frameWindow = new FakeFrameWindow();
  const seenIntents: Array<unknown> = [];

  await handleArtifactRuntimeFrameMessageEvent(
    createMessageEvent({
      source: frameWindow,
      data: {
        kind: 'geulbat.artifact_runtime_agent',
        action: 'request_tool',
        scopeHandle: SCOPE_HANDLE,
        requestId: 'af-1',
        toolName: 'read_file',
        args: { path: 'draft.md' },
      },
    }),
    {
      iframeRef: createIframeRef(frameWindow),
      runtimeDocument: RUNTIME_DOCUMENT,
      runtimeHostOrigin: RUNTIME_HOST_ORIGIN,
      scopeHandle: SCOPE_HANDLE,
      bridgeResponder: createBridgeResponder(),
      markHostReady() {},
      setFrameHeight() {},
      async onAgentToolRequest(intent) {
        seenIntents.push(intent);
        return { ok: true, output: 'tool-output' };
      },
    },
  );

  assert.deepEqual(seenIntents, [
    {
      requestId: 'af-1',
      toolName: 'read_file',
      args: { path: 'draft.md' },
      scopeHandle: SCOPE_HANDLE,
    },
  ]);
  assert.deepEqual(frameWindow.postedMessages, [
    {
      message: {
        kind: 'geulbat.shell.agent_tool_result',
        requestId: 'af-1',
        result: { ok: true, output: 'tool-output' },
      },
      targetOrigin: RUNTIME_HOST_ORIGIN,
    },
  ]);
});

void test('handleArtifactRuntimeFrameMessageEvent answers unwired or failing tool requests with an error result', async () => {
  const frameWindow = new FakeFrameWindow();

  // 콜백 미배선 — 프레임 pending Promise가 매달리지 않도록 unavailable 회신
  await handleArtifactRuntimeFrameMessageEvent(
    createMessageEvent({
      source: frameWindow,
      data: {
        kind: 'geulbat.artifact_runtime_agent',
        action: 'request_tool',
        scopeHandle: SCOPE_HANDLE,
        requestId: 'af-2',
        toolName: 'read_file',
        args: {},
      },
    }),
    {
      iframeRef: createIframeRef(frameWindow),
      runtimeDocument: RUNTIME_DOCUMENT,
      runtimeHostOrigin: RUNTIME_HOST_ORIGIN,
      scopeHandle: SCOPE_HANDLE,
      bridgeResponder: createBridgeResponder(),
      markHostReady() {},
      setFrameHeight() {},
    },
  );

  // 콜백 예외 — internal 오류 결과로 회신
  await handleArtifactRuntimeFrameMessageEvent(
    createMessageEvent({
      source: frameWindow,
      data: {
        kind: 'geulbat.artifact_runtime_agent',
        action: 'request_tool',
        scopeHandle: SCOPE_HANDLE,
        requestId: 'af-3',
        toolName: 'read_file',
        args: {},
      },
    }),
    {
      iframeRef: createIframeRef(frameWindow),
      runtimeDocument: RUNTIME_DOCUMENT,
      runtimeHostOrigin: RUNTIME_HOST_ORIGIN,
      scopeHandle: SCOPE_HANDLE,
      bridgeResponder: createBridgeResponder(),
      markHostReady() {},
      setFrameHeight() {},
      async onAgentToolRequest() {
        throw new Error('boom');
      },
    },
  );

  assert.equal(frameWindow.postedMessages.length, 2);
  const [unwired, failed] = frameWindow.postedMessages;
  assert.deepEqual(unwired?.message, {
    kind: 'geulbat.shell.agent_tool_result',
    requestId: 'af-2',
    result: {
      ok: false,
      errorCode: 'unavailable',
      error: 'tool channel is not wired for this artifact frame',
    },
  });
  assert.deepEqual(failed?.message, {
    kind: 'geulbat.shell.agent_tool_result',
    requestId: 'af-3',
    result: { ok: false, errorCode: 'internal', error: 'boom' },
  });
});

void test('handleArtifactRuntimeFrameMessageEvent drops prompt intents over the scopeHandle budget', async () => {
  resetArtifactBackchannelRateLimitForTests();
  const frameWindow = new FakeFrameWindow();
  const prompts: string[] = [];
  const baseArgs = {
    iframeRef: createIframeRef(frameWindow),
    runtimeDocument: RUNTIME_DOCUMENT,
    runtimeHostOrigin: RUNTIME_HOST_ORIGIN,
    scopeHandle: SCOPE_HANDLE,
    bridgeResponder: createBridgeResponder(),
    markHostReady() {},
    setFrameHeight() {},
    onAgentPromptRequest(intent: { text: string }) {
      prompts.push(intent.text);
    },
  };

  // prompt 레인 예산(3/10s) 초과분은 조용히 드롭된다 — 루프 난사 방지
  for (let index = 0; index < 5; index += 1) {
    await handleArtifactRuntimeFrameMessageEvent(
      createMessageEvent({
        source: frameWindow,
        data: {
          kind: 'geulbat.artifact_runtime_agent',
          action: 'request_prompt',
          scopeHandle: SCOPE_HANDLE,
          text: `prompt-${index}`,
        },
      }),
      baseArgs,
    );
  }

  assert.deepEqual(prompts, ['prompt-0', 'prompt-1', 'prompt-2']);
  assert.deepEqual(frameWindow.postedMessages, []);
  resetArtifactBackchannelRateLimitForTests();
});

void test('handleArtifactRuntimeFrameMessageEvent settles tool requests over budget with rate_limited', async () => {
  resetArtifactBackchannelRateLimitForTests();
  const frameWindow = new FakeFrameWindow();
  let toolCallCount = 0;
  const baseArgs = {
    iframeRef: createIframeRef(frameWindow),
    runtimeDocument: RUNTIME_DOCUMENT,
    runtimeHostOrigin: RUNTIME_HOST_ORIGIN,
    scopeHandle: SCOPE_HANDLE,
    bridgeResponder: createBridgeResponder(),
    markHostReady() {},
    setFrameHeight() {},
    async onAgentToolRequest() {
      toolCallCount += 1;
      return { ok: true as const, output: 'ok' };
    },
  };

  for (let index = 0; index < 11; index += 1) {
    await handleArtifactRuntimeFrameMessageEvent(
      createMessageEvent({
        source: frameWindow,
        data: {
          kind: 'geulbat.artifact_runtime_agent',
          action: 'request_tool',
          scopeHandle: SCOPE_HANDLE,
          requestId: `af-limit-${index}`,
          toolName: 'read_file',
          args: {},
        },
      }),
      baseArgs,
    );
  }

  // 예산(10/10s) 안쪽은 실행되고, 초과분은 실행 없이 rate_limited로 settle
  assert.equal(toolCallCount, 10);
  assert.equal(frameWindow.postedMessages.length, 11);
  const lastReply = frameWindow.postedMessages.at(-1);
  assert.deepEqual(lastReply?.message, {
    kind: 'geulbat.shell.agent_tool_result',
    requestId: 'af-limit-10',
    result: {
      ok: false,
      errorCode: 'rate_limited',
      error: 'artifact frame tool budget exhausted; retry later',
    },
  });
  resetArtifactBackchannelRateLimitForTests();
});

void test('handleArtifactRuntimeFrameMessageEvent ignores tool requests with a spoofed scopeHandle', async () => {
  const frameWindow = new FakeFrameWindow();
  let toolCallCount = 0;

  await handleArtifactRuntimeFrameMessageEvent(
    createMessageEvent({
      source: frameWindow,
      data: {
        kind: 'geulbat.artifact_runtime_agent',
        action: 'request_tool',
        scopeHandle: 'stolen-scope',
        requestId: 'af-4',
        toolName: 'read_file',
        args: {},
      },
    }),
    {
      iframeRef: createIframeRef(frameWindow),
      runtimeDocument: RUNTIME_DOCUMENT,
      runtimeHostOrigin: RUNTIME_HOST_ORIGIN,
      scopeHandle: SCOPE_HANDLE,
      bridgeResponder: createBridgeResponder(),
      markHostReady() {},
      setFrameHeight() {},
      async onAgentToolRequest() {
        toolCallCount += 1;
        return { ok: true, output: 'never' };
      },
    },
  );

  assert.equal(toolCallCount, 0);
  assert.deepEqual(frameWindow.postedMessages, []);
});
