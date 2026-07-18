import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement, type ComponentProps } from 'react';
import TestRenderer, { act, type ReactTestRenderer } from 'react-test-renderer';

import { ArtifactRuntimeFrame } from './artifact-runtime-frame.js';
import {
  ARTIFACT_RUNTIME_HOST_MESSAGE_KIND,
  ARTIFACT_RUNTIME_HOST_READY_ACTION,
  resolveArtifactRuntimeHostUrl,
} from './artifact-runtime-host.js';
import type { ResolvedArtifactSourceRef } from '../../artifacts/artifact-types.js';

(
  globalThis as typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
  }
).IS_REACT_ACT_ENVIRONMENT = true;

class FakeMessageWindow {
  readonly location = {
    origin: 'http://127.0.0.1:5173',
  };

  private readonly messageListeners = new Set<
    (event: MessageEvent<unknown>) => void
  >();

  addEventListener(
    type: string,
    listener: (event: MessageEvent<unknown>) => void,
  ) {
    if (type === 'message') {
      this.messageListeners.add(listener);
    }
  }

  removeEventListener(
    type: string,
    listener: (event: MessageEvent<unknown>) => void,
  ) {
    if (type === 'message') {
      this.messageListeners.delete(listener);
    }
  }

  emitMessage(event: { source: unknown; origin: string; data: unknown }) {
    const messageEvent = event as MessageEvent<unknown>;
    for (const listener of [...this.messageListeners]) {
      listener(messageEvent);
    }
  }
}

class FakeFrameWindow {
  readonly postedMessages: Array<{ message: unknown; targetOrigin: string }> =
    [];

  postMessage(message: unknown, targetOrigin: string) {
    this.postedMessages.push({ message, targetOrigin });
  }
}

interface ArtifactRuntimeFrameHarness {
  readonly frameWindow: FakeFrameWindow;
  readonly hostOrigin: string;
  renderText(): string;
  emitReady(): Promise<void>;
  emitRuntimeMessage(data: unknown): Promise<void>;
  rerender(
    nextProps?: Partial<ComponentProps<typeof ArtifactRuntimeFrame>>,
  ): Promise<void>;
  waitFor(ms: number): Promise<void>;
  unmount(): void;
}

function createResolvedSourceRef(
  overrides: Partial<ResolvedArtifactSourceRef> = {},
): ResolvedArtifactSourceRef {
  return {
    kind: null,
    workingDirectory: '',
    threadId: null,
    runId: null,
    filePath: null,
    messageTimestamp: null,
    artifactId: null,
    artifactVersion: null,
    persistenceEpoch: null,
    ...overrides,
  };
}

function installFakeWindow(fakeWindow: FakeMessageWindow): () => void {
  const globalWindow = globalThis as {
    window?: Window & typeof globalThis;
  };
  const originalWindow = globalWindow.window;
  const hadWindow = 'window' in globalWindow;
  globalWindow.window = fakeWindow as unknown as Window & typeof globalThis;

  return () => {
    if (hadWindow && originalWindow !== undefined) {
      globalWindow.window = originalWindow;
      return;
    }
    delete globalWindow.window;
  };
}

async function createArtifactRuntimeFrameHarness(
  overrides: Partial<ComponentProps<typeof ArtifactRuntimeFrame>> = {},
): Promise<ArtifactRuntimeFrameHarness> {
  const fakeWindow = new FakeMessageWindow();
  const restoreWindow = installFakeWindow(fakeWindow);
  const frameWindow = new FakeFrameWindow();
  const baseProps: ComponentProps<typeof ArtifactRuntimeFrame> = {
    renderer: 'js',
    title: 'Artifact Runtime',
    sandbox: 'allow-scripts',
    runtimePayload: 'window.__artifact_booted__ = true;',
    sourceRef: createResolvedSourceRef(),
    readyTimeoutMs: 20,
  };
  let props = {
    ...baseProps,
    ...overrides,
  };
  let renderer!: ReactTestRenderer;

  await act(async () => {
    renderer = TestRenderer.create(createElement(ArtifactRuntimeFrame, props), {
      createNodeMock(element) {
        if (element.type === 'iframe') {
          return {
            contentWindow: frameWindow,
          };
        }
        return null;
      },
    });
    await Promise.resolve();
  });

  const hostOrigin = new URL(
    resolveArtifactRuntimeHostUrl(fakeWindow.location.origin),
  ).origin;

  return {
    frameWindow,
    hostOrigin,
    renderText() {
      return JSON.stringify(renderer.toJSON());
    },
    async emitReady() {
      await act(async () => {
        fakeWindow.emitMessage({
          source: frameWindow,
          origin: hostOrigin,
          data: {
            kind: ARTIFACT_RUNTIME_HOST_MESSAGE_KIND,
            action: ARTIFACT_RUNTIME_HOST_READY_ACTION,
          },
        });
        await Promise.resolve();
      });
    },
    async emitRuntimeMessage(data) {
      await act(async () => {
        fakeWindow.emitMessage({
          source: frameWindow,
          origin: hostOrigin,
          data,
        });
        await Promise.resolve();
      });
    },
    async rerender(nextProps) {
      props = {
        ...props,
        ...nextProps,
      };
      await act(async () => {
        renderer.update(createElement(ArtifactRuntimeFrame, props));
        await Promise.resolve();
      });
    },
    async waitFor(ms) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, ms));
      });
    },
    unmount() {
      act(() => {
        renderer.unmount();
      });
      restoreWindow();
    },
  };
}

