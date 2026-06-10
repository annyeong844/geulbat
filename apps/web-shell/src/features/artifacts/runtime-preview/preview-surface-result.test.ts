import test from 'node:test';
import assert from 'node:assert/strict';

import type { RuntimeArtifactPreviewRenderer } from '../artifact-renderer-capabilities.js';
import {
  unavailableArtifactPreview,
  type ResolvedArtifactSourceRef,
} from '../artifact-types.js';
import type { ArtifactRuntimePreviewContext } from './types.js';
import { resolveArtifactPanePreviewSurfaceResult } from './preview-surface-result.js';

function createResolvedSourceRef(
  overrides: Partial<ResolvedArtifactSourceRef> = {},
): ResolvedArtifactSourceRef {
  return {
    kind: null,
    projectId: null,
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

function createRuntimeContext(): ArtifactRuntimePreviewContext {
  return {
    digest: 'fixture',
    state: 'completed',
    isStreamingPreview: false,
    sourceRef: createResolvedSourceRef({
      filePath: 'episodes/ch01.md',
      artifactId: 'art_1',
      artifactVersion: 1,
      persistenceEpoch: 0,
    }),
  };
}

void test('resolveArtifactPanePreviewSurfaceResult keeps surface previews and unavailable copy together', () => {
  assert.deepEqual(
    resolveArtifactPanePreviewSurfaceResult(
      {
        kind: 'surface',
        previewSurface: null,
      },
      () => unavailableArtifactPreview('boot_failed', 'unexpected runtime'),
    ),
    {
      previewSurface: null,
      runtimeUnavailableMessage: null,
    },
  );

  const unavailable = unavailableArtifactPreview(
    'boot_failed',
    'inline source manifests with files/entry are unsupported',
  );

  assert.deepEqual(
    resolveArtifactPanePreviewSurfaceResult(
      {
        kind: 'surface',
        previewSurface: unavailable,
      },
      () => unavailableArtifactPreview('boot_failed', 'unexpected runtime'),
    ),
    {
      previewSurface: unavailable,
      runtimeUnavailableMessage:
        '이 react bundle은 inline source compile 단계에서 실패했습니다.',
    },
  );
});

void test('resolveArtifactPanePreviewSurfaceResult delegates runtime models to the injected resolver', () => {
  let resolvedCall: {
    renderer: RuntimeArtifactPreviewRenderer;
    payload: string;
    context: ArtifactRuntimePreviewContext;
  } | null = null;
  const context = createRuntimeContext();
  const result = resolveArtifactPanePreviewSurfaceResult(
    {
      kind: 'runtime',
      renderer: 'js',
      payload: 'document.body.textContent = "hello";',
      context,
    },
    (renderer, payload, receivedContext) => {
      resolvedCall = {
        renderer,
        payload,
        context: receivedContext,
      };
      return unavailableArtifactPreview(
        'sanitize_rejected',
        'javascript: URL is blocked',
      );
    },
  );

  assert.deepEqual(resolvedCall, {
    renderer: 'js',
    payload: 'document.body.textContent = "hello";',
    context,
  });
  assert.equal(result.previewSurface?.kind, 'unavailable');
  assert.equal(
    result.runtimeUnavailableMessage,
    '이 캔버스는 현재 웹쉘 경계를 넘는 링크나 리소스 때문에 바로 열 수 없습니다.',
  );
});
