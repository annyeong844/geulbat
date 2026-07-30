import test from 'node:test';
import assert from 'node:assert/strict';
import { brandThreadId } from '../../lib/id-brand-helpers.js';

import {
  canOverwriteRememberedGeneratedBinaryExport,
  rememberGeneratedBinaryExportTarget,
} from './export/use-generated-binary-export-state.js';
import {
  buildArtifactApplyRunDraftFromAuthority,
  buildArtifactRewriteRunDraft,
  buildArtifactExportRunDraftFromAuthority,
  canBuildGeneratedBinaryExportFromAuthority,
  buildGeneratedTextExportRunDraftFromAuthority,
  deriveGeneratedBinaryExportTargetPathHint,
  deriveGeneratedTextExportTargetPathHint,
} from './artifact-run-drafts.js';
import {
  createArtifactDurabilityIntentSnapshotId,
  createArtifactDurabilitySourceAuthorityKey,
  resolveArtifactDurabilitySourceAuthorityFromResolved,
} from './artifact-durability.js';
import {
  sanitizeGeneratedBinaryExportSnapshot,
  type ResolvedArtifactSourceRef,
} from './artifact-types.js';
import { createCommittedArtifactViewModel } from './artifact-view-model.js';
import type { ThreadArtifactVersion } from '@geulbat/protocol/artifacts';

const THREAD_ID = '00000000-0000-4000-8000-000000000001';
const MESSAGE_TIMESTAMP = '2026-04-04T00:00:00.000Z';
const BRANDED_THREAD_ID = brandThreadId(THREAD_ID);

function createResolvedArtifactSourceRef(
  overrides: Partial<ResolvedArtifactSourceRef> = {},
): ResolvedArtifactSourceRef {
  return {
    kind: 'thread',
    workingDirectory: 'stories/sample',
    threadId: BRANDED_THREAD_ID,
    runId: 'run-1',
    filePath: null,
    messageTimestamp: MESSAGE_TIMESTAMP,
    artifactId: null,
    artifactVersion: null,
    persistenceEpoch: null,
    ...overrides,
  };
}

function createArtifactSourceAuthority(
  overrides: Partial<ResolvedArtifactSourceRef> = {},
  options: { requireFilePath?: boolean } = {},
) {
  return resolveArtifactDurabilitySourceAuthorityFromResolved({
    sourceRef: createResolvedArtifactSourceRef(overrides),
    ...(options.requireFilePath !== undefined
      ? { requireFilePath: options.requireFilePath }
      : {}),
  });
}

function createThreadArtifactVersion(
  overrides: Partial<ThreadArtifactVersion> = {},
): ThreadArtifactVersion {
  return {
    artifactId: 'art_1',
    version: 1,
    parentVersion: null,
    baseVersion: null,
    renderer: 'markdown',
    payload: '# hello',
    digest: '요약',
    contentHash: 'hash',
    createdAt: MESSAGE_TIMESTAMP,
    createdByRunId: 'run-1',
    previewValidation: { ok: true },
    title: null,
    persistenceEpoch: 0,
    sourceRef: {
      kind: 'thread-file',
      workingDirectory: 'stories/sample',
      threadId: BRANDED_THREAD_ID,
      runId: 'run-1',
      filePath: 'episodes/ch01.md',
      messageTimestamp: MESSAGE_TIMESTAMP,
    },
    ...overrides,
  };
}

void test('createCommittedArtifactViewModel exposes apply and export actions for a markdown object', () => {
  const view = createCommittedArtifactViewModel({
    artifact: createThreadArtifactVersion(),
    sourceRef: createResolvedArtifactSourceRef({
      filePath: 'episodes/ch01.md',
    }),
  });

  assert.equal(view.actions.apply.visible, true);
  assert.equal(view.actions.apply.enabled, true);
  assert.equal(view.actions.export.visible, true);
  assert.equal(view.actions.export.enabled, true);
});

void test('createCommittedArtifactViewModel keeps non-markdown previews outside markdown-only actions', () => {
  const renderers = [
    'code',
    'diff',
    'table',
    'html5',
    'js',
    'react_bundle',
  ] as const;

  for (const renderer of renderers) {
    const view = createCommittedArtifactViewModel({
      artifact: createThreadArtifactVersion({ renderer }),
      sourceRef: createResolvedArtifactSourceRef({
        filePath: 'episodes/ch01.md',
      }),
    });

    assert.equal(view.artifact.renderer, renderer);
    assert.equal(view.actions.apply.visible, false);
    assert.equal(view.actions.export.visible, false);
  }
});

