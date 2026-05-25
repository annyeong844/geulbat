import test from 'node:test';
import assert from 'node:assert/strict';
import type { ArtifactRuntimePersistenceBridgeResponder } from '../runtime-persistence/artifact-runtime-persistence-types.js';
import {
  ARTIFACT_RUNTIME_HOST_MESSAGE_KIND,
  ARTIFACT_RUNTIME_HOST_READY_ACTION,
  ARTIFACT_RUNTIME_HOST_RESIZE_ACTION,
  createArtifactRuntimeHostBootMessage,
} from './artifact-runtime-host.js';
import { handleArtifactRuntimeFrameMessageEvent } from './artifact-runtime-frame-message-handler.js';

const RUNTIME_HOST_ORIGIN = 'http://127.0.0.1:3456';
const RUNTIME_DOCUMENT = '<!doctype html><html><body>runtime</body></html>';
const SCOPE_HANDLE = 'scope-rev2-message-handler';

class FakeFrameWindow {
  readonly postedMessages: Array<{ message: unknown; targetOrigin: string }> =
    [];

  postMessage(message: unknown, targetOrigin: string) {
    this.postedMessages.push({ message, targetOrigin });
  }
}

function createIframeRef(frameWindow: FakeFrameWindow): {
  current: HTMLIFrameElement;
} {
  return {
    current: createIframeElement(frameWindow),
  };
}

function createIframeElement(frameWindow: FakeFrameWindow): HTMLIFrameElement {
  return {
    contentWindow: frameWindow,
  } as unknown as HTMLIFrameElement;
}

function createMessageEvent(args: {
  source: unknown;
  origin?: string;
  data: unknown;
}): MessageEvent<unknown> {
  return {
    source: args.source,
    origin: args.origin ?? RUNTIME_HOST_ORIGIN,
    data: args.data,
  } as MessageEvent<unknown>;
}

function createReadyMessage() {
  return {
    kind: ARTIFACT_RUNTIME_HOST_MESSAGE_KIND,
    action: ARTIFACT_RUNTIME_HOST_READY_ACTION,
  };
}

function createBridgeResponder(
  handleMessage: ArtifactRuntimePersistenceBridgeResponder['handleMessage'] = async () =>
    null,
): ArtifactRuntimePersistenceBridgeResponder {
  return {
    scopeHandle: SCOPE_HANDLE,
    handleMessage,
  };
}

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

void test('handleArtifactRuntimeFrameMessageEvent delegates persistence messages and posts bridge responses', async () => {
  const frameWindow = new FakeFrameWindow();
  const data = {
    kind: 'geulbat.runtime.persistence.request',
    version: 1,
    requestId: 'req-1',
    scopeHandle: SCOPE_HANDLE,
    verb: 'load_state',
  };
  const response = {
    kind: 'geulbat.shell.persistence.response',
    version: 1,
    requestId: 'req-1',
    scopeHandle: SCOPE_HANDLE,
    verb: 'load_state',
    ok: true,
    state: { count: 1 },
    revision: 'rev-1',
  } as const;
  const bridgeCalls: Array<{
    source: MessageEventSource | null;
    data: unknown;
  }> = [];

  await handleArtifactRuntimeFrameMessageEvent(
    createMessageEvent({
      source: frameWindow,
      data,
    }),
    {
      iframeRef: createIframeRef(frameWindow),
      runtimeDocument: RUNTIME_DOCUMENT,
      runtimeHostOrigin: RUNTIME_HOST_ORIGIN,
      scopeHandle: SCOPE_HANDLE,
      bridgeResponder: createBridgeResponder(async (source, messageData) => {
        bridgeCalls.push({ source, data: messageData });
        return response;
      }),
      markHostReady() {},
      setFrameHeight() {},
    },
  );

  assert.deepEqual(bridgeCalls, [
    {
      source: frameWindow,
      data,
    },
  ]);
  assert.deepEqual(frameWindow.postedMessages, [
    {
      message: response,
      targetOrigin: RUNTIME_HOST_ORIGIN,
    },
  ]);
});

void test('handleArtifactRuntimeFrameMessageEvent drops stale bridge responses after the iframe source changes', async () => {
  const frameWindow = new FakeFrameWindow();
  const nextFrameWindow = new FakeFrameWindow();
  const iframeRef = createIframeRef(frameWindow);
  let resolveResponse: (
    value: Awaited<
      ReturnType<ArtifactRuntimePersistenceBridgeResponder['handleMessage']>
    >,
  ) => void = () => {
    throw new Error('response promise resolver was not initialized');
  };
  const responsePromise = new Promise<
    Awaited<
      ReturnType<ArtifactRuntimePersistenceBridgeResponder['handleMessage']>
    >
  >((resolve) => {
    resolveResponse = resolve;
  });

  const result = handleArtifactRuntimeFrameMessageEvent(
    createMessageEvent({
      source: frameWindow,
      data: {
        kind: 'geulbat.runtime.persistence.request',
        version: 1,
        requestId: 'req-stale',
        scopeHandle: SCOPE_HANDLE,
        verb: 'load_state',
      },
    }),
    {
      iframeRef,
      runtimeDocument: RUNTIME_DOCUMENT,
      runtimeHostOrigin: RUNTIME_HOST_ORIGIN,
      scopeHandle: SCOPE_HANDLE,
      bridgeResponder: createBridgeResponder(() => responsePromise),
      markHostReady() {},
      setFrameHeight() {},
    },
  );
  iframeRef.current = createIframeElement(nextFrameWindow);

  resolveResponse({
    kind: 'geulbat.shell.persistence.response',
    version: 1,
    requestId: 'req-stale',
    scopeHandle: SCOPE_HANDLE,
    verb: 'load_state',
    ok: true,
    state: null,
    revision: null,
  });
  await result;

  assert.deepEqual(frameWindow.postedMessages, []);
  assert.deepEqual(nextFrameWindow.postedMessages, []);
});
