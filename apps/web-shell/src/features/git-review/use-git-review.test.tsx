import assert from 'node:assert/strict';
import test from 'node:test';
import TestRenderer, { act, type ReactTestRenderer } from 'react-test-renderer';
import type {
  GitReviewFileResult,
  GitReviewFileSummary,
  GitReviewReleaseRequest,
  GitReviewSummaryResult,
} from '@geulbat/protocol/git-review';

import {
  fileSignature,
  useGitReview,
  type GitReviewClient,
  type GitReviewController,
} from './use-git-review.js';

(
  globalThis as typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
  }
).IS_REACT_ACT_ENVIRONMENT = true;

void test('refresh identity uses the ordered layer paths rather than displayPath', () => {
  const first = fileSummary('file-1', 'same-label.ts');
  const second = fileSummary('file-2', 'same-label.ts');
  assert.ok(second.layers[0]);
  second.layers[0].beforeDisplayPath = 'before.ts';
  second.layers[0].afterDisplayPath = 'after.ts';
  assert.notEqual(fileSignature(first), fileSignature(second));
});

void test('no cwd, clean, and non-Git targets stay quiet', async () => {
  const requests: string[] = [];
  const client: GitReviewClient = {
    async fetchSummary(request) {
      assert.equal(request.kind, 'start');
      requests.push(request.workingDirectory);
      if (request.workingDirectory === '/clean') {
        return {
          kind: 'clean',
          repositoryRoot: '/clean',
          branch: { name: 'main', detached: false, headOid: 'a'.repeat(40) },
          observedAt: '2026-07-29T00:00:00.000Z',
        };
      }
      return { kind: 'not_reviewable', reason: 'not_repository' };
    },
    async fetchFile() {
      throw new Error('not called');
    },
    async release() {
      return { kind: 'released' };
    },
  };
  let current!: GitReviewController;
  let renderer!: ReactTestRenderer;

  await act(async () => {
    renderer = TestRenderer.create(
      <Harness
        workingDirectory={null}
        reviewOpen={false}
        refreshGeneration={0}
        client={client}
        onRender={(controller) => {
          current = controller;
        }}
      />,
    );
    await flushEffects();
  });
  assert.deepEqual(requests, []);
  assert.equal(current.summary, null);
  assert.equal(current.summaryError, null);

  for (const workingDirectory of ['', '/clean', '/ordinary']) {
    await act(async () => {
      renderer.update(
        <Harness
          workingDirectory={workingDirectory}
          reviewOpen={false}
          refreshGeneration={0}
          client={client}
          onRender={(controller) => {
            current = controller;
          }}
        />,
      );
      await flushEffects();
    });
    assert.equal(current.changedSummary, null);
    assert.equal(current.summaryError, null);
  }
  assert.deepEqual(requests, ['', '/clean', '/ordinary']);
  act(() => renderer.unmount());
});

void test('working-directory generations discard older summary responses and keep background failures quiet', async () => {
  const first = deferred<GitReviewSummaryResult>();
  const requests: Array<{ workingDirectory: string; signal?: AbortSignal }> =
    [];
  const client: GitReviewClient = {
    async fetchSummary(request, signal) {
      assert.equal(request.kind, 'start');
      requests.push({
        workingDirectory: request.workingDirectory,
        ...(signal === undefined ? {} : { signal }),
      });
      if (request.workingDirectory === '/repo-a') {
        return first.promise;
      }
      if (request.workingDirectory === '/repo-b') {
        return changedSummary('observation-b', 'b');
      }
      throw new Error('background failure');
    },
    async fetchFile() {
      throw new Error('not called');
    },
    async release() {
      return { kind: 'released' };
    },
  };
  let current!: GitReviewController;
  let renderer!: ReactTestRenderer;

  await act(async () => {
    renderer = TestRenderer.create(
      <Harness
        workingDirectory="/repo-a"
        reviewOpen={false}
        refreshGeneration={0}
        client={client}
        onRender={(controller) => {
          current = controller;
        }}
      />,
    );
    await flushEffects();
  });
  assert.equal(current.summaryLoading, true);

  await act(async () => {
    renderer.update(
      <Harness
        workingDirectory="/repo-b"
        reviewOpen={false}
        refreshGeneration={0}
        client={client}
        onRender={(controller) => {
          current = controller;
        }}
      />,
    );
    await flushEffects();
  });
  assert.equal(current.changedSummary?.observationId, 'observation-b');
  assert.equal(requests[0]?.signal?.aborted, true);

  await act(async () => {
    first.resolve(changedSummary('observation-a', 'a'));
    await flushEffects();
  });
  assert.equal(current.changedSummary?.observationId, 'observation-b');

  await act(async () => {
    renderer.update(
      <Harness
        workingDirectory="/repo-c"
        reviewOpen={false}
        refreshGeneration={0}
        client={client}
        onRender={(controller) => {
          current = controller;
        }}
      />,
    );
    await flushEffects();
  });
  assert.equal(current.summary, null);
  assert.equal(current.summaryError, null);
  act(() => renderer.unmount());
});