void test('ArtifactRuntimeFrame shows a timeout fallback until the host becomes ready', async () => {
  const harness = await createArtifactRuntimeFrameHarness({
    readyTimeoutMs: 5,
  });

  try {
    await harness.waitFor(15);
    assert.match(
      harness.renderText(),
      /캔버스를 시작하지 못했습니다\. 잠시 후 다시 시도해 주세요\./,
    );
    assert.equal(harness.frameWindow.postedMessages.length, 0);

    await harness.emitReady();

    assert.doesNotMatch(
      harness.renderText(),
      /캔버스를 시작하지 못했습니다\. 잠시 후 다시 시도해 주세요\./,
    );
    assert.equal(harness.frameWindow.postedMessages.length, 1);
  } finally {
    harness.unmount();
  }
});

void test('ArtifactRuntimeFrame boots immediately when the host reports ready before timeout', async () => {
  const harness = await createArtifactRuntimeFrameHarness({
    readyTimeoutMs: 30,
  });

  try {
    await harness.emitReady();
    await harness.waitFor(40);

    const bootMessage = harness.frameWindow.postedMessages[0];
    assert.ok(bootMessage);
    assert.equal(harness.frameWindow.postedMessages.length, 1);
    assert.equal(bootMessage.targetOrigin, harness.hostOrigin);
    assert.equal(
      (bootMessage.message as { kind?: unknown }).kind,
      ARTIFACT_RUNTIME_HOST_MESSAGE_KIND,
    );
    assert.equal((bootMessage.message as { action?: unknown }).action, 'boot');
    assert.equal(
      typeof (bootMessage.message as { documentHtml?: unknown }).documentHtml,
      'string',
    );
    assert.doesNotMatch(
      harness.renderText(),
      /캔버스를 시작하지 못했습니다\. 잠시 후 다시 시도해 주세요\./,
    );
  } finally {
    harness.unmount();
  }
});

void test('ArtifactRuntimeFrame keeps react bundle boot non-blocking on persistence preload', async () => {
  const harness = await createArtifactRuntimeFrameHarness({
    renderer: 'react_bundle',
    sandbox: 'allow-scripts allow-forms allow-same-origin',
    readyTimeoutMs: 30,
  });

  try {
    await harness.emitReady();
    const bootMessage = harness.frameWindow.postedMessages[0];
    const documentHtml = (bootMessage?.message as { documentHtml?: string })
      ?.documentHtml;

    assert.equal(typeof documentHtml, 'string');
    assert.match(
      documentHtml ?? '',
      /const awaitStorageBeforePayload =\s*false;/,
    );
  } finally {
    harness.unmount();
  }
});

void test('ArtifactRuntimeFrame ignores unrelated host messages before the ready handshake', async () => {
  const harness = await createArtifactRuntimeFrameHarness({
    readyTimeoutMs: 30,
  });

  try {
    await harness.emitRuntimeMessage({
      kind: ARTIFACT_RUNTIME_HOST_MESSAGE_KIND,
      action: 'noise',
    });
    await harness.emitReady();
    await harness.waitFor(40);

    const bootMessage = harness.frameWindow.postedMessages[0];
    assert.ok(bootMessage);
    assert.equal(harness.frameWindow.postedMessages.length, 1);
    assert.equal(bootMessage.targetOrigin, harness.hostOrigin);
    assert.equal((bootMessage.message as { action?: unknown }).action, 'boot');
    assert.doesNotMatch(
      harness.renderText(),
      /캔버스를 시작하지 못했습니다\. 잠시 후 다시 시도해 주세요\./,
    );
  } finally {
    harness.unmount();
  }
});

void test('ArtifactRuntimeFrame keeps reading the existing generated binary snapshot ABI', async () => {
  const snapshots: Array<Blob | null> = [];
  const harness = await createArtifactRuntimeFrameHarness({
    onGeneratedBinaryExportSnapshotChange(snapshot) {
      snapshots.push(snapshot?.blob ?? null);
    },
  });

  try {
    await harness.emitReady();
    const bootMessage = harness.frameWindow.postedMessages[0];
    const documentHtml = (bootMessage?.message as { documentHtml?: string })
      ?.documentHtml;
    assert.equal(typeof documentHtml, 'string');
    const scopeHandle = documentHtml?.match(
      /const runtimeScopeHandle = "([^"]+)";/,
    )?.[1];
    assert.equal(typeof scopeHandle, 'string');

    const blob = new Blob(['bytes'], { type: 'application/octet-stream' });
    await harness.emitRuntimeMessage({
      kind: 'geulbat.runtime.generated_binary_export',
      scopeHandle,
      action: 'set_snapshot',
      snapshot: {
        blob,
        fileNameHint: 'preview.bin',
      },
    });
    await harness.emitRuntimeMessage({
      kind: 'geulbat.runtime.generated_binary_export',
      scopeHandle,
      action: 'clear_snapshot',
    });

    assert.equal(snapshots.length, 3);
    assert.equal(snapshots[0], null);
    assert.equal(snapshots[1], blob);
    assert.equal(snapshots[2], null);
  } finally {
    harness.unmount();
  }
});
