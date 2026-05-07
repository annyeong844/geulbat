import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ARTIFACT_RUNTIME_HOST_BOOT_ACTION,
  ARTIFACT_RUNTIME_HOST_MESSAGE_KIND,
  ARTIFACT_RUNTIME_HOST_READY_ACTION,
  ARTIFACT_RUNTIME_HOST_RESIZE_ACTION,
  DEFAULT_ARTIFACT_RUNTIME_HOST_ORIGIN,
  createArtifactRuntimeHostBootMessage,
  createArtifactRuntimeHostReadyMessage,
  createArtifactRuntimeHostResizeMessage,
  isArtifactRuntimeHostBootMessage,
  isArtifactRuntimeHostMessage,
  isArtifactRuntimeHostReadyMessage,
  isArtifactRuntimeHostResizeMessage,
} from './artifact-runtime-host.js';

void test('artifact runtime host message helpers create canonical bridge messages', () => {
  assert.equal(DEFAULT_ARTIFACT_RUNTIME_HOST_ORIGIN, 'http://127.0.0.1:3456');
  assert.deepEqual(createArtifactRuntimeHostBootMessage('<html></html>'), {
    kind: ARTIFACT_RUNTIME_HOST_MESSAGE_KIND,
    action: ARTIFACT_RUNTIME_HOST_BOOT_ACTION,
    documentHtml: '<html></html>',
  });
  assert.deepEqual(createArtifactRuntimeHostReadyMessage(), {
    kind: ARTIFACT_RUNTIME_HOST_MESSAGE_KIND,
    action: ARTIFACT_RUNTIME_HOST_READY_ACTION,
  });
  assert.deepEqual(createArtifactRuntimeHostResizeMessage(320), {
    kind: ARTIFACT_RUNTIME_HOST_MESSAGE_KIND,
    action: ARTIFACT_RUNTIME_HOST_RESIZE_ACTION,
    height: 320,
  });
});

void test('artifact runtime host guards accept canonical bridge messages and reject malformed ones', () => {
  assert.equal(
    isArtifactRuntimeHostBootMessage(
      createArtifactRuntimeHostBootMessage('<html></html>'),
    ),
    true,
  );
  assert.equal(isArtifactRuntimeHostBootMessage({ action: 'boot' }), false);

  assert.equal(
    isArtifactRuntimeHostReadyMessage(createArtifactRuntimeHostReadyMessage()),
    true,
  );
  assert.equal(isArtifactRuntimeHostReadyMessage({ kind: 'wrong' }), false);

  assert.equal(
    isArtifactRuntimeHostResizeMessage(
      createArtifactRuntimeHostResizeMessage(1),
    ),
    true,
  );
  assert.equal(
    isArtifactRuntimeHostResizeMessage({
      kind: ARTIFACT_RUNTIME_HOST_MESSAGE_KIND,
      action: ARTIFACT_RUNTIME_HOST_RESIZE_ACTION,
      height: '320',
    }),
    false,
  );

  assert.equal(
    isArtifactRuntimeHostMessage(createArtifactRuntimeHostReadyMessage()),
    true,
  );
  assert.equal(
    isArtifactRuntimeHostMessage({
      kind: ARTIFACT_RUNTIME_HOST_MESSAGE_KIND,
      action: 'unknown',
    }),
    false,
  );
});
