import assert from 'node:assert/strict';
import test from 'node:test';
import TestRenderer, {
  act,
  type ReactTestInstance,
  type ReactTestRenderer,
} from 'react-test-renderer';
import type {
  GitReviewFileSummary,
  GitReviewSummaryResult,
} from '@geulbat/protocol/git-review';

import {
  GitReviewSummaryTrigger,
  GitReviewSurface,
} from './GitReviewSurface.js';
import type { GitReviewController } from './use-git-review.js';

(
  globalThis as typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
  }
).IS_REACT_ACT_ENVIRONMENT = true;

void test('quiet trigger renders only a compact changed summary with complete totals', () => {
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = TestRenderer.create(
      <GitReviewSummaryTrigger
        summary={changedSummary()}
        disabled={false}
        onOpen={() => undefined}
      />,
    );
  });

  assert.match(renderedText(renderer.root), /2개 파일 변경됨/);
  assert.match(renderedText(renderer.root), /\+7 −3/);
  assert.doesNotMatch(renderedText(renderer.root), /src\/first\.ts/);

  act(() => {
    renderer.update(
      <GitReviewSummaryTrigger
        summary={{
          ...changedSummary(),
          totals: {
            fileCount: 2,
            additions: null,
            deletions: null,
            lineStatsComplete: false,
          },
        }}
        disabled={false}
        onOpen={() => undefined}
      />,
    );
  });
  assert.doesNotMatch(renderedText(renderer.root), /\+7 −3/);

  act(() => {
    renderer.update(
      <GitReviewSummaryTrigger
        summary={null}
        disabled={false}
        onOpen={() => undefined}
      />,
    );
  });
  assert.equal(renderer.toJSON(), null);
  act(() => renderer.unmount());
});

void test('review surface filters loaded files and selects by opaque file id', () => {
  const selected: string[] = [];
  const controller = controllerStub();
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = TestRenderer.create(
      <GitReviewSurface
        controller={{
          ...controller,
          selectFile: (fileId) => selected.push(fileId),
        }}
        onClose={() => undefined}
      />,
    );
  });

  assert.match(renderedText(renderer.root), /src\/first\.ts/);
  assert.match(renderedText(renderer.root), /src\/second\.ts/);
  assert.match(renderedText(renderer.root), /변경 파일2/);
  assert.match(renderedText(renderer.root), /필터는 지금까지 불러온 파일/);

  act(() => {
    renderer.root
      .findByProps({ placeholder: '파일 필터링…' })
      .props.onChange({ currentTarget: { value: 'second' } });
  });
  const filteredList = renderer.root.findByProps({
    'aria-label': '변경 파일 목록',
  });
  assert.doesNotMatch(renderedText(filteredList), /src\/first\.ts/);
  assert.match(renderedText(filteredList), /src\/second\.ts/);

  act(() => {
    renderer.root.findByProps({ role: 'option' }).props.onClick();
  });
  assert.deepEqual(selected, ['file-2']);
  act(() => renderer.unmount());
});

void test('review surface explains metadata-only and conflict sections without relying on color', () => {
  const controller = controllerStub();
  assert.ok(controller.file);
  const file: NonNullable<GitReviewController['file']> = {
    ...controller.file,
    sections: [
      {
        sectionId: 'section-binary',
        layerId: 'layer-1',
        comparison: 'staged',
        projection: 'metadata_only',
        metadataReason: 'binary',
      },
      {
        sectionId: 'section-conflict',
        layerId: 'layer-2',
        comparison: 'conflict',
        projection: 'conflict',
        metadataReason: null,
      },
      {
        sectionId: 'section-filtered',
        layerId: 'layer-3',
        comparison: 'unstaged',
        projection: 'metadata_only',
        metadataReason: 'filtered_content_unsupported',
      },
      {
        sectionId: 'section-special',
        layerId: 'layer-4',
        comparison: 'untracked',
        projection: 'metadata_only',
        metadataReason: 'special_file',
      },
      {
        sectionId: 'section-transform',
        layerId: 'layer-5',
        comparison: 'unstaged',
        projection: 'metadata_only',
        metadataReason: 'unsupported_content_transformation',
      },
      {
        sectionId: 'section-safe-read',
        layerId: 'layer-6',
        comparison: 'unstaged',
        projection: 'metadata_only',
        metadataReason: 'safe_read_unavailable',
      },
    ],
    rows: { items: [], nextCursor: null },
  };
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = TestRenderer.create(
      <GitReviewSurface
        controller={{ ...controller, file }}
        onClose={() => undefined}
      />,
    );
  });

  assert.match(renderedText(renderer.root), /바이너리 파일/);
  assert.match(renderedText(renderer.root), /병합 충돌/);
  assert.match(renderedText(renderer.root), /실행형 Git 필터/);
  assert.match(renderedText(renderer.root), /특수 파일/);
  assert.match(renderedText(renderer.root), /지원하지 않는 내용 변환/);
  assert.match(renderedText(renderer.root), /안전한 파일 읽기/);
  assert.match(
    renderedText(renderer.root),
    /내용 비교 대신 위 변경 정보를 표시/,
  );
  act(() => renderer.unmount());
});

