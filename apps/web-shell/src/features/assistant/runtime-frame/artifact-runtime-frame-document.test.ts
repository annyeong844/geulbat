import test from 'node:test';
import assert from 'node:assert/strict';

import { createArtifactRuntimeFrameDocument } from './artifact-runtime-frame-document.js';

void test('createArtifactRuntimeFrameDocument blocks js payload boot on storage preload', () => {
  const documentHtml = createArtifactRuntimeFrameDocument({
    renderer: 'js',
    runtimePayload: 'window.__artifact_booted__ = true;',
    scopeHandle: 'scope-rev2-js',
    runtimeParentOrigin: 'http://127.0.0.1:5173',
  });

  assert.match(documentHtml, /const awaitStorageBeforePayload =\s*true;/);
  assert.match(documentHtml, /const runtimeScopeHandle = "scope-rev2-js";/);
  assert.match(
    documentHtml,
    /const runtimeParentOrigin = "http:\/\/127\.0\.0\.1:5173";/,
  );
});

void test('createArtifactRuntimeFrameDocument keeps react bundle boot non-blocking on storage preload', () => {
  const documentHtml = createArtifactRuntimeFrameDocument({
    renderer: 'react_bundle',
    runtimePayload: 'window.__artifact_booted__ = true;',
    scopeHandle: 'scope-rev2-react',
    runtimeParentOrigin: 'http://127.0.0.1:5173',
  });

  assert.match(documentHtml, /const awaitStorageBeforePayload =\s*false;/);
  assert.match(documentHtml, /const runtimeScopeHandle = "scope-rev2-react";/);
});