void test('target switch clears file state and ignores an older rejected file request even when release delivery fails', async () => {
  const oldFile = deferred<GitReviewFileResult>();
  const nextSummary = deferred<GitReviewSummaryResult>();
  const fileSignals: AbortSignal[] = [];
  const releaseCalls: string[] = [];
  const client: GitReviewClient = {
    async fetchSummary(request) {
      assert.equal(request.kind, 'start');
      return request.workingDirectory === '/repo-a'
        ? changedSummary('observation-a', 'a')
        : nextSummary.promise;
    },
    async fetchFile(request, signal) {
      if (signal !== undefined) {
        fileSignals.push(signal);
      }
      return request.observationId === 'observation-a'
        ? oldFile.promise
        : readyFile(
            request.observationId,
            request.fileId,
            `capture-${request.fileId}`,
            'new repository row',
            null,
          );
    },
    async release(request) {
      releaseCalls.push(releaseLabel(request));
      throw new Error('simulated lost release response');
    },
  };
  let current!: GitReviewController;
  let renderer!: ReactTestRenderer;

  await act(async () => {
    renderer = TestRenderer.create(
      <Harness
        workingDirectory="/repo-a"
        reviewOpen
        refreshGeneration={0}
        client={client}
        onRender={(controller) => {
          current = controller;
        }}
      />,
    );
    await flushEffects();
  });
  assert.equal(current.fileLoading, true);
  assert.equal(current.selectedFile?.displayPath, 'src/first.ts');

  await act(async () => {
    renderer.update(
      <Harness
        workingDirectory="/repo-b"
        reviewOpen
        refreshGeneration={0}
        client={client}
        onRender={(controller) => {
          current = controller;
        }}
      />,
    );
    await flushEffects();
  });
  assert.equal(fileSignals[0]?.aborted, true);
  assert.equal(current.summary, null);
  assert.equal(current.selectedFile, null);
  assert.equal(current.file, null);
  assert.equal(current.fileError, null);

  await act(async () => {
    oldFile.reject(new Error('old file failed after target switch'));
    nextSummary.resolve(changedSummary('observation-b', 'b'));
    await flushEffects();
  });
  assert.equal(current.changedSummary?.observationId, 'observation-b');
  assertReadyFile(current, 'observation-b', 'new repository row');
  assert.equal(current.fileError, null);
  const selectedFileId = current.selectedFileId;
  await act(async () => {
    renderer.unmount();
    await flushEffects();
  });
  assert.deepEqual(releaseCalls.slice(-2), [
    `release:file:observation-b:capture-${selectedFileId}`,
    'release:summary:observation-b',
  ]);
});