void test('rememberGeneratedBinaryExportTarget captures the binary export path and versionToken', () => {
  assert.deepEqual(
    rememberGeneratedBinaryExportTarget({
      path: 'exports/demo.bin',
      versionToken: 'token-1',
    }),
    {
      path: 'exports/demo.bin',
      versionToken: 'token-1',
    },
  );
});

void test('canOverwriteRememberedGeneratedBinaryExport requires exact same-path match and a token', () => {
  assert.equal(
    canOverwriteRememberedGeneratedBinaryExport({
      rememberedTarget: {
        path: 'exports/demo.bin',
        versionToken: 'token-1',
      },
      targetPath: 'exports/demo.bin',
    }),
    true,
  );
  assert.equal(
    canOverwriteRememberedGeneratedBinaryExport({
      rememberedTarget: {
        path: 'exports/demo.bin',
        versionToken: 'token-1',
      },
      targetPath: ' exports/demo.bin ',
    }),
    true,
  );
  assert.equal(
    canOverwriteRememberedGeneratedBinaryExport({
      rememberedTarget: {
        path: 'exports/demo.bin',
        versionToken: '',
      },
      targetPath: 'exports/demo.bin',
    }),
    false,
  );
  assert.equal(
    canOverwriteRememberedGeneratedBinaryExport({
      rememberedTarget: {
        path: 'exports/demo.bin',
        versionToken: 'token-1',
      },
      targetPath: 'exports/other.bin',
    }),
    false,
  );
});

