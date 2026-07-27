import test from 'node:test';
import assert from 'node:assert/strict';
import { act, type ReactTestRenderer } from 'react-test-renderer';

import { renderComposer } from '../../test-support/assistant-composer-harness.js';

void test('context usage ring starts at a zero-percent baseline before the first exact measurement', async () => {
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = renderComposer(undefined);
  });

  const ring = renderer.root.findByProps({ className: 'context-usage-ring' });
  assert.equal(ring.props['data-state'], 'unknown');
  assert.equal(ring.props['data-percentage'], '0');
  assert.equal(ring.props.title, '컨텍스트 0%');

  await act(async () => {
    renderer.unmount();
  });
});

void test('context usage ring shows exact progress toward the compaction threshold', async () => {
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = renderComposer(undefined, {
      state: 'measured',
      quality: 'exact',
      modelId: 'gpt-5.6-sol',
      inputTokens: 122_400,
      contextWindow: 272_000,
      thresholdTokens: 244_800,
      requestBytes: 510_000,
    });
  });

  const ring = renderer.root.findByProps({ className: 'context-usage-ring' });
  assert.equal(ring.props['data-state'], 'measured');
  assert.equal(ring.props['data-percentage'], '50');
  assert.match(ring.props.title, /컨텍스트 50%/u);
  assert.match(ring.props.title, /122,400 \/ 244,800 토큰/u);
  assert.equal(
    ring.findByProps({ className: 'context-usage-ring-value' }).props
      .strokeDashoffset,
    50,
  );

  await act(async () => {
    renderer.unmount();
  });
});

void test('context usage ring labels calibrated request estimates without presenting them as exact', async () => {
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = renderComposer(undefined, {
      state: 'measured',
      quality: 'estimated',
      modelId: 'gpt-5.6-sol',
      inputTokens: 122_400,
      contextWindow: 272_000,
      thresholdTokens: 244_800,
      requestBytes: 510_000,
    });
  });

  const ring = renderer.root.findByProps({ className: 'context-usage-ring' });
  assert.equal(ring.props['data-quality'], 'estimated');
  assert.equal(ring.props['data-percentage'], '50');
  assert.match(ring.props.title, /컨텍스트 추정 50%/u);

  await act(async () => {
    renderer.unmount();
  });
});

void test('context usage ring shows an honest pending state when no calibrated estimate exists', async () => {
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = renderComposer(undefined, {
      state: 'measured',
      quality: 'unknown',
      modelId: 'gpt-5.6-sol',
      requestBytes: 510_000,
    });
  });

  const ring = renderer.root.findByProps({ className: 'context-usage-ring' });
  assert.equal(ring.props['data-state'], 'measured');
  assert.equal(ring.props['data-quality'], 'unknown');
  assert.equal(ring.props['data-percentage'], '0');
  assert.equal(ring.props.title, '컨텍스트 사용량 측정 대기 중');

  await act(async () => {
    renderer.unmount();
  });
});

void test('context usage ring empties only after compaction commit and keeps the prior measurement in its tooltip', async () => {
  const compactedUsage = {
    state: 'compacted',
    quality: 'exact',
    modelId: 'gpt-5.6-sol',
    inputTokens: 244_800,
    contextWindow: 272_000,
    thresholdTokens: 244_800,
    requestBytes: 510_000,
    compactionEntryId: 'compaction-entry-1',
    historyBytesBefore: 65_522,
    historyBytesAfter: 4_003,
  } as const;
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = renderComposer(undefined, compactedUsage);
  });

  const ring = renderer.root.findByProps({ className: 'context-usage-ring' });
  assert.equal(ring.props['data-state'], 'compacted');
  assert.equal(ring.props['data-percentage'], '0');
  assert.equal(
    ring.props.title,
    '컨텍스트 압축 완료 · 직전 100% (244,800 / 244,800 토큰) · 히스토리 65,522 → 4,003 바이트 · 체크포인트 compaction-entry-1',
  );
  assert.doesNotMatch(ring.props.title, /다음 응답/u);
  assert.equal(
    ring.findByProps({ className: 'context-usage-ring-value' }).props
      .strokeDashoffset,
    100,
  );

  await act(async () => {
    renderer.unmount();
  });
});

void test('context usage ring keeps legacy compacted snapshots readable without invented provenance', async () => {
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = renderComposer(undefined, {
      state: 'compacted',
      quality: 'exact',
      modelId: 'gpt-5.6-sol',
      inputTokens: 244_800,
      contextWindow: 272_000,
      thresholdTokens: 244_800,
      requestBytes: 510_000,
    });
  });

  const ring = renderer.root.findByProps({ className: 'context-usage-ring' });
  assert.equal(
    ring.props.title,
    '컨텍스트 압축 완료 · 직전 100% (244,800 / 244,800 토큰)',
  );

  await act(async () => {
    renderer.unmount();
  });
});
