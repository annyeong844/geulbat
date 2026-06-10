import test from 'node:test';
import assert from 'node:assert/strict';

import { buildHtmlArtifactRuntimePayload } from '../html/document.js';
import {
  JS_RUNTIME_ROOT_ID,
  buildJsArtifactRuntimeDocument,
} from './document.js';

const BOOTSTRAP_SOURCE =
  'window.__GEULBAT_BOOTSTRAP_FIXTURE__ = { installed: true };';

void test('html5 payloads still boot through the shared runtime document', () => {
  const payload = buildHtmlArtifactRuntimePayload(
    [
      '<!doctype html>',
      '<html>',
      '<head>',
      '<link rel="stylesheet" href="https://fixtures.geulbat.local/app.css">',
      '</head>',
      '<body>',
      '<script src="https://fixtures.geulbat.local/app.js"></script>',
      '<div id="app">ready</div>',
      '</body>',
      '</html>',
    ].join(''),
  );
  const document = buildJsArtifactRuntimeDocument(payload, {
    scopeHandle: 'scope-html-runtime',
    parentOrigin: 'http://127.0.0.1:5173',
    bootstrapSource: BOOTSTRAP_SOURCE,
  });

  assert.match(document, /const __geulbatHtmlPayload__/);
  assert.match(document, /new DOMParser\(\)/);
  assert.match(
    document,
    /__geulbatReplaceDocumentWithHtml__\(__geulbatHtmlPayload__\)/,
  );
  assert.doesNotMatch(document, /document\.write\(__geulbatHtmlPayload__\)/);
  assert.match(document, /scope-html-runtime/);
  assert.match(document, /http:\/\/127\.0\.0\.1:5173/);
  assert.match(document, /window\.__GEULBAT_BOOTSTRAP_FIXTURE__/);
  assert.match(document, /const awaitStorageBeforePayload =\s*true;/);
  assert.match(document, /await Promise\.resolve\(\(0, eval\)\(source\)\)/);
});