void test('review surface explains stale and unavailable file observations in text', () => {
  const controller = controllerStub();
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = TestRenderer.create(
      <GitReviewSurface
        controller={{
          ...controller,
          file: null,
          fileIssue: {
            kind: 'stale',
            reason: 'observation_expired',
          },
        }}
        onClose={() => undefined}
      />,
    );
  });
  assert.match(renderedText(renderer.root), /저장소가 변경되어 새 관찰/);

  act(() => {
    renderer.update(
      <GitReviewSurface
        controller={{
          ...controller,
          file: null,
          fileIssue: {
            kind: 'unavailable',
            reason: 'row_exceeds_transport_boundary',
          },
        }}
        onClose={() => undefined}
      />,
    );
  });
  assert.match(renderedText(renderer.root), /부분 결과를 표시하지 않았/);
  act(() => renderer.unmount());
});

void test('review surface explains an exact-content rename with no text rows', () => {
  const controller = controllerStub();
  assert.ok(controller.selectedFile);
  const renamed = {
    ...controller.selectedFile,
    layers: [
      {
        layerId: 'layer-rename',
        comparison: 'unstaged' as const,
        state: 'renamed' as const,
        beforeDisplayPath: 'src/before.ts',
        afterDisplayPath: 'src/after.ts',
        beforeContentKind: 'text' as const,
        afterContentKind: 'text' as const,
      },
    ],
  };
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = TestRenderer.create(
      <GitReviewSurface
        controller={{
          ...controller,
          selectedFile: renamed,
          file: controller.file && {
            ...controller.file,
            rows: { items: [], nextCursor: null },
          },
        }}
        onClose={() => undefined}
      />,
    );
  });

  assert.match(
    renderedText(renderer.root),
    /src\/before\.ts에서 src\/after\.ts\(으\)로 이름이 바뀌었고 내용은 그대로/,
  );
  act(() => renderer.unmount());
});

function controllerStub(): GitReviewController {
  const summary = changedSummary();
  return {
    summary,
    changedSummary: summary,
    summaryLoading: false,
    summaryLoadingMore: false,
    summaryError: null,
    selectedFileId: 'file-1',
    selectedFile: summary.files.items[0] ?? null,
    file: {
      kind: 'ready',
      observationId: 'observation-1',
      fileObservationId: 'file-observation-1',
      fileId: 'file-1',
      capturedAt: '2026-07-29T00:00:00.000Z',
      sections: [
        {
          sectionId: 'section-1',
          layerId: 'layer-1',
          comparison: 'unstaged',
          projection: 'text',
          metadataReason: null,
        },
      ],
      rows: {
        items: [
          {
            sectionId: 'section-1',
            kind: 'deletion',
            oldLine: 1,
            newLine: null,
            content: 'before',
          },
          {
            sectionId: 'section-1',
            kind: 'addition',
            oldLine: null,
            newLine: 1,
            content: 'after',
          },
        ],
        nextCursor: null,
      },
    },
    fileIssue: null,
    fileLoading: false,
    fileLoadingMore: false,
    fileError: null,
    refresh: () => undefined,
    loadMoreSummary: () => undefined,
    selectFile: () => undefined,
    retrySelectedFile: () => undefined,
    loadMoreFile: () => undefined,
  };
}

function changedSummary(): Extract<
  GitReviewSummaryResult,
  { kind: 'changed' }
> {
  return {
    kind: 'changed',
    observationId: 'observation-1',
    repositoryRoot: '/repo',
    branch: {
      name: 'main',
      detached: false,
      headOid: 'a'.repeat(40),
    },
    totals: {
      fileCount: 2,
      additions: 7,
      deletions: 3,
      lineStatsComplete: true,
    },
    files: {
      items: [
        fileSummary('file-1', 'src/first.ts'),
        fileSummary('file-2', 'src/second.ts'),
      ],
      nextCursor: 'summary-next',
    },
    observedAt: '2026-07-29T00:00:00.000Z',
  };
}

function fileSummary(
  fileId: string,
  displayPath: string,
): GitReviewFileSummary {
  return {
    fileId,
    displayPath,
    staged: false,
    unstaged: true,
    layers: [
      {
        layerId: `layer-${fileId}`,
        comparison: 'unstaged',
        state: 'modified',
        beforeDisplayPath: displayPath,
        afterDisplayPath: displayPath,
        beforeContentKind: 'text',
        afterContentKind: 'text',
      },
    ],
  };
}

function renderedText(node: ReactTestInstance | string): string {
  if (typeof node === 'string') {
    return node;
  }
  return node.children
    .map((child) => renderedText(child as ReactTestInstance | string))
    .join('');
}
