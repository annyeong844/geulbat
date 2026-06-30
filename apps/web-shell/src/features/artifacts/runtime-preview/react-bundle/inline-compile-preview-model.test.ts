import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import {
  brandProjectId,
  brandThreadId,
} from '../../../../lib/id-brand-helpers.js';
import type {
  GeneratedBinaryExportSnapshot,
  GeneratedTextExportSnapshot,
  ResolvedArtifactSourceRef,
} from '../../artifact-types.js';
import type { ArtifactRuntimeFrameRenderArgs } from '../types.js';
import {
  buildInitialReactBundleInlineCompileState,
  buildReactBundleInlineCompilePreviewSurface,
  resolveReactBundlePreviewSeed,
} from './inline-compile-preview-model.js';

const REACT_BUNDLE_ENTRY_URL =
  'https://fixtures.geulbat.local/react-bundle-entry.js';

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

function createSourceRef(): ResolvedArtifactSourceRef {
  return createResolvedSourceRef({
    projectId: brandProjectId('workspace'),
    threadId: brandThreadId('00000000-0000-4000-8000-000000000001'),
  });
}

void test('resolveReactBundlePreviewSeed keeps inline source pending until a compiled manifest arrives', () => {
  const seed = resolveReactBundlePreviewSeed({
    enabled: true,
    payload: JSON.stringify({
      files: {
        'src/App.jsx': 'export default function App() { return null; }',
      },
      entry: 'src/App.jsx',
    }),
  });

  assert.equal(seed.kind, 'inline_source');
  assert.deepEqual(buildInitialReactBundleInlineCompileState(seed), {
    kind: 'pending',
  });

  const preview = buildReactBundleInlineCompilePreviewSurface({
    seed,
    inlineCompileState: { kind: 'pending' },
    sourceRef: createSourceRef(),
    renderRuntimeFrame() {
      assert.fail('pending inline source must not render a runtime frame');
    },
  });

  assert.equal(preview?.kind, 'pending');
  assert.equal(preview.detail, '리액트 번들을 준비하고 있습니다...');
});

void test('buildReactBundleInlineCompilePreviewSurface rejects invalid payloads before runtime-frame rendering', () => {
  const seed = resolveReactBundlePreviewSeed({
    enabled: true,
    payload: '{',
  });
  let renderCallCount = 0;
  const preview = buildReactBundleInlineCompilePreviewSurface({
    seed,
    inlineCompileState: buildInitialReactBundleInlineCompileState(seed),
    sourceRef: createSourceRef(),
    renderRuntimeFrame() {
      renderCallCount += 1;
      return null;
    },
  });

  assert.equal(renderCallCount, 0);
  assert.equal(preview?.kind, 'unavailable');
  assert.equal(preview.code, 'boot_failed');
});

void test('buildReactBundleInlineCompilePreviewSurface preserves generated export callbacks after compile', () => {
  const onGeneratedTextExportSnapshotChange = (
    _snapshot: GeneratedTextExportSnapshot | null,
  ) => undefined;
  const onGeneratedBinaryExportSnapshotChange = (
    _snapshot: GeneratedBinaryExportSnapshot | null,
  ) => undefined;
  const renderedFrameArgs: ArtifactRuntimeFrameRenderArgs[] = [];
  const seed = resolveReactBundlePreviewSeed({
    enabled: true,
    payload: JSON.stringify({
      files: {
        'src/App.jsx': 'export default function App() { return null; }',
      },
      entry: 'src/App.jsx',
    }),
  });
  const preview = buildReactBundleInlineCompilePreviewSurface({
    seed,
    inlineCompileState: {
      kind: 'compiled',
      manifest: {
        entryUrl: REACT_BUNDLE_ENTRY_URL,
      },
    },
    sourceRef: createSourceRef(),
    onGeneratedTextExportSnapshotChange,
    onGeneratedBinaryExportSnapshotChange,
    renderRuntimeFrame(args) {
      renderedFrameArgs.push(args);
      return createElement('iframe', {
        sandbox: args.sandbox,
        src: `http://127.0.0.1:3456/artifact-runtime/host?renderer=${args.renderer}&rev=fixture`,
      });
    },
  });

  assert.equal(preview?.kind, 'rendered');
  assert.equal(renderedFrameArgs.length, 1);
  const frameArgs = renderedFrameArgs[0];
  if (frameArgs === undefined) {
    assert.fail('expected runtime frame render args');
  }
  assert.equal(frameArgs.renderer, 'react_bundle');
  assert.equal(
    frameArgs.onGeneratedTextExportSnapshotChange,
    onGeneratedTextExportSnapshotChange,
  );
  assert.equal(
    frameArgs.onGeneratedBinaryExportSnapshotChange,
    onGeneratedBinaryExportSnapshotChange,
  );
  const html = renderToStaticMarkup(preview.node);
  assert.match(html, /<iframe/);
});

