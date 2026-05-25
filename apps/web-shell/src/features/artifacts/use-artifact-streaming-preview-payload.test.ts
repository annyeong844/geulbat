import test from 'node:test';
import assert from 'node:assert/strict';

import { renderHook } from '../../test-support/hook-test.js';
import { useArtifactStreamingPreviewPayload } from './use-artifact-streaming-preview-payload.js';

void test('useArtifactStreamingPreviewPayload throttles html streaming updates', async () => {
  const hook = await renderHook(useArtifactStreamingPreviewPayload, {
    payload: '<html><body>a</body></html>',
    isStreaming: true,
    throttleMs: 25,
  });

  await hook.rerender({
    payload: '<html><body>ab</body></html>',
    isStreaming: true,
    throttleMs: 25,
  });

  assert.equal(hook.result.current, '<html><body>a</body></html>');

  await hook.run(() => new Promise((resolve) => setTimeout(resolve, 40)));

  assert.equal(hook.result.current, '<html><body>ab</body></html>');

  hook.unmount();
});

void test('useArtifactStreamingPreviewPayload commits the final payload immediately when streaming settles', async () => {
  const hook = await renderHook(useArtifactStreamingPreviewPayload, {
    payload: '<html><body>a</body></html>',
    isStreaming: true,
    throttleMs: 25,
  });

  await hook.rerender({
    payload: '<html><body>final</body></html>',
    isStreaming: false,
    throttleMs: 25,
  });

  assert.equal(hook.result.current, '<html><body>final</body></html>');

  hook.unmount();
});

void test('useArtifactStreamingPreviewPayload keeps the last stable html payload during an unclosed style chunk', async () => {
  const canCommitPayload = (payload: string) => {
    const openCount = payload.match(/<style\b/gi)?.length ?? 0;
    const closeCount = payload.match(/<\/style\s*>/gi)?.length ?? 0;
    return openCount <= closeCount;
  };
  const hook = await renderHook(useArtifactStreamingPreviewPayload, {
    payload:
      '<!doctype html><html><body><section>stable</section></body></html>',
    isStreaming: true,
    throttleMs: 25,
    shouldCommitPayload: canCommitPayload,
  });

  await hook.rerender({
    payload:
      '<!doctype html><html><head><style>body{color:red;}<body><section>unstable</section></body></html>',
    isStreaming: true,
    throttleMs: 25,
    shouldCommitPayload: canCommitPayload,
  });

  await hook.run(() => new Promise((resolve) => setTimeout(resolve, 40)));

  assert.equal(
    hook.result.current,
    '<!doctype html><html><body><section>stable</section></body></html>',
  );

  hook.unmount();
});