void test('refresh preserves selection by ordered layer paths instead of display label', async () => {
  const oldOther = fileSummary('old-other', 'same-label.ts');
  const oldSelected = fileSummary('old-selected', 'same-label.ts');
  const newOther = fileSummary('new-other', 'same-label.ts');
  const newSelected = fileSummary('new-selected', 'same-label.ts');
  for (const file of [oldSelected, newSelected]) {
    assert.ok(file.layers[0]);
    file.layers[0].beforeDisplayPath = 'before.ts';
    file.layers[0].afterDisplayPath = 'after.ts';
  }
  let summaryCount = 0;
  const client: GitReviewClient = {
    async fetchSummary(request) {
      assert.equal(request.kind, 'start');
      summaryCount += 1;
      return {
        ...changedSummary(`observation-${String(summaryCount)}`, 'unused'),
        files: {
          items:
            summaryCount === 1
              ? [oldOther, oldSelected]
              : [newOther, newSelected],
          nextCursor: null,
        },
      };
    },
    async fetchFile(request) {
      assert.equal(request.kind, 'start');
      return readyFile(
        request.observationId,
        request.fileId,
        `capture-${request.fileId}`,
        request.fileId,
        null,
      );
    },
    async release() {
      return { kind: 'released' };
    },
  };
  let current!: GitReviewController;
  let renderer!: ReactTestRenderer;

  await act(async () => {
    renderer = TestRenderer.create(
      <Harness
        workingDirectory="/repo"
        reviewOpen
        refreshGeneration={0}
        client={client}
        onRender={(controller) => {
          current = controller;
        }}
      />,
    );
    await flushEffects();
  });
  await act(async () => {
    current.selectFile(oldSelected.fileId);
    await flushEffects();
  });
  assert.equal(current.selectedFileId, oldSelected.fileId);

  await act(async () => {
    current.refresh();
    await flushEffects();
  });
  assert.equal(current.selectedFileId, newSelected.fileId);
  assert.equal(current.file?.fileId, newSelected.fileId);
  act(() => renderer.unmount());
});

void test('selecting the current file does not recapture or release it', async () => {
  const calls: string[] = [];
  const client: GitReviewClient = {
    async fetchSummary() {
      return changedSummary('observation-1', 'same');
    },
    async fetchFile(request) {
      assert.equal(request.kind, 'start');
      calls.push(`file:start:${request.fileId}`);
      return readyFile(
        request.observationId,
        request.fileId,
        `capture-${request.fileId}`,
        request.fileId,
        null,
      );
    },
    async release(request) {
      calls.push(releaseLabel(request));
      return { kind: 'released' };
    },
  };
  let current!: GitReviewController;
  let renderer!: ReactTestRenderer;

  await act(async () => {
    renderer = TestRenderer.create(
      <Harness
        workingDirectory="/repo"
        reviewOpen
        refreshGeneration={0}
        client={client}
        onRender={(controller) => {
          current = controller;
        }}
      />,
    );
    await flushEffects();
  });
  const selectedFileId = current.selectedFileId;
  assert.ok(selectedFileId);
  const callsBeforeReselection = [...calls];

  await act(async () => {
    current.selectFile(selectedFileId);
    await flushEffects();
  });
  assert.deepEqual(calls, callsBeforeReselection);
  act(() => renderer.unmount());
});

void test('a lost file release response does not delay the next selection', async () => {
  const releaseGate = deferred<{ kind: 'released' }>();
  const calls: string[] = [];
  const client: GitReviewClient = {
    async fetchSummary() {
      return changedSummary('observation-1', 'release');
    },
    async fetchFile(request) {
      assert.equal(request.kind, 'start');
      calls.push(`file:start:${request.fileId}`);
      return readyFile(
        request.observationId,
        request.fileId,
        `capture-${request.fileId}`,
        request.fileId,
        null,
      );
    },
    async release(request) {
      calls.push(releaseLabel(request));
      return request.kind === 'file'
        ? releaseGate.promise
        : { kind: 'released' };
    },
  };
  let current!: GitReviewController;
  let renderer!: ReactTestRenderer;

  await act(async () => {
    renderer = TestRenderer.create(
      <Harness
        workingDirectory="/repo"
        reviewOpen
        refreshGeneration={0}
        client={client}
        onRender={(controller) => {
          current = controller;
        }}
      />,
    );
    await flushEffects();
  });
  const secondFile = current.changedSummary?.files.items[1];
  assert.ok(secondFile);

  await act(async () => {
    current.selectFile(secondFile.fileId);
    await flushEffects();
  });
  assert.equal(
    calls.includes(`file:start:${secondFile.fileId}`),
    true,
    'the next capture should start while the best-effort release is pending',
  );
  assert.equal(current.file?.fileId, secondFile.fileId);

  await act(async () => {
    releaseGate.resolve({ kind: 'released' });
    await flushEffects();
    renderer.unmount();
  });
});

