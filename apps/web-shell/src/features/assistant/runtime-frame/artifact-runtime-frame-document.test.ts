import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ARTIFACT_RUNTIME_PERSISTENCE_VERBS,
  PERSISTENCE_REQUEST_KIND,
  PERSISTENCE_RESPONSE_KIND,
} from '../runtime-persistence/artifact-runtime-persistence-types.js';
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

void test('createArtifactRuntimeFrameDocument injects assistant-owned persistence bootstrap', () => {
  const documentHtml = createArtifactRuntimeFrameDocument({
    renderer: 'js',
    runtimePayload: 'window.__artifact_booted__ = true;',
    scopeHandle: 'scope-persistence',
    runtimeParentOrigin: 'http://127.0.0.1:5173',
  });

  assert.match(documentHtml, /__GEULBAT_PERSISTENCE_BRIDGE_VERSION__/);
  assert.match(documentHtml, new RegExp(PERSISTENCE_REQUEST_KIND));
  assert.match(documentHtml, new RegExp(PERSISTENCE_RESPONSE_KIND));
  assert.match(documentHtml, /geulbatPersistence = Object\.freeze/);
  assert.match(documentHtml, /geulbatDB/);
  assert.match(documentHtml, /storage = storageApi/);
  assert.match(documentHtml, /__GEULBAT_RUNTIME_STORAGE_READY__/);
  assert.match(documentHtml, /localStorage/);
  assert.match(
    documentHtml,
    new RegExp(ARTIFACT_RUNTIME_PERSISTENCE_VERBS.loadState),
  );
  assert.match(
    documentHtml,
    new RegExp(ARTIFACT_RUNTIME_PERSISTENCE_VERBS.saveState),
  );
  assert.match(
    documentHtml,
    new RegExp(ARTIFACT_RUNTIME_PERSISTENCE_VERBS.clearState),
  );
  assert.match(documentHtml, /async get\(key\)/);
  assert.match(documentHtml, /async set\(key, value\)/);
  assert.match(documentHtml, /async delete\(key\)/);
  assert.match(documentHtml, /async list\(prefix\)/);
  assert.match(documentHtml, /async put\(key, value\)/);
  assert.match(documentHtml, /async keys\(\)/);
});
