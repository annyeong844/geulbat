import test from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';

import {
  JS_RUNTIME_ROOT_ID,
  buildJsArtifactRuntimeDocument,
} from './document.js';
import { resolveJsArtifactRuntimePreview } from './runtime.js';
import {
  ARTIFACT_RUNTIME_PERSISTENCE_VERBS,
  PERSISTENCE_REQUEST_KIND,
  PERSISTENCE_RESPONSE_KIND,
} from '../../runtime-persistence/artifact-runtime-persistence-types.js';
import type { ResolvedArtifactSourceRef } from '../../../artifacts/artifact-types.js';
import {
  brandProjectId,
  brandThreadId,
} from '../../../../lib/id-brand-helpers.js';

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

function resolveRenderedJsPreview(payload: string) {
  const preview = resolveJsArtifactRuntimePreview({
    payload,
    digest: 'fixture-js',
    sourceRef: createResolvedSourceRef({
      projectId: brandProjectId('workspace'),
      threadId: brandThreadId('00000000-0000-4000-8000-000000000001'),
    }),
  });

  assert.equal(preview.kind, 'rendered');
  return renderToStaticMarkup(preview.node);
}

void test('resolveJsArtifactRuntimePreview still renders malformed js in the sandbox iframe', () => {
  const html = resolveRenderedJsPreview('function broken(');
  assert.match(html, /<iframe/);
  assert.match(
    html,
    /sandbox="allow-scripts allow-forms allow-same-origin allow-downloads"/,
  );
  assert.match(
    html,
    /src="http:\/\/127\.0\.0\.1:3456\/artifact-runtime\/host\?[^"]*rev=/,
  );
  assert.doesNotMatch(html, /runtime unavailable: boot_failed/);
});

void test('resolveJsArtifactRuntimePreview keeps fetch-json-echo style fixtures rendered', () => {
  const html = resolveRenderedJsPreview(
    [
      "const pre = document.createElement('pre');",
      "pre.textContent = 'loading';",
      'document.body.appendChild(pre);',
      "fetch('https://api.geulbat-fixtures.local/echo.json?message=hello')",
      '  .then((response) => response.json())',
      '  .then((json) => { pre.textContent = json.message; });',
    ].join('\n'),
  );

  assert.match(html, /<iframe/);
  assert.match(
    html,
    /sandbox="allow-scripts allow-forms allow-same-origin allow-downloads"/,
  );
});

void test('resolveJsArtifactRuntimePreview keeps classic xhr and EventSource fixtures rendered', () => {
  const xhrHtml = resolveRenderedJsPreview(
    [
      'const xhr = new XMLHttpRequest();',
      "xhr.open('GET', 'https://api.geulbat-fixtures.local/echo.json?message=xhr');",
      'xhr.onload = () => console.log(xhr.responseText);',
      'xhr.send();',
    ].join('\n'),
  );
  const eventSourceHtml = resolveRenderedJsPreview(
    [
      "const stream = new EventSource('https://sse.geulbat-fixtures.local/echo?message=stream');",
      "stream.addEventListener('message', (event) => { console.log(event.data); stream.close(); });",
    ].join('\n'),
  );

  assert.match(xhrHtml, /<iframe/);
  assert.match(eventSourceHtml, /<iframe/);
});

void test('resolveJsArtifactRuntimePreview keeps websocket, indexeddb, and direct boundary probe fixtures rendered', () => {
  const websocketHtml = resolveRenderedJsPreview(
    [
      "const socket = new WebSocket('wss://ws.geulbat-fixtures.local/echo');",
      "socket.addEventListener('open', () => socket.send('hello'));",
      "socket.addEventListener('message', (event) => { console.log(event.data); socket.close(); });",
    ].join('\n'),
  );
  const indexedDbHtml = resolveRenderedJsPreview(
    [
      "const request = indexedDB.open('geulbat-parity-db', 1);",
      "request.onupgradeneeded = () => request.result.createObjectStore('kv');",
      'request.onsuccess = () => { const db = request.result; db.close(); };',
    ].join('\n'),
  );
  const boundaryProbeHtml = resolveRenderedJsPreview(
    [
      'const bridge = parent.__GEULBAT_PRIVILEGED_BRIDGE__;',
      "let outcome = 'hidden';",
      "try { if (bridge && typeof bridge.saveFile === 'function') { outcome = 'callable'; bridge.saveFile('/tmp/owned.txt', 'owned'); } } catch (error) { outcome = 'denied'; }",
      'document.body.textContent = outcome;',
    ].join('\n'),
  );

  assert.match(websocketHtml, /<iframe/);
  assert.match(indexedDbHtml, /<iframe/);
  assert.match(boundaryProbeHtml, /<iframe/);
});

