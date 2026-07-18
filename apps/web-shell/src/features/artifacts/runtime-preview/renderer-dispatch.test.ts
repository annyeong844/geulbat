import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { brandThreadId } from '../../../lib/id-brand-helpers.js';
import type {
  GeneratedBinaryExportSnapshot,
  GeneratedTextExportSnapshot,
  ResolvedArtifactSourceRef,
} from '../artifact-types.js';
import type {
  ArtifactRuntimeFrameRenderArgs,
  ArtifactRuntimePreviewContext,
  RenderArtifactRuntimeFrame,
} from './types.js';
import { resolveArtifactRuntimePreview } from './renderer-dispatch.js';

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

function createPreviewContext(
  overrides: Partial<ArtifactRuntimePreviewContext> = {},
): ArtifactRuntimePreviewContext {
  return {
    digest: 'fixture',
    state: 'completed',
    isStreamingPreview: false,
    sourceRef: createResolvedSourceRef({
      workingDirectory: 'stories/sample',
      threadId: brandThreadId('00000000-0000-4000-8000-000000000001'),
    }),
    ...overrides,
  };
}

const renderRuntimeFrame: RenderArtifactRuntimeFrame = (args) => {
  return createElement('iframe', {
    sandbox: args.sandbox,
    src: `http://127.0.0.1:3456/artifact-runtime/host?renderer=${args.renderer}&rev=fake`,
    title: args.title,
  });
};

void test('resolveArtifactRuntimePreview rejects unsafe html before rendering a runtime frame', () => {
  let renderCallCount = 0;
  const preview = resolveArtifactRuntimePreview({
    renderer: 'html5',
    payload:
      '<a href="javascript:alert(1)">bad</a><img src="file:///tmp/unsafe-preview.png" alt="bad">',
    context: createPreviewContext(),
    renderRuntimeFrame(args) {
      renderCallCount += 1;
      return renderRuntimeFrame(args);
    },
  });

  assert.equal(renderCallCount, 0);
  assert.equal(preview.kind, 'unavailable');
  assert.equal(preview.code, 'sanitize_rejected');
  assert.match(preview.detail, /javascript: URL/);
});

void test('resolveArtifactRuntimePreview keeps streaming html pending while style is still unclosed', () => {
  const preview = resolveArtifactRuntimePreview({
    renderer: 'html5',
    payload:
      '<!doctype html><html><head><style>body{color:red;}<body><section>hello</section></body></html>',
    context: createPreviewContext({
      digest: 'page',
      state: 'streaming',
      isStreamingPreview: true,
      sourceRef: createResolvedSourceRef(),
    }),
    renderRuntimeFrame,
  });

  assert.equal(preview.kind, 'pending');
  assert.equal(
    preview.detail,
    '안정적인 문서 본문이 들어오면 미리보기가 이어집니다.',
  );
});

void test('resolveArtifactRuntimePreview keeps svg gradient/filter/fragment html5 fixtures rendered', () => {
  const preview = resolveArtifactRuntimePreview({
    renderer: 'html5',
    payload: [
      '<svg viewBox="0 0 200 200" xmlns="http://www.w3.org/2000/svg">',
      '<defs>',
      '<linearGradient id="g"><stop offset="0%" stop-color="#ff9fbc"/><stop offset="100%" stop-color="#ff4f86"/></linearGradient>',
      '<filter id="shadow"><feDropShadow dx="0" dy="6" stdDeviation="6" flood-opacity="0.25"/></filter>',
      '</defs>',
      '<path fill="url(#g)" filter="url(#shadow)" d="M100 180 C95 175, 35 130, 35 78 C35 50, 56 34, 79 34 C92 34, 102 41, 100 55 C98 41, 108 34, 121 34 C144 34, 165 50, 165 78 C165 130, 105 175, 100 180Z"/>',
      '</svg>',
    ].join(''),
    context: createPreviewContext(),
    renderRuntimeFrame,
  });

  assert.equal(preview.kind, 'rendered');
  const html = renderToStaticMarkup(preview.node);
  assert.match(html, /<iframe/);
  assert.match(html, /sandbox="allow-scripts allow-forms allow-same-origin"/);
  assert.match(html, /renderer=html5&amp;rev=fake/);
});

