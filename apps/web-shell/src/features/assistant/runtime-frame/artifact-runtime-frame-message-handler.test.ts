import test from 'node:test';
import assert from 'node:assert/strict';
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
} from './artifact-runtime-frame-message-handler-test-support.js';

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