void test('buildArtifactApplyRunDraftFromAuthority produces a top-level run request instead of a write shortcut', () => {
  const artifact = createThreadArtifactVersion();

  const draft = buildArtifactApplyRunDraftFromAuthority({
    artifact,
    sourceAuthority: createArtifactSourceAuthority(
      {
        filePath: 'episodes/ch01.md',
      },
      { requireFilePath: true },
    ),
  });

  assert.ok(draft);
  assert.equal(draft.workingDirectory, 'stories/sample');
  assert.equal(draft.threadId, THREAD_ID);
  assert.equal(draft.currentFile, 'episodes/ch01.md');
  assert.equal(draft.displayPrompt, 'Apply artifact to episodes/ch01.md');
  assert.deepEqual(draft.allowedPublicToolNames, [
    'read_file',
    'write_file',
    'apply_patch',
  ]);
  assert.match(draft.prompt, /Apply this artifact preview to the current file/);
  assert.match(draft.prompt, /Artifact session authority key:/);
  assert.match(draft.prompt, /Explicit durability intent id: intent-/);
  assert.match(draft.prompt, /Source artifact runId: run-1/);
  assert.match(
    draft.prompt,
    /Source artifact message timestamp: 2026-04-04T00:00:00\.000Z/,
  );
  assert.match(draft.prompt, /<artifact_preview>/);
  assert.match(draft.prompt, /renderer: markdown/);
  assert.match(draft.prompt, /digest: 요약/);
  assert.match(draft.prompt, /<artifact_payload>/);
  assert.match(draft.prompt, /# hello/);
  assert.match(draft.prompt, /<\/artifact_payload>/);
  assert.match(draft.prompt, /<\/artifact_preview>/);
});

void test('artifact follow-up runs preserve cwd-free chat mode', () => {
  const draft = buildArtifactApplyRunDraftFromAuthority({
    artifact: createThreadArtifactVersion(),
    sourceAuthority: createArtifactSourceAuthority(
      {
        workingDirectory: '',
        filePath: '/tmp/ch01.md',
      },
      { requireFilePath: true },
    ),
  });

  assert.ok(draft);
  assert.equal(Object.hasOwn(draft, 'workingDirectory'), false);
});

void test('buildArtifactApplyRunDraftFromAuthority requires full artifact session authority and target file context', () => {
  const artifact = createThreadArtifactVersion();

  assert.equal(
    buildArtifactApplyRunDraftFromAuthority({
      artifact,
      sourceAuthority: createArtifactSourceAuthority(
        {
          filePath: 'episodes/ch01.md',
          messageTimestamp: null,
        },
        { requireFilePath: true },
      ),
    }),
    null,
  );
  assert.equal(
    buildArtifactApplyRunDraftFromAuthority({
      artifact,
      sourceAuthority: createArtifactSourceAuthority(
        {
          filePath: null,
        },
        { requireFilePath: true },
      ),
    }),
    null,
  );
});

void test('buildArtifactExportRunDraftFromAuthority requires an explicit target path', () => {
  const artifact = createThreadArtifactVersion();

  assert.equal(
    buildArtifactExportRunDraftFromAuthority({
      artifact,
      sourceAuthority: createArtifactSourceAuthority(),
      targetPath: '',
    }),
    null,
  );

  const draft = buildArtifactExportRunDraftFromAuthority({
    artifact,
    sourceAuthority: createArtifactSourceAuthority({
      filePath: 'episodes/ch01.md',
    }),
    targetPath: 'exports/ch01-preview.md',
  });

  assert.ok(draft);
  assert.equal(draft.workingDirectory, 'stories/sample');
  assert.equal(
    draft.displayPrompt,
    'Export artifact to exports/ch01-preview.md',
  );
  assert.deepEqual(draft.allowedPublicToolNames, [
    'read_file',
    'write_file',
    'apply_patch',
  ]);
  assert.match(draft.prompt, /Artifact session authority key:/);
  assert.match(draft.prompt, /Explicit durability intent id: intent-/);
  assert.match(draft.prompt, /Target export path: exports\/ch01-preview.md/);
  assert.match(draft.prompt, /<artifact_preview>/);
  assert.match(draft.prompt, /renderer: markdown/);
  assert.match(draft.prompt, /digest: 요약/);
  assert.match(draft.prompt, /# hello/);
});

void test('createCommittedArtifactViewModel does not rehydrate a legacy envelope for committed objects', () => {
  const artifact: ThreadArtifactVersion = {
    artifactId: 'art_1',
    version: 1,
    parentVersion: null,
    baseVersion: null,
    renderer: 'markdown',
    payload: '# hello',
    digest: '요약',
    contentHash: 'hash',
    createdAt: '2026-04-04T00:00:00.000Z',
    createdByRunId: 'run-1',
    previewValidation: { ok: true },
    title: null,
    persistenceEpoch: 0,
    sourceRef: {
      kind: 'thread-file',
      workingDirectory: 'stories/sample',
      threadId: BRANDED_THREAD_ID,
      runId: 'run-1',
      filePath: 'episodes/ch01.md',
      messageTimestamp: MESSAGE_TIMESTAMP,
    },
  };

  const view = createCommittedArtifactViewModel({
    artifact,
    sourceRef: createResolvedArtifactSourceRef({
      artifactId: 'art_1',
      artifactVersion: 1,
      persistenceEpoch: 0,
      filePath: 'episodes/ch01.md',
    }),
  });

  assert.equal(view.artifact, artifact);
  assert.equal(view.artifact.payload, '# hello');
  assert.doesNotMatch(view.artifact.payload, /GEULBAT_ARTIFACT/);
});

void test('createCommittedArtifactViewModel hides open-source action when committed source file path is absent', () => {
  const artifact: ThreadArtifactVersion = {
    artifactId: 'art_2',
    version: 1,
    parentVersion: null,
    baseVersion: null,
    renderer: 'markdown',
    payload: '# hello',
    digest: '요약',
    contentHash: 'hash',
    createdAt: '2026-04-04T00:00:00.000Z',
    createdByRunId: 'run-1',
    previewValidation: { ok: true },
    title: null,
    persistenceEpoch: 0,
    sourceRef: {
      kind: 'thread',
      workingDirectory: 'stories/sample',
      threadId: BRANDED_THREAD_ID,
      runId: 'run-1',
      filePath: null,
      messageTimestamp: MESSAGE_TIMESTAMP,
    },
  };

  const view = createCommittedArtifactViewModel({
    artifact,
    sourceRef: createResolvedArtifactSourceRef({
      artifactId: 'art_2',
      artifactVersion: 1,
      persistenceEpoch: 0,
      filePath: null,
    }),
  });

  assert.equal(view.actions.apply.visible, false);
});

void test('buildArtifactExportRunDraftFromAuthority requires full artifact session authority', () => {
  const artifact = createThreadArtifactVersion();

  assert.equal(
    buildArtifactExportRunDraftFromAuthority({
      artifact,
      sourceAuthority: createArtifactSourceAuthority({
        threadId: null,
        runId: null,
        messageTimestamp: null,
      }),
      targetPath: 'exports/ch01-preview.md',
    }),
    null,
  );
});

void test('buildGeneratedTextExportRunDraftFromAuthority requires full artifact session authority and explicit target path', () => {
  assert.equal(
    buildGeneratedTextExportRunDraftFromAuthority({
      snapshot: {
        content: '{"ok":true}',
        mimeType: 'application/json',
        fileNameHint: 'preview.json',
      },
      sourceAuthority: createArtifactSourceAuthority(),
      targetPath: '',
    }),
    null,
  );

  assert.equal(
    buildGeneratedTextExportRunDraftFromAuthority({
      snapshot: {
        content: '{"ok":true}',
        mimeType: 'application/json',
        fileNameHint: 'preview.json',
      },
      sourceAuthority: createArtifactSourceAuthority({
        threadId: null,
        runId: null,
        messageTimestamp: null,
      }),
      targetPath: 'exports/preview.json',
    }),
    null,
  );
  assert.equal(
    buildGeneratedTextExportRunDraftFromAuthority({
      snapshot: {
        content: '{"ok":true}',
        mimeType: 'application/json',
        fileNameHint: 'preview.json',
      },
      sourceAuthority: createArtifactSourceAuthority({
        threadId: null,
        runId: null,
        messageTimestamp: null,
      }),
      targetPath: 'exports/preview.json',
    }),
    null,
  );
});

void test('buildGeneratedTextExportRunDraftFromAuthority creates a top-level run request for text snapshots', () => {
  const draft = buildGeneratedTextExportRunDraftFromAuthority({
    snapshot: {
      content: '{"ok":true}',
      mimeType: 'application/json',
      fileNameHint: 'preview.json',
    },
    sourceAuthority: createArtifactSourceAuthority({
      filePath: 'notes/demo.js',
    }),
    targetPath: 'exports/preview.json',
  });

  assert.ok(draft);
  assert.equal(draft.workingDirectory, 'stories/sample');
  assert.equal(draft.threadId, THREAD_ID);
  assert.equal(draft.currentFile, 'notes/demo.js');
  assert.equal(
    draft.displayPrompt,
    'Export generated asset to exports/preview.json',
  );
  assert.deepEqual(draft.allowedPublicToolNames, [
    'read_file',
    'write_file',
    'apply_patch',
  ]);
  assert.match(draft.prompt, /Artifact session authority key:/);
  assert.match(draft.prompt, /Explicit durability intent id: intent-/);
  assert.match(draft.prompt, /Snapshot mime type: application\/json/);
  assert.match(draft.prompt, /Snapshot file name hint: preview\.json/);
  assert.match(
    draft.prompt,
    /<generated_text_snapshot mimeType="application\/json">/,
  );
});

void test('deriveGeneratedTextExportTargetPathHint sanitizes hint and falls back by mime type', () => {
  assert.equal(
    deriveGeneratedTextExportTargetPathHint({
      snapshot: {
        content: '<svg />',
        mimeType: 'image/svg+xml',
        fileNameHint: 'diagram.svg',
      },
    }),
    'exports/diagram.svg',
  );

  assert.equal(
    deriveGeneratedTextExportTargetPathHint({
      snapshot: {
        content: '{}',
        mimeType: 'application/json',
        fileNameHint: '../escape.json',
      },
    }),
    'exports/artifact-preview.json',
  );
});

void test('deriveGeneratedBinaryExportTargetPathHint sanitizes hint and falls back by blob type', () => {
  assert.equal(
    deriveGeneratedBinaryExportTargetPathHint({
      snapshot: {
        blob: new Blob(['png-bytes'], { type: 'image/png' }),
        fileNameHint: ' preview.png ',
      },
    }),
    'exports/preview.png',
  );

  assert.equal(
    deriveGeneratedBinaryExportTargetPathHint({
      snapshot: {
        blob: new Blob(['bytes'], { type: '' }),
        fileNameHint: '../escape.bin',
      },
    }),
    'exports/artifact-preview.bin',
  );
});

void test('sanitizeGeneratedBinaryExportSnapshot falls back to sanitized File.name when explicit hint is missing or invalid', () => {
  const file = new File(['png-bytes'], ' diagram.png ', {
    type: 'image/png',
    lastModified: 123,
  });

  assert.equal(
    sanitizeGeneratedBinaryExportSnapshot({
      blob: file,
      fileNameHint: null,
    })?.fileNameHint,
    'diagram.png',
  );

  assert.equal(
    sanitizeGeneratedBinaryExportSnapshot({
      blob: file,
      fileNameHint: '../escape.png',
    })?.fileNameHint,
    'diagram.png',
  );
});

void test('deriveGeneratedBinaryExportTargetPathHint prefers explicit sanitized hint before File.name fallback', () => {
  const file = new File(['png-bytes'], 'diagram.png', {
    type: 'image/png',
    lastModified: 999,
  });

  assert.equal(
    deriveGeneratedBinaryExportTargetPathHint({
      snapshot: {
        blob: file,
        fileNameHint: 'cover-final.png',
      },
    }),
    'exports/cover-final.png',
  );

  assert.equal(
    deriveGeneratedBinaryExportTargetPathHint({
      snapshot: {
        blob: file,
        fileNameHint: '../escape.png',
      },
    }),
    'exports/diagram.png',
  );
});

void test('canBuildGeneratedBinaryExportFromAuthority requires source authority and a blob snapshot', () => {
  assert.equal(
    canBuildGeneratedBinaryExportFromAuthority({
      snapshot: {
        blob: new Blob(['bytes'], { type: 'image/png' }),
        fileNameHint: null,
      },
      sourceAuthority: createArtifactSourceAuthority(),
    }),
    true,
  );

  assert.equal(
    canBuildGeneratedBinaryExportFromAuthority({
      snapshot: {
        blob: new Blob(['bytes'], { type: 'image/png' }),
        fileNameHint: null,
      },
      sourceAuthority: createArtifactSourceAuthority({
        threadId: null,
        runId: null,
        messageTimestamp: null,
      }),
    }),
    false,
  );
  assert.equal(
    canBuildGeneratedBinaryExportFromAuthority({
      snapshot: {
        blob: new Blob(['bytes'], { type: 'image/png' }),
        fileNameHint: null,
      },
      sourceAuthority: createArtifactSourceAuthority({
        threadId: null,
        runId: null,
        messageTimestamp: null,
      }),
    }),
    false,
  );
});

void test('artifact durability helpers derive canonical authority and explicit intent ids', () => {
  const authority = createArtifactSourceAuthority(
    {
      filePath: 'notes/demo.md',
    },
    { requireFilePath: true },
  );

  assert.ok(authority);
  assert.equal(
    createArtifactDurabilitySourceAuthorityKey(authority),
    JSON.stringify([
      'stories/sample',
      THREAD_ID,
      'run-1',
      '2026-04-04T00:00:00.000Z',
      'notes/demo.md',
    ]),
  );
  assert.match(
    createArtifactDurabilityIntentSnapshotId({
      action: 'export_markdown',
      sourceAuthority: authority,
      targetPath: 'exports/demo.md',
      artifactDigest: 'fixture',
      artifactPayload: '# hello',
    }),
    /^intent-[0-9a-f]+-[0-9a-f]{32}$/,
  );
});

void test('createCommittedArtifactViewModel hides explicit export when artifact session authority is incomplete', () => {
  const view = createCommittedArtifactViewModel({
    artifact: createThreadArtifactVersion(),
    sourceRef: createResolvedArtifactSourceRef({
      filePath: 'episodes/ch01.md',
      messageTimestamp: null,
    }),
  });

  assert.equal(view.actions.apply.visible, false);
  assert.equal(view.actions.export.visible, false);
});

void test('buildArtifactRewriteRunDraft lets the model route between targeted fix and full rewrite', () => {
  const artifact = {
    artifactId: 'artifact-rewrite-1',
    version: 3,
    renderer: 'html5',
    payload: '<!doctype html><html><body>broken</body></html>',
    title: '펠리컨 카드',
  } as Pick<
    ThreadArtifactVersion,
    'artifactId' | 'version' | 'renderer' | 'payload' | 'title'
  >;

  const draft = buildArtifactRewriteRunDraft({
    artifact,
    threadId: BRANDED_THREAD_ID,
  });
  assert.equal(draft.threadId, BRANDED_THREAD_ID);
  assert.equal(draft.displayPrompt, '아티팩트 다시 만들기 — 펠리컨 카드');
  // 한 프롬프트 안에 두 라우팅이 모두 있고 선택은 모델이 한다
  assert.match(draft.prompt, /route yourself/u);
  assert.match(draft.prompt, /minimal targeted fix/u);
  assert.match(draft.prompt, /rebuild it from scratch/iu);
  assert.match(draft.prompt, /Artifact id: artifact-rewrite-1/u);
  assert.match(draft.prompt, /Current version: 3/u);
  assert.match(draft.prompt, /<artifact_payload>/u);
});