void test('resolveArtifactRuntimePreview keeps ordinary external stylesheet and asset html5 fixtures rendered', () => {
  const preview = resolveArtifactRuntimePreview({
    renderer: 'html5',
    payload: [
      '<!doctype html><html><head>',
      '<link rel="preconnect" href="https://assets.geulbat-fixtures.local">',
      '<link rel="stylesheet" href="https://assets.geulbat-fixtures.local/fonts/nanum-gothic-700.css">',
      '<script src="https://fixtures.geulbat.local/vendor/tailwindcss-cdn-3.4.13.js"></script>',
      '</head><body class="bg-pink-50">',
      '<img src="https://assets.geulbat-fixtures.local/images/sample-cat-320.jpg" alt="sample">',
      '</body></html>',
    ].join(''),
    context: createPreviewContext(),
    renderRuntimeFrame,
  });

  assert.equal(preview.kind, 'rendered');
  const html = renderToStaticMarkup(preview.node);
  assert.match(html, /<iframe/);
  assert.doesNotMatch(html, /sanitize_rejected/);
  assert.match(html, /sandbox="allow-scripts allow-forms allow-same-origin"/);
  assert.match(html, /renderer=html5&amp;rev=fake/);
});

void test('resolveArtifactRuntimePreview keeps data-url image and script html5 fixtures rendered', () => {
  const preview = resolveArtifactRuntimePreview({
    renderer: 'html5',
    payload: [
      '<!doctype html><html><body>',
      `<img id="heart" alt="heart" src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 20 20'%3E%3Ccircle cx='10' cy='10' r='8' fill='%23ff5e8f'/%3E%3C/svg%3E">`,
      '<div id="status">loading</div>',
      `<script src="data:text/javascript,document.getElementById('status').textContent='ready';"></script>`,
      '</body></html>',
    ].join(''),
    context: createPreviewContext(),
    renderRuntimeFrame,
  });

  assert.equal(preview.kind, 'rendered');
  const html = renderToStaticMarkup(preview.node);
  assert.match(html, /<iframe/);
  assert.doesNotMatch(html, /sanitize_rejected/);
  assert.match(html, /sandbox="allow-scripts allow-forms allow-same-origin"/);
  assert.match(html, /renderer=html5&amp;rev=fake/);
});

void test('resolveArtifactRuntimePreview preserves generated export callbacks through js dispatch', () => {
  const onGeneratedTextExportSnapshotChange = (
    _snapshot: GeneratedTextExportSnapshot | null,
  ) => undefined;
  const onGeneratedBinaryExportSnapshotChange = (
    _snapshot: GeneratedBinaryExportSnapshot | null,
  ) => undefined;
  const renderedFrameArgs: ArtifactRuntimeFrameRenderArgs[] = [];
  const preview = resolveArtifactRuntimePreview({
    renderer: 'js',
    payload: 'document.body.textContent = "hello";',
    context: createPreviewContext({
      onGeneratedTextExportSnapshotChange,
      onGeneratedBinaryExportSnapshotChange,
    }),
    renderRuntimeFrame(args) {
      renderedFrameArgs.push(args);
      return renderRuntimeFrame(args);
    },
  });

  assert.equal(preview.kind, 'rendered');
  assert.equal(renderedFrameArgs.length, 1);
  const frameArgs = renderedFrameArgs[0];
  if (frameArgs === undefined) {
    assert.fail('expected runtime frame render args');
  }
  assert.equal(frameArgs.renderer, 'js');
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
  assert.match(
    html,
    /sandbox="allow-scripts allow-forms allow-same-origin allow-downloads"/,
  );
});
