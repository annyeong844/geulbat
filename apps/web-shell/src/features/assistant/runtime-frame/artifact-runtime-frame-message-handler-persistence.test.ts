import test from 'node:test';
import assert from 'node:assert/strict';
import type { ArtifactRuntimePersistenceBridgeResponder } from '../runtime-persistence/artifact-runtime-persistence-types.js';
import { handleArtifactRuntimeFrameMessageEvent } from './artifact-runtime-frame-message-handler.js';
import {
  createBridgeResponder,
  createIframeElement,
  createIframeRef,
  createMessageEvent,
  FakeFrameWindow,
  RUNTIME_DOCUMENT,
  RUNTIME_HOST_ORIGIN,
  SCOPE_HANDLE,
} from './artifact-runtime-frame-message-handler-test-support.js';

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
