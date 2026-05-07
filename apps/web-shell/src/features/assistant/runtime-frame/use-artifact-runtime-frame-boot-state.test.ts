import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import TestRenderer, { act, type ReactTestRenderer } from 'react-test-renderer';

import {
  useArtifactRuntimeFrameBootState,
  type ArtifactRuntimeBootState,
} from './use-artifact-runtime-frame-boot-state.js';
import { MIN_ARTIFACT_RUNTIME_FRAME_HEIGHT } from './artifact-runtime-frame-messages.js';

(
  globalThis as typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
  }
).IS_REACT_ACT_ENVIRONMENT = true;

type BootStateResult = ReturnType<typeof useArtifactRuntimeFrameBootState>;

interface BootStateHarness {
  latest(): BootStateResult;
  renderText(): string;
  update(
    nextProps: Partial<Parameters<typeof useArtifactRuntimeFrameBootState>[0]>,
  ): Promise<void>;
  waitFor(ms: number): Promise<void>;
  unmount(): void;
}

async function createBootStateHarness(
  overrides: Partial<
    Parameters<typeof useArtifactRuntimeFrameBootState>[0]
  > = {},
): Promise<BootStateHarness> {
  let props: Parameters<typeof useArtifactRuntimeFrameBootState>[0] = {
    runtimeFrameRevision: 'rev-1',
    readyTimeoutMs: 20,
    ...overrides,
  };
  let latest!: BootStateResult;
  let renderer!: ReactTestRenderer;

  function Probe() {
    latest = useArtifactRuntimeFrameBootState(props);
    return createElement(
      'span',
      null,
      `${latest.bootState}:${latest.frameHeight}`,
    );
  }

  await act(async () => {
    renderer = TestRenderer.create(createElement(Probe));
    await Promise.resolve();
  });

  return {
    latest() {
      return latest;
    },
    renderText() {
      return JSON.stringify(renderer.toJSON());
    },
    async update(nextProps) {
      props = {
        ...props,
        ...nextProps,
      };
      await act(async () => {
        renderer.update(createElement(Probe));
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
    },
  };
}

void test('useArtifactRuntimeFrameBootState starts waiting and times out when the host stays silent', async () => {
  const harness = await createBootStateHarness({ readyTimeoutMs: 1000 });

  try {
    assert.equal(harness.latest().bootState, 'waiting');
    assert.equal(
      harness.latest().frameHeight,
      MIN_ARTIFACT_RUNTIME_FRAME_HEIGHT,
    );
    assert.match(harness.renderText(), /waiting:260/);

    await harness.update({
      runtimeFrameRevision: 'rev-timeout',
      readyTimeoutMs: 5,
    });
    await harness.waitFor(15);

    assert.equal(harness.latest().bootState, 'timed_out');
    assert.match(harness.renderText(), /timed_out:260/);
  } finally {
    harness.unmount();
  }
});

void test('useArtifactRuntimeFrameBootState marks the host ready and cancels the timeout', async () => {
  const observedStates: ArtifactRuntimeBootState[] = [];
  const harness = await createBootStateHarness({ readyTimeoutMs: 5 });

  try {
    await act(async () => {
      harness.latest().markHostReady();
      await new Promise((resolve) => setTimeout(resolve, 15));
    });
    observedStates.push(harness.latest().bootState);

    assert.deepEqual(observedStates, ['ready']);
    assert.match(harness.renderText(), /ready:260/);
  } finally {
    harness.unmount();
  }
});

void test('useArtifactRuntimeFrameBootState resets height, boot state, and generated snapshots when the frame revision changes', async () => {
  const textSnapshots: Array<unknown> = [];
  const binarySnapshots: Array<unknown> = [];
  const harness = await createBootStateHarness({
    readyTimeoutMs: 20,
    onGeneratedTextExportSnapshotChange(snapshot) {
      textSnapshots.push(snapshot);
    },
    onGeneratedBinaryExportSnapshotChange(snapshot) {
      binarySnapshots.push(snapshot);
    },
  });

  try {
    await act(async () => {
      harness.latest().setFrameHeight(640);
      harness.latest().markHostReady();
      await Promise.resolve();
    });

    assert.equal(harness.latest().bootState, 'ready');
    assert.equal(harness.latest().frameHeight, 640);

    await harness.update({ runtimeFrameRevision: 'rev-2' });

    assert.equal(harness.latest().bootState, 'waiting');
    assert.equal(
      harness.latest().frameHeight,
      MIN_ARTIFACT_RUNTIME_FRAME_HEIGHT,
    );
    assert.deepEqual(textSnapshots, [null, null, null]);
    assert.deepEqual(binarySnapshots, [null, null, null]);
  } finally {
    harness.unmount();
  }

  assert.deepEqual(textSnapshots, [null, null, null, null]);
  assert.deepEqual(binarySnapshots, [null, null, null, null]);
});
