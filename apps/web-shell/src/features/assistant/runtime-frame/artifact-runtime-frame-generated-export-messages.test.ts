import test from 'node:test';
import assert from 'node:assert/strict';

import { readArtifactRuntimeGeneratedExportSnapshotMessage } from './artifact-runtime-frame-generated-export-messages.js';

const SCOPE_HANDLE = 'scope-generated-export';

void test('readArtifactRuntimeGeneratedExportSnapshotMessage reads text export set and clear messages', () => {
  assert.deepEqual(
    readArtifactRuntimeGeneratedExportSnapshotMessage(
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
    readArtifactRuntimeGeneratedExportSnapshotMessage(
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
});

void test('readArtifactRuntimeGeneratedExportSnapshotMessage reads binary export set and clear messages', () => {
  const blob = new Blob(['bytes'], { type: 'application/octet-stream' });

  assert.deepEqual(
    readArtifactRuntimeGeneratedExportSnapshotMessage(
      {
        kind: 'geulbat.runtime.generated_binary_export',
        scopeHandle: SCOPE_HANDLE,
        action: 'set_snapshot',
        snapshot: {
          blob,
          fileNameHint: 'preview.bin',
        },
      },
      SCOPE_HANDLE,
    ),
    {
      kind: 'generated_binary_export_snapshot',
      snapshot: {
        blob,
        fileNameHint: 'preview.bin',
      },
    },
  );

  assert.deepEqual(
    readArtifactRuntimeGeneratedExportSnapshotMessage(
      {
        kind: 'geulbat.runtime.generated_binary_export',
        scopeHandle: SCOPE_HANDLE,
        action: 'clear_snapshot',
      },
      SCOPE_HANDLE,
    ),
    {
      kind: 'generated_binary_export_snapshot',
      snapshot: null,
    },
  );
});

void test('readArtifactRuntimeGeneratedExportSnapshotMessage rejects stale scope and invalid snapshots', () => {
  assert.equal(
    readArtifactRuntimeGeneratedExportSnapshotMessage(
      {
        kind: 'geulbat.runtime.generated_text_export',
        scopeHandle: 'stale-scope',
        action: 'clear_snapshot',
      },
      SCOPE_HANDLE,
    ),
    null,
  );

  assert.equal(
    readArtifactRuntimeGeneratedExportSnapshotMessage(
      {
        kind: 'geulbat.runtime.generated_text_export',
        scopeHandle: SCOPE_HANDLE,
        action: 'set_snapshot',
        snapshot: {
          content: '',
          mimeType: '',
        },
      },
      SCOPE_HANDLE,
    ),
    null,
  );

  assert.equal(
    readArtifactRuntimeGeneratedExportSnapshotMessage(
      {
        kind: 'geulbat.runtime.generated_binary_export',
        scopeHandle: SCOPE_HANDLE,
        action: 'set_snapshot',
        snapshot: {
          blob: 'not-a-blob',
        },
      },
      SCOPE_HANDLE,
    ),
    null,
  );
});
