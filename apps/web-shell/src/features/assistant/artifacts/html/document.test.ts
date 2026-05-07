import test from 'node:test';
import assert from 'node:assert/strict';

import { buildHtmlArtifactRuntimePayload } from './document.js';
import { buildJsArtifactRuntimeDocument } from '../js/document.js';

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
  });

  assert.match(document, /const __geulbatHtmlPayload__/);
  assert.match(document, /new DOMParser\(\)/);
  assert.match(
    document,
    /__geulbatReplaceDocumentWithHtml__\(__geulbatHtmlPayload__\)/,
  );
  assert.doesNotMatch(document, /document\.write\(__geulbatHtmlPayload__\)/);
  assert.match(document, /localStorage/);
  assert.match(document, /geulbatDB/);
  assert.match(document, /indexedDB/);
  assert.match(document, /nextInit\.credentials = 'omit'/);
  assert.match(document, /scope-html-runtime/);
  assert.match(document, /http:\/\/127\.0\.0\.1:5173/);
  assert.match(document, /const awaitStorageBeforePayload =\s*true;/);
  assert.match(document, /await Promise\.resolve\(\(0, eval\)\(source\)\)/);
});

void test('html5 payloads inject a resize helper before closing body', () => {
  const payload = buildHtmlArtifactRuntimePayload(
    '<!doctype html><html><body><main>ready</main></body></html>',
  );

  assert.match(payload, /window\.__GEULBAT_PARENT_ORIGIN__/);
  assert.match(payload, /window\.parent\.postMessage\(/);
  assert.match(payload, /action: 'resize'/);
  assert.match(payload, /ResizeObserver/);
  assert.doesNotMatch(payload, /MutationObserver/);
  assert.doesNotMatch(payload, /postMessage\([^)]*['"]\*['"]\)/);
  assert.match(payload, /\\u003Cscript>\(\(\) => \{/);
  assert.match(payload, /\\u003C\/script>\\u003C\/body>\\u003C\/html>/);
});

void test('html5 payloads replace the document through DOM parsing and ordered script recreation', () => {
  const payload = buildHtmlArtifactRuntimePayload(
    '<!doctype html><html><head><script src="/app.js"></script></head><body><script type="module">window.__boot = true;</script></body></html>',
  );

  assert.match(payload, /new DOMParser\(\)/);
  assert.match(payload, /await appendParsedNode\(target, childNode\)/);
  assert.match(payload, /html artifact script failed to load or execute/);
  assert.doesNotMatch(payload, /document\.write\(/);
});
