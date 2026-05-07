import test from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { PUBLIC_WEB_REACT_BUNDLE_COUNTER_ENTRY_PATH } from '@geulbat/protocol/public-web-fixtures';

import {
  resolveArtifactPanePreviewSurfaceResult,
  resolveRuntimeArtifactPreview,
} from './artifact-runtime-preview-adapter.js';
import {
  unavailableArtifactPreview,
  type ResolvedArtifactSourceRef,
} from '../../artifacts/artifact-types.js';
import {
  brandProjectId,
  brandThreadId,
} from '../../../lib/id-brand-helpers.js';

const PUBLIC_CDN_REACT_ENTRY_URL = 'https://cdn.example.com/react-entry.js';

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

function createPreviewContext() {
  return {
    digest: 'fixture',
    state: 'completed' as const,
    isStreamingPreview: false,
    sourceRef: createResolvedSourceRef({
      projectId: brandProjectId('workspace'),
      threadId: brandThreadId('00000000-0000-4000-8000-000000000001'),
    }),
  };
}

void test('resolveRuntimeArtifactPreview keeps streaming html pending while style is still unclosed', () => {
  const preview = resolveRuntimeArtifactPreview(
    'html5',
    '<!doctype html><html><head><style>body{color:red;}<body><section>hello</section></body></html>',
    {
      digest: 'page',
      state: 'streaming',
      isStreamingPreview: true,
      sourceRef: createResolvedSourceRef(),
    },
  );

  assert.equal(preview.kind, 'pending');
  assert.equal(
    preview.detail,
    '안정적인 문서 본문이 들어오면 미리보기가 이어집니다.',
  );
});

void test('resolveRuntimeArtifactPreview keeps svg gradient/filter/fragment html5 fixtures rendered', () => {
  const preview = resolveRuntimeArtifactPreview(
    'html5',
    [
      '<svg viewBox="0 0 200 200" xmlns="http://www.w3.org/2000/svg">',
      '<defs>',
      '<linearGradient id="g"><stop offset="0%" stop-color="#ff9fbc"/><stop offset="100%" stop-color="#ff4f86"/></linearGradient>',
      '<filter id="shadow"><feDropShadow dx="0" dy="6" stdDeviation="6" flood-opacity="0.25"/></filter>',
      '</defs>',
      '<path fill="url(#g)" filter="url(#shadow)" d="M100 180 C95 175, 35 130, 35 78 C35 50, 56 34, 79 34 C92 34, 102 41, 100 55 C98 41, 108 34, 121 34 C144 34, 165 50, 165 78 C165 130, 105 175, 100 180Z"/>',
      '</svg>',
    ].join(''),
    createPreviewContext(),
  );

  assert.equal(preview.kind, 'rendered');
  const html = renderToStaticMarkup(preview.node);
  assert.match(html, /<iframe/);
  assert.match(html, /sandbox="allow-scripts allow-forms allow-same-origin"/);
  assert.match(
    html,
    /src="http:\/\/127\.0\.0\.1:3456\/artifact-runtime\/host\?[^"]*rev=/,
  );
});

void test('resolveRuntimeArtifactPreview keeps ordinary external stylesheet and asset html5 fixtures rendered', () => {
  const preview = resolveRuntimeArtifactPreview(
    'html5',
    [
      '<!doctype html><html><head>',
      '<link rel="preconnect" href="https://assets.geulbat-fixtures.local">',
      '<link rel="stylesheet" href="https://assets.geulbat-fixtures.local/fonts/nanum-gothic-700.css">',
      '<script src="https://fixtures.geulbat.local/vendor/tailwindcss-cdn-3.4.13.js"></script>',
      '</head><body class="bg-pink-50">',
      '<img src="https://assets.geulbat-fixtures.local/images/sample-cat-320.jpg" alt="sample">',
      '</body></html>',
    ].join(''),
    createPreviewContext(),
  );

  assert.equal(preview.kind, 'rendered');
  const html = renderToStaticMarkup(preview.node);
  assert.match(html, /<iframe/);
  assert.doesNotMatch(html, /sanitize_rejected/);
  assert.match(html, /sandbox="allow-scripts allow-forms allow-same-origin"/);
  assert.match(
    html,
    /src="http:\/\/127\.0\.0\.1:3456\/artifact-runtime\/host\?[^"]*rev=/,
  );
});

