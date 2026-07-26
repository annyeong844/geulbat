import test from 'node:test';
import assert from 'node:assert/strict';

import { buildHtmlArtifactRuntimePayload } from './document.js';

void test('html5 payloads inject a resize helper before closing body', () => {
  const payload = buildHtmlArtifactRuntimePayload(
    '<!doctype html><html><body><main>ready</main></body></html>',
  );

  assert.match(payload, /window\.__GEULBAT_PARENT_ORIGIN__/);
  assert.match(payload, /window\.parent\.postMessage\(/);
  assert.match(payload, /action: 'resize'/);
  assert.match(payload, /ResizeObserver/);
  assert.match(payload, /const measureObservedResize = \(entries\) =>/);
  assert.match(payload, /new ResizeObserver\(\(entries\) =>/);
  assert.match(payload, /queueResize\(measureObservedResize\(entries\)\)/);
  assert.doesNotMatch(payload, /new ResizeObserver\(measureAndQueueResize\)/);
  assert.match(payload, /const measureResize = \(\) =>/);
  const queueIndex = payload.indexOf('const queueResize = (height) => {');
  const animationFrameIndex = payload.indexOf(
    'window.requestAnimationFrame(() => {',
  );
  const sendIndex = payload.indexOf('sendResize(height);', animationFrameIndex);
  assert.ok(queueIndex >= 0);
  assert.ok(animationFrameIndex > queueIndex);
  assert.ok(sendIndex > animationFrameIndex);
  assert.doesNotMatch(
    payload.slice(animationFrameIndex, sendIndex),
    /measureResize\(\)/,
  );
  assert.match(payload, /window\.setTimeout\(measureAndQueueResize, 0\);/);
  assert.match(payload, /window\.setTimeout\(measureAndQueueResize, 120\);/);
  assert.equal(
    payload.includes(
      'window.setTimeout(measureAndQueueResize, 120);\\n    measureAndQueueResize();',
    ),
    false,
  );
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