void test('buildJsArtifactRuntimeDocument includes canonical root and persistence bootstrap', () => {
  const document = buildJsArtifactRuntimeDocument(
    'const root = document.getElementById("geulbat-js-root");',
    {
      scopeHandle: 'scope-123',
      parentOrigin: 'http://127.0.0.1:5173',
    },
  );

  assert.match(document, new RegExp(`id="${JS_RUNTIME_ROOT_ID}"`));
  assert.match(document, /__GEULBAT_PERSISTENCE_BRIDGE_VERSION__/);
  assert.match(document, /scope-123/);
  assert.match(document, new RegExp(PERSISTENCE_REQUEST_KIND));
  assert.match(document, new RegExp(PERSISTENCE_RESPONSE_KIND));
  assert.match(document, /geulbatPersistence = Object\.freeze/);
  assert.match(document, /geulbatDB/);
  assert.match(document, /storage = storageApi/);
  assert.match(document, /__GEULBAT_RUNTIME_STORAGE_READY__/);
  assert.match(document, /localStorage/);
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
  assert.match(document, /action: 'set_snapshot'/);
  assert.match(document, /action: 'clear_snapshot'/);
  assert.match(document, /const GENERATED_BINARY_EXPORT_MESSAGE_KIND =/);
  assert.match(
    document,
    /window\.geulbatExport\.setBinarySnapshot requires a Blob instance/,
  );
  assert.match(document, /const sanitizeBinaryFileNameHint = \(value\) =>/);
  assert.match(
    document,
    /const normalizeGeneratedBinaryMimeType = \(value, helperName\) =>/,
  );
  assert.match(
    document,
    /window\.geulbatExport\.setBinaryBytesSnapshot requires a Uint8Array instance/,
  );
  assert.match(
    document,
    /window\.geulbatExport\.setBinaryBytesSnapshot only accepts string fileNameHint values/,
  );
  assert.match(document, /const ownedBytes = new Uint8Array\(bytes\)/);
  assert.match(document, /new Blob\(\[ownedBytes\], \{ type: mimeType \}\)/);
  assert.match(document, /blob instanceof File/);
  assert.match(document, /sanitizeBinaryFileNameHint\(blob\.name\)/);
  assert.match(
    document,
    /window\.__GEULBAT_PARENT_ORIGIN__ = runtimeParentOrigin/,
  );
  assert.match(document, /const awaitStorageBeforePayload =\s*true;/);
  assert.match(
    document,
    /window\.parent\.postMessage\(message, runtimeParentOrigin\)/,
  );
  assert.match(document, /const trackedObjectUrls = new Set\(\)/);
  assert.match(document, /const installGeneratedBlobUrlCapability = \(\) =>/);
  assert.match(document, /URL\.createObjectURL/);
  assert.match(document, /URL\.revokeObjectURL/);
  assert.match(document, /cleanupTrackedObjectUrls\('pagehide'\)/);
  assert.match(document, /cleanupTrackedObjectUrls\('beforeunload'\)/);
  assert.doesNotMatch(document, /cleanupTrackedObjectUrls\('unload'\)/);
  assert.doesNotMatch(document, /addEventListener\('unload'/);
  assert.match(document, /clearPublishedTextSnapshot\(\);/);
  assert.match(document, /clearPublishedBinarySnapshot\(\);/);
  assert.match(document, /trackedObjectUrls\.add\(url\)/);
  assert.match(document, /trackedObjectUrls\.delete\(url\)/);
  assert.match(
    document,
    /const installCssMaskImagePropertyAssignmentCapability = \(\) =>/,
  );
  assert.match(
    document,
    /Object\.getOwnPropertyDescriptor\(\s*CSSStyleDeclaration\.prototype,\s*'maskImage'/,
  );
  assert.match(document, /Preserve browser-default CSS behavior\./);
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
    /Object\.getOwnPropertyDescriptor\(\s*CSSStyleDeclaration\.prototype,\s*'borderImageSource'/,
  );
  assert.match(
    document,
    /installCssBorderImageSourcePropertyAssignmentCapability\(\);/,
  );
  assert.doesNotMatch(document, /const BLOB_BACKGROUND_IMAGE_URL_PATTERN =/);
  assert.doesNotMatch(document, /const isTrackedBlobUrl = \(value\) =>/);
  assert.doesNotMatch(
    document,
    /const normalizeBackgroundImageBlobUrl = \(value\) =>/,
  );
  assert.doesNotMatch(
    document,
    /style\.backgroundImage only supports tracked blob: object URLs in the artifact css runtime/,
  );
  assert.doesNotMatch(
    document,
    /const installCssBlobBackgroundImageCapability = \(\) =>/,
  );
  assert.doesNotMatch(
    document,
    /Object\.getOwnPropertyDescriptor\(\s*CSSStyleDeclaration\.prototype,\s*'backgroundImage'/,
  );
  assert.doesNotMatch(
    document,
    /Object\.defineProperty\(\s*CSSStyleDeclaration\.prototype,\s*'backgroundImage'/,
  );
  assert.doesNotMatch(
    document,
    /const nativeSetProperty =\s*typeof CSSStyleDeclaration\.prototype\.setProperty === 'function'/,
  );
  assert.doesNotMatch(
    document,
    /CSSStyleDeclaration\.prototype\.setProperty = function \(/,
  );
  assert.doesNotMatch(document, /property\.trim\(\)\.toLowerCase\(\)/);
  assert.doesNotMatch(document, /normalizedProperty !== 'background-image'/);
  assert.doesNotMatch(
    document,
    /nativeSetProperty\.call\(this, property, value, priority\)/,
  );
  assert.doesNotMatch(
    document,
    /nativeSetProperty\.call\(\s*this,\s*property,\s*normalizeBackgroundImageBlobUrl\(value\),\s*priority,\s*\)/,
  );
  assert.doesNotMatch(document, /installCssBlobBackgroundImageCapability\(\);/);
  assert.doesNotMatch(document, /'mask-image'/);
  assert.doesNotMatch(document, /'border-image-source'/);
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
  assert.match(document, /installRuntimeResizeSync\(\);/);
  assert.match(document, /scheduleRuntimeResize\(\);/);
  assert.match(
    document,
    new RegExp(ARTIFACT_RUNTIME_PERSISTENCE_VERBS.loadState),
  );
  assert.match(
    document,
    new RegExp(ARTIFACT_RUNTIME_PERSISTENCE_VERBS.saveState),
  );
  assert.match(
    document,
    new RegExp(ARTIFACT_RUNTIME_PERSISTENCE_VERBS.clearState),
  );
  assert.match(document, /load\(\)/);
  assert.match(document, /save\(state, expectedRevision\)/);
  assert.match(document, /clear\(expectedRevision\)/);
  assert.match(document, /async get\(key\)/);
  assert.match(document, /async set\(key, value\)/);
  assert.match(document, /async delete\(key\)/);
  assert.match(document, /async list\(prefix\)/);
  assert.match(document, /async put\(key, value\)/);
  assert.match(document, /async keys\(\)/);
  assert.match(document, /const nativeFetch =/);
  assert.match(document, /const applyNetworkDefaults = \(init\) =>/);
  assert.match(document, /const installNetworkDefaults = \(\) =>/);
  assert.match(document, /nextInit\.credentials = 'omit'/);
  assert.match(document, /nextInit\.referrerPolicy = 'no-referrer'/);
  assert.match(document, /window\.fetch = \(input, init\) =>/);
  assert.match(document, /const installSendBeaconCapability = \(\) =>/);
  assert.match(document, /navigator\.sendBeacon/);
  assert.match(document, /method: 'POST'/);
  assert.match(document, /keepalive: true/);
  assert.match(document, /installNetworkDefaults\(\);/);
  assert.match(document, /installSendBeaconCapability\(\);/);
  assert.match(document, /const createIndexedDbShim = \(\) =>/);
  assert.match(document, /const installIndexedDbShim = \(\) =>/);
  assert.match(document, /window\.indexedDB/);
  assert.match(document, /indexedDB database name must be a non-empty string/);
  assert.match(document, /indexedDB object store does not exist/);
  assert.match(document, /function createSessionStorageFacade\(\{/);
  assert.match(
    document,
    /installPersistenceFacadeProperty\([^,]+,\s*["']sessionStorage["']/,
  );
  assert.doesNotMatch(document, /fetch is disabled in js first landing/);
  assert.doesNotMatch(
    document,
    /XMLHttpRequest is disabled in js first landing/,
  );
  assert.doesNotMatch(document, /WebSocket is disabled in js first landing/);
  assert.doesNotMatch(document, /EventSource is disabled in js first landing/);
  assert.doesNotMatch(
    document,
    /sessionStorage is disabled in js first landing/,
  );
  assert.doesNotMatch(document, /sendBeacon is disabled in js first landing/);
  assert.doesNotMatch(document, /reserved in js first landing/);
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