void test('resolveRuntimeArtifactPreview keeps data-url image and script html5 fixtures rendered', () => {
  const preview = resolveRuntimeArtifactPreview(
    'html5',
    [
      '<!doctype html><html><body>',
      `<img id="heart" alt="heart" src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 20 20'%3E%3Ccircle cx='10' cy='10' r='8' fill='%23ff5e8f'/%3E%3C/svg%3E">`,
      '<div id="status">loading</div>',
      `<script src="data:text/javascript,document.getElementById('status').textContent='ready';"></script>`,
      '</body></html>',
    ].join(''),
    createPreviewContext(),
  );

  assert.equal(preview.kind, 'rendered');
  const html = renderToStaticMarkup(preview.node);
  assert.match(html, /<iframe/);
  assert.doesNotMatch(html, /sanitize_rejected/);
  assert.match(html, /sandbox="allow-scripts allow-forms allow-same-origin"/);
  assert.match(
    html,
    /src="http:\/\/127\.0\.0\.1:3456\/artifact-runtime\/host\?[^"]*rev=/,
  );
});

void test('resolveRuntimeArtifactPreview rejects privileged-scheme html5 fixtures', () => {
  const preview = resolveRuntimeArtifactPreview(
    'html5',
    '<a href="javascript:alert(1)">bad</a><img src="file:///etc/passwd" alt="bad">',
    createPreviewContext(),
  );

  assert.equal(preview.kind, 'unavailable');
  assert.equal(preview.code, 'sanitize_rejected');
  assert.match(preview.detail, /javascript: URL/);
});

void test('resolveRuntimeArtifactPreview renders supported react_bundle fixtures through the runtime iframe', () => {
  const preview = resolveRuntimeArtifactPreview(
    'react_bundle',
    JSON.stringify({
      entryUrl: `https://fixtures.geulbat.local${PUBLIC_WEB_REACT_BUNDLE_COUNTER_ENTRY_PATH}`,
    }),
    createPreviewContext(),
  );

  assert.equal(preview.kind, 'rendered');
  const html = renderToStaticMarkup(preview.node);
  assert.match(html, /<iframe/);
  assert.match(html, /sandbox="allow-scripts allow-forms allow-same-origin"/);
  assert.match(
    html,
    /src="http:\/\/127\.0\.0\.1:3456\/artifact-runtime\/host\?[^"]*rev=/,
  );
});

void test('resolveRuntimeArtifactPreview keeps public CDN react_bundle manifest entry URLs rendered', () => {
  const preview = resolveRuntimeArtifactPreview(
    'react_bundle',
    JSON.stringify({
      entryUrl: PUBLIC_CDN_REACT_ENTRY_URL,
    }),
    createPreviewContext(),
  );

  assert.equal(preview.kind, 'rendered');
  const html = renderToStaticMarkup(preview.node);
  assert.match(html, /<iframe/);
  assert.doesNotMatch(html, /sanitize_rejected/);
  assert.match(html, /sandbox="allow-scripts allow-forms allow-same-origin"/);
  assert.match(
    html,
    /src="http:\/\/127\.0\.0\.1:3456\/artifact-runtime\/host\?[^"]*rev=/,
  );
});

void test('resolveArtifactPanePreviewSurfaceResult keeps surface previews and unavailable copy together', () => {
  assert.deepEqual(
    resolveArtifactPanePreviewSurfaceResult({
      kind: 'surface',
      previewSurface: null,
    }),
    {
      previewSurface: null,
      runtimeUnavailableMessage: null,
    },
  );

  assert.deepEqual(
    resolveArtifactPanePreviewSurfaceResult({
      kind: 'surface',
      previewSurface: unavailableArtifactPreview(
        'boot_failed',
        'inline source manifests with files/entry are unsupported',
      ),
    }),
    {
      previewSurface: unavailableArtifactPreview(
        'boot_failed',
        'inline source manifests with files/entry are unsupported',
      ),
      runtimeUnavailableMessage:
        '이 react bundle은 inline source compile 단계에서 실패했습니다.',
    },
  );
});

void test('resolveArtifactPanePreviewSurfaceResult resolves runtime preview requests', () => {
  const result = resolveArtifactPanePreviewSurfaceResult({
    kind: 'runtime',
    renderer: 'html5',
    payload:
      '<a href="javascript:alert(1)">bad</a><img src="file:///etc/passwd" alt="bad">',
    context: createPreviewContext(),
  });

  assert.equal(result.previewSurface?.kind, 'unavailable');
  assert.equal(
    result.runtimeUnavailableMessage,
    '이 캔버스는 현재 웹쉘 경계를 넘는 링크나 리소스 때문에 바로 열 수 없습니다.',
  );
});