void test('buildReactBundleInlineCompilePreviewSurface rejects compiled manifests with disallowed runtime dependency URLs', () => {
  const renderedFrameArgs: ArtifactRuntimeFrameRenderArgs[] = [];
  const seed = resolveReactBundlePreviewSeed({
    enabled: true,
    payload: JSON.stringify({
      files: {
        'src/App.jsx': 'export default function App() { return null; }',
      },
      entry: 'src/App.jsx',
    }),
  });
  const preview = buildReactBundleInlineCompilePreviewSurface({
    seed,
    inlineCompileState: {
      kind: 'compiled',
      manifest: {
        entryUrl: REACT_BUNDLE_ENTRY_URL,
        runtimeDependencies: {
          importMap: {
            imports: {
              unsafe: 'http://127.0.0.1:3456/artifact-runtime/host',
            },
          },
        },
      },
    },
    sourceRef: createSourceRef(),
    renderRuntimeFrame(args) {
      renderedFrameArgs.push(args);
      return null;
    },
  });

  assert.equal(renderedFrameArgs.length, 0);
  assert.equal(preview?.kind, 'unavailable');
  if (preview?.kind !== 'unavailable') {
    assert.fail('expected unavailable compiled manifest preview');
  }
  assert.equal(preview.code, 'policy_blocked');
  assert.equal(
    preview.detail,
    'react bundle runtime dependency URL points at a shell-owned privileged path',
  );
});

void test('buildReactBundleInlineCompilePreviewSurface renders compiled manifests with generated runtime dependency URLs', () => {
  const renderedFrameArgs: ArtifactRuntimeFrameRenderArgs[] = [];
  const seed = resolveReactBundlePreviewSeed({
    enabled: true,
    payload: JSON.stringify({
      files: {
        'src/App.jsx': 'export default function App() { return null; }',
      },
      entry: 'src/App.jsx',
    }),
  });
  const manifest = {
    entryUrl: REACT_BUNDLE_ENTRY_URL,
    runtimeDependencies: {
      importMap: {
        imports: {
          generated: 'data:text/javascript,export default {}',
        },
      },
      stylesheets: ['file:///tmp/geulbat-runtime-dependency.css'],
    },
  };

  const preview = buildReactBundleInlineCompilePreviewSurface({
    seed,
    inlineCompileState: {
      kind: 'compiled',
      manifest,
    },
    sourceRef: createSourceRef(),
    renderRuntimeFrame(args) {
      renderedFrameArgs.push(args);
      return createElement('iframe', {
        sandbox: args.sandbox,
        src: `http://127.0.0.1:3456/artifact-runtime/host?renderer=${args.renderer}&rev=fixture`,
      });
    },
  });

  assert.equal(preview?.kind, 'rendered');
  assert.equal(renderedFrameArgs.length, 1);
  const frameArgs = renderedFrameArgs[0];
  if (frameArgs === undefined) {
    assert.fail('expected runtime frame render args');
  }
  assert.match(
    frameArgs.runtimePayload,
    /data:text\/javascript,export default \{\}/,
  );
  assert.match(
    frameArgs.runtimePayload,
    /file:\/\/\/tmp\/geulbat-runtime-dependency\.css/,
  );
});
