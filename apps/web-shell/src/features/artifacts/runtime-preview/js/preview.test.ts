import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { resolveJsArtifactRuntimePreview } from './preview.js';
import type { ResolvedArtifactSourceRef } from '../../artifact-types.js';
import type { ArtifactRuntimeFrameRenderArgs } from '../types.js';
import { brandThreadId } from '../../../../lib/id-brand-helpers.js';

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

function resolveRenderedJsPreview(payload: string) {
  const preview = resolveJsArtifactRuntimePreview({
    payload,
    digest: 'fixture-js',
    sourceRef: createResolvedSourceRef({
      workingDirectory: 'stories/sample',
      threadId: brandThreadId('00000000-0000-4000-8000-000000000001'),
    }),
    renderRuntimeFrame,
  });

  assert.equal(preview.kind, 'rendered');
  return renderToStaticMarkup(preview.node);
}

function renderRuntimeFrame(args: ArtifactRuntimeFrameRenderArgs) {
  return createElement('iframe', {
    sandbox: args.sandbox,
    src: `http://127.0.0.1:3456/artifact-runtime/host?renderer=${args.renderer}&rev=fake`,
    title: args.title,
  });
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