void test('open and close reuse the captured observation while paging and selection stay immutable', async () => {
  const calls: string[] = [];
  let summaryStartCount = 0;
  const client: GitReviewClient = {
    async fetchSummary(request) {
      if (request.kind === 'continue') {
        calls.push(`summary:continue:${request.observationId}`);
        return {
          ...changedSummary(request.observationId, 'continued'),
          files: {
            items: [
              fileSummary(`file-1-${summaryStartCount}`, 'src/first.ts'),
              fileSummary('file-3-page', 'src/third.ts'),
            ],
            nextCursor: null,
          },
        };
      }
      summaryStartCount += 1;
      const observationId = `observation-${summaryStartCount}`;
      calls.push(`summary:start:${observationId}`);
      return changedSummary(observationId, String(summaryStartCount));
    },
    async fetchFile(request) {
      if (request.kind === 'continue') {
        calls.push(`file:continue:${request.fileObservationId}`);
        return readyFile(
          request.observationId,
          request.fileId,
          request.fileObservationId,
          'continued row',
          null,
        );
      }
      const fileObservationId = `capture-${request.fileId}`;
      calls.push(`file:start:${request.fileId}`);
      return readyFile(
        request.observationId,
        request.fileId,
        fileObservationId,
        'first row',
        'rows-next',
      );
    },
    async release(request) {
      calls.push(releaseLabel(request));
      return { kind: 'released' };
    },
  };
  let current!: GitReviewController;
  let renderer!: ReactTestRenderer;

  await act(async () => {
    renderer = TestRenderer.create(
      <Harness
        workingDirectory="/repo"
        reviewOpen={false}
        refreshGeneration={0}
        client={client}
        onRender={(controller) => {
          current = controller;
        }}
      />,
    );
    await flushEffects();
  });
  assert.equal(current.changedSummary?.observationId, 'observation-1');
  assert.equal(
    calls.some((call) => call.startsWith('file:start:')),
    false,
  );

  await act(async () => {
    renderer.update(
      <Harness
        workingDirectory="/repo"
        reviewOpen
        refreshGeneration={0}
        client={client}
        onRender={(controller) => {
          current = controller;
        }}
      />,
    );
    await flushEffects();
  });
  assert.equal(current.changedSummary?.observationId, 'observation-1');
  assert.equal(current.selectedFile?.displayPath, 'src/first.ts');
  assert.equal(current.file?.rows.items[0]?.content, 'first row');
  const firstFileId = current.selectedFileId;
  assert.ok(firstFileId);
  assert.deepEqual(calls.slice(1), [`file:start:${current.selectedFileId}`]);

  await act(async () => {
    current.loadMoreSummary();
    await flushEffects();
  });
  assert.equal(current.changedSummary?.files.items.length, 3);

  const secondFile = current.changedSummary?.files.items.find(
    (file) => file.displayPath === 'src/second.ts',
  );
  assert.ok(secondFile);
  const summaryReleaseCountBeforeSelection = calls.filter((call) =>
    call.startsWith('release:summary:'),
  ).length;
  await act(async () => {
    current.selectFile(secondFile.fileId);
    await flushEffects();
  });
  assert.equal(current.selectedFile?.displayPath, 'src/second.ts');
  assert.equal(current.file?.fileId, secondFile.fileId);
  assert.equal(current.file?.rows.items.length, 1);
  assert.equal(
    calls.filter((call) => call.startsWith('release:summary:')).length,
    summaryReleaseCountBeforeSelection,
  );
  assert.equal(
    calls.find((call) => call.startsWith('release:file:')) ?? '',
    `release:file:observation-1:capture-${firstFileId}`,
  );

  await act(async () => {
    current.loadMoreFile();
    await flushEffects();
  });
  assert.deepEqual(
    current.file?.rows.items.map((row) => row.content),
    ['first row', 'continued row'],
  );

  const beforeClose = calls.length;
  await act(async () => {
    renderer.update(
      <Harness
        workingDirectory="/repo"
        reviewOpen={false}
        refreshGeneration={0}
        client={client}
        onRender={(controller) => {
          current = controller;
        }}
      />,
    );
    await flushEffects();
  });
  assert.deepEqual(calls.slice(beforeClose), []);
  assert.equal(current.changedSummary?.observationId, 'observation-1');

  await act(async () => {
    renderer.update(
      <Harness
        workingDirectory="/repo"
        reviewOpen
        refreshGeneration={0}
        client={client}
        onRender={(controller) => {
          current = controller;
        }}
      />,
    );
    await flushEffects();
  });
  assert.deepEqual(calls.slice(beforeClose), []);
  assert.equal(current.file?.fileId, secondFile.fileId);

  act(() => renderer.unmount());
  assert.deepEqual(calls.slice(beforeClose), [
    `release:file:observation-1:capture-${secondFile.fileId}`,
    'release:summary:observation-1',
  ]);
});

