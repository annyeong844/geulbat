import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ARTIFACT_RUNTIME_HOST_MESSAGE_KIND,
  ARTIFACT_RUNTIME_HOST_READY_ACTION,
} from './artifact-runtime-host.js';
import {
  normalizeArtifactRuntimeFrameHeight,
  readArtifactRuntimeFrameMessage,
} from './artifact-runtime-frame-messages.js';

const SCOPE_HANDLE = 'scope-test';

void test('normalizeArtifactRuntimeFrameHeight clamps runtime iframe height to a safe range', () => {
  assert.equal(normalizeArtifactRuntimeFrameHeight(120), 260);
  assert.equal(normalizeArtifactRuntimeFrameHeight(320.4), 321);
  assert.equal(normalizeArtifactRuntimeFrameHeight(9000), 4096);
});

void test('normalizeArtifactRuntimeFrameHeight rejects non-finite values', () => {
  assert.equal(normalizeArtifactRuntimeFrameHeight(Number.NaN), null);
  assert.equal(normalizeArtifactRuntimeFrameHeight(Infinity), null);
  assert.equal(normalizeArtifactRuntimeFrameHeight('320'), null);
});

void test('readArtifactRuntimeFrameMessage classifies host messages', () => {
  assert.deepEqual(
    readArtifactRuntimeFrameMessage(
      {
        kind: ARTIFACT_RUNTIME_HOST_MESSAGE_KIND,
        action: ARTIFACT_RUNTIME_HOST_READY_ACTION,
      },
      SCOPE_HANDLE,
    ),
    {
      kind: 'host_ready',
      message: {
        kind: ARTIFACT_RUNTIME_HOST_MESSAGE_KIND,
        action: ARTIFACT_RUNTIME_HOST_READY_ACTION,
      },
    },
  );

  assert.deepEqual(
    readArtifactRuntimeFrameMessage(
      {
        kind: ARTIFACT_RUNTIME_HOST_MESSAGE_KIND,
        action: 'resize',
        height: 320.2,
      },
      SCOPE_HANDLE,
    ),
    {
      kind: 'host_resize',
      height: 321,
      message: {
        kind: ARTIFACT_RUNTIME_HOST_MESSAGE_KIND,
        action: 'resize',
        height: 321,
      },
    },
  );
});

void test('readArtifactRuntimeFrameMessage delegates scoped generated snapshots', () => {
  assert.deepEqual(
    readArtifactRuntimeFrameMessage(
      {
        kind: 'geulbat.runtime.generated_text_export',
        scopeHandle: SCOPE_HANDLE,
        action: 'set_snapshot',
        snapshot: {
          content: 'hello',
          mimeType: 'text/plain',
          fileNameHint: 'hello.txt',
        },
      },
      SCOPE_HANDLE,
    ),
    {
      kind: 'generated_text_export_snapshot',
      snapshot: {
        content: 'hello',
        mimeType: 'text/plain',
        fileNameHint: 'hello.txt',
      },
    },
  );

  assert.deepEqual(
    readArtifactRuntimeFrameMessage(
      {
        kind: 'geulbat.runtime.generated_text_export',
        scopeHandle: SCOPE_HANDLE,
        action: 'clear_snapshot',
      },
      SCOPE_HANDLE,
    ),
    {
      kind: 'generated_text_export_snapshot',
      snapshot: null,
    },
  );

  assert.equal(
    readArtifactRuntimeFrameMessage(
      {
        kind: 'geulbat.runtime.generated_text_export',
        scopeHandle: 'other-scope',
        action: 'clear_snapshot',
      },
      SCOPE_HANDLE,
    ),
    null,
  );
});