void test('buildJsArtifactRuntimeDocument owns document assembly without persistence authority', () => {
  const document = buildJsArtifactRuntimeDocument(
    'const root = document.getElementById("geulbat-js-root");',
    {
      scopeHandle: 'scope-123',
      parentOrigin: 'http://127.0.0.1:5173',
      bootstrapSource: BOOTSTRAP_SOURCE,
    },
  );

  assert.match(document, new RegExp(`id="${JS_RUNTIME_ROOT_ID}"`));
  assert.match(document, /window\.__GEULBAT_BOOTSTRAP_FIXTURE__/);
  assert.match(document, /const GENERATED_TEXT_EXPORT_MESSAGE_KIND =/);
  assert.match(
    document,
    /const GENERATED_TEXT_EXPORT_ALLOWED_MIME_TYPES = new Set\(/,
  );
  assert.match(document, /window\.geulbatExport = Object\.freeze/);
  assert.match(document, /setTextSnapshot\(snapshot\)/);
  assert.match(document, /setBinarySnapshot\(snapshot\)/);
  assert.match(document, /setBinaryBytesSnapshot\(snapshot\)/);
  assert.match(document, /clearTextSnapshot\(\)/);
  assert.match(document, /clearBinarySnapshot\(\)/);
  assert.match(document, /const trackedObjectUrls = new Set\(\)/);
  assert.match(document, /const installGeneratedBlobUrlCapability = \(\) =>/);
  assert.match(document, /URL\.createObjectURL/);
  assert.match(document, /URL\.revokeObjectURL/);
  assert.match(document, /cleanupTrackedObjectUrls\('pagehide'\)/);
  assert.match(document, /cleanupTrackedObjectUrls\('beforeunload'\)/);
  assert.doesNotMatch(document, /cleanupTrackedObjectUrls\('unload'\)/);
  assert.doesNotMatch(document, /addEventListener\('unload'/);
  assert.match(
    document,
    /const installCssMaskImagePropertyAssignmentCapability = \(\) =>/,
  );
  assert.match(
    document,
    /installCssMaskImagePropertyAssignmentCapability\(\);/,
  );
  assert.match(
    document,
    /const installCssBorderImageSourcePropertyAssignmentCapability = \(\) =>/,
  );
  assert.match(
    document,
    /installCssBorderImageSourcePropertyAssignmentCapability\(\);/,
  );
  assert.doesNotMatch(document, /const BLOB_BACKGROUND_IMAGE_URL_PATTERN =/);
  assert.doesNotMatch(
    document,
    /const installCssBlobBackgroundImageCapability = \(\) =>/,
  );
  assert.match(
    document,
    /const RUNTIME_HOST_MESSAGE_KIND = 'geulbat\.artifact_runtime_host';/,
  );
  assert.match(document, /const postRuntimeResize = \(\) =>/);
  assert.match(document, /action: 'resize'/);
  assert.doesNotMatch(document, /postMessage\([^)]*['"]\*['"]\)/);
  assert.match(document, /const installRuntimeResizeSync = \(\) =>/);
  assert.match(document, /ResizeObserver/);
  assert.doesNotMatch(document, /MutationObserver/);
  assert.match(document, /const nativeFetch =/);
  assert.match(document, /const applyNetworkDefaults = \(init\) =>/);
  assert.match(document, /nextInit\.credentials = 'omit'/);
  assert.match(document, /nextInit\.referrerPolicy = 'no-referrer'/);
  assert.match(document, /window\.fetch = \(input, init\) =>/);
  assert.match(document, /navigator\.sendBeacon/);
  assert.match(document, /method: 'POST'/);
  assert.match(document, /keepalive: true/);
  assert.doesNotMatch(document, /GEULBAT_DEV_TOKEN/i);
  assert.doesNotMatch(document, /x-geulbat-dev-token/i);
  assert.doesNotMatch(document, /authorization/i);
});

void test('buildJsArtifactRuntimeDocument can opt out of blocking on storage preload', () => {
  const document = buildJsArtifactRuntimeDocument(
    'window.__artifact_booted__ = true;',
    {
      scopeHandle: 'scope-nonblocking',
      parentOrigin: 'http://127.0.0.1:5173',
      awaitStorageBeforePayload: false,
      bootstrapSource: BOOTSTRAP_SOURCE,
    },
  );

  assert.match(document, /const awaitStorageBeforePayload =\s*false;/);
  assert.match(
    document,
    /void Promise\.resolve\(\s*window\.__GEULBAT_RUNTIME_STORAGE_READY__,?\s*\)\.catch\(/,
  );
});

void test('buildJsArtifactRuntimeDocument keeps conformance network and boundary probe payloads intact', () => {
  const document = buildJsArtifactRuntimeDocument(
    [
      'const xhr = new XMLHttpRequest();',
      "const stream = new EventSource('https://sse.geulbat-fixtures.local/echo?message=stream');",
      "const socket = new WebSocket('wss://ws.geulbat-fixtures.local/echo');",
      'const bridge = parent.__GEULBAT_PRIVILEGED_BRIDGE__;',
    ].join('\n'),
    {
      scopeHandle: 'scope-456',
      parentOrigin: 'http://127.0.0.1:5173',
      bootstrapSource: BOOTSTRAP_SOURCE,
    },
  );

  assert.match(document, /new XMLHttpRequest\(\)/);
  assert.match(
    document,
    /new EventSource\('https:\/\/sse\.geulbat-fixtures\.local\/echo\?message=stream'\)/,
  );
  assert.match(
    document,
    /new WebSocket\('wss:\/\/ws\.geulbat-fixtures\.local\/echo'\)/,
  );
  assert.match(document, /parent\.__GEULBAT_PRIVILEGED_BRIDGE__/);
});