function Harness(props: {
  workingDirectory: string | null;
  reviewOpen: boolean;
  refreshGeneration: number;
  client: GitReviewClient;
  onRender: (controller: GitReviewController) => void;
}) {
  const controller = useGitReview(props);
  props.onRender(controller);
  return null;
}

function changedSummary(
  observationId: string,
  fileIdSuffix: string,
): Extract<GitReviewSummaryResult, { kind: 'changed' }> {
  return {
    kind: 'changed',
    observationId,
    repositoryRoot: '/repo',
    branch: {
      name: 'main',
      detached: false,
      headOid: 'a'.repeat(40),
    },
    totals: {
      fileCount: 2,
      additions: 4,
      deletions: 2,
      lineStatsComplete: true,
    },
    files: {
      items: [
        fileSummary(`file-1-${fileIdSuffix}`, 'src/first.ts'),
        fileSummary(`file-2-${fileIdSuffix}`, 'src/second.ts'),
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

function readyFile(
  observationId: string,
  fileId: string,
  fileObservationId: string,
  content: string,
  nextCursor: string | null,
): Extract<GitReviewFileResult, { kind: 'ready' }> {
  return {
    kind: 'ready',
    observationId,
    fileObservationId,
    fileId,
    sections: [
      {
        sectionId: 'section-1',
        layerId: `layer-${fileId}`,
        comparison: 'unstaged',
        projection: 'text',
        metadataReason: null,
      },
    ],
    rows: {
      items: [
        {
          sectionId: 'section-1',
          kind: 'context',
          oldLine: 1,
          newLine: 1,
          content,
        },
      ],
      nextCursor,
    },
    capturedAt: '2026-07-29T00:00:00.000Z',
  };
}

function releaseLabel(request: GitReviewReleaseRequest): string {
  return request.kind === 'file'
    ? `release:file:${request.observationId}:${request.fileObservationId}`
    : `release:summary:${request.observationId}`;
}

function assertReadyFile(
  controller: GitReviewController,
  observationId: string,
  firstRowContent: string,
): void {
  assert.ok(controller.file);
  assert.equal(controller.file.observationId, observationId);
  assert.equal(controller.file.rows.items[0]?.content, firstRowContent);
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((complete, fail) => {
    resolve = complete;
    reject = fail;
  });
  return { promise, reject, resolve };
}

async function flushEffects(): Promise<void> {
  for (let index = 0; index < 8; index += 1) {
    await Promise.resolve();
  }
}
