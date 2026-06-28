import test from 'node:test';
import assert from 'node:assert/strict';

import {
  readReactBundleArtifactInputPayload,
  validateReactBundleArtifactPayload,
} from './validator.js';
import {
  CDN_ENTRY_URL,
  LOCAL_FIXTURE_ENTRY_URL,
  LOCAL_GENERATED_ENTRY_URL,
  LOCAL_IPV6_MAPPED_FIXTURE_ENTRY_URL,
  PRIVATE_ENTRY_URL,
  REMOTE_HTTP_FIXTURE_ENTRY_URL,
} from './validator-test-support.js';

void test('validateReactBundleArtifactPayload accepts public CDN entry URLs at shell preflight', () => {
  assert.deepEqual(
    validateReactBundleArtifactPayload(
      JSON.stringify({
        entryUrl: CDN_ENTRY_URL,
      }),
    ),
    {
      ok: true,
      manifest: {
        entryUrl: CDN_ENTRY_URL,
      },
    },
  );
});

void test('readReactBundleArtifactInputPayload keeps public CDN entry URLs on the manifest path', () => {
  assert.deepEqual(
    readReactBundleArtifactInputPayload(
      JSON.stringify({
        entryUrl: CDN_ENTRY_URL,
      }),
    ),
    {
      ok: true,
      kind: 'manifest',
      manifest: {
        entryUrl: CDN_ENTRY_URL,
      },
    },
  );
});

void test('validateReactBundleArtifactPayload accepts shell-owned public fixture paths on loopback', () => {
  assert.deepEqual(
    validateReactBundleArtifactPayload(
      JSON.stringify({
        entryUrl: LOCAL_FIXTURE_ENTRY_URL,
      }),
    ),
    {
      ok: true,
      manifest: {
        entryUrl: LOCAL_FIXTURE_ENTRY_URL,
      },
    },
  );
  assert.deepEqual(
    validateReactBundleArtifactPayload(
      JSON.stringify({
        entryUrl: LOCAL_IPV6_MAPPED_FIXTURE_ENTRY_URL,
      }),
    ),
    {
      ok: true,
      manifest: {
        entryUrl: LOCAL_IPV6_MAPPED_FIXTURE_ENTRY_URL,
      },
    },
  );
});

void test('validateReactBundleArtifactPayload accepts shell-owned generated entry paths on loopback', () => {
  assert.deepEqual(
    validateReactBundleArtifactPayload(
      JSON.stringify({
        entryUrl: LOCAL_GENERATED_ENTRY_URL,
      }),
    ),
    {
      ok: true,
      manifest: {
        entryUrl: LOCAL_GENERATED_ENTRY_URL,
      },
    },
  );
});

void test('validateReactBundleArtifactPayload accepts ordinary external http entry URLs outside explicit shell-owned privileged paths', () => {
  assert.deepEqual(
    validateReactBundleArtifactPayload(
      JSON.stringify({
        entryUrl: REMOTE_HTTP_FIXTURE_ENTRY_URL,
      }),
    ),
    {
      ok: true,
      manifest: {
        entryUrl: REMOTE_HTTP_FIXTURE_ENTRY_URL,
      },
    },
  );
});

void test('validateReactBundleArtifactPayload accepts private and generated http(s) entry URLs at shell preflight', () => {
  assert.deepEqual(
    validateReactBundleArtifactPayload(
      JSON.stringify({
        entryUrl: PRIVATE_ENTRY_URL,
      }),
    ),
    {
      ok: true,
      manifest: {
        entryUrl: PRIVATE_ENTRY_URL,
      },
    },
  );
});

void test('validateReactBundleArtifactPayload rejects non-http executable entry schemes', () => {
  for (const entryUrl of [
    'javascript:globalThis.__geulbatTest__=1',
    'file:///tmp/react-entry.js',
    'data:text/javascript,export default {}',
    'blob:https://fixtures.geulbat.local/react-bundle-entry',
  ]) {
    assert.deepEqual(
      validateReactBundleArtifactPayload(JSON.stringify({ entryUrl })),
      {
        ok: false,
        code: 'policy_blocked',
        detail: 'react bundle manifest entryUrl must use http or https',
      },
      entryUrl,
    );
    assert.deepEqual(
      readReactBundleArtifactInputPayload(JSON.stringify({ entryUrl })),
      {
        ok: false,
        code: 'policy_blocked',
        detail: 'react bundle manifest entryUrl must use http or https',
      },
      entryUrl,
    );
  }
});

void test('validateReactBundleArtifactPayload rejects explicit shell-owned privileged entry URLs', () => {
  assert.deepEqual(
    validateReactBundleArtifactPayload(
      JSON.stringify({
        entryUrl: 'http://127.0.0.1:3456/artifact-runtime/host',
      }),
    ),
    {
      ok: false,
      code: 'policy_blocked',
      detail:
        'react bundle manifest entryUrl points at a shell-owned privileged path',
    },
  );
  assert.deepEqual(
    validateReactBundleArtifactPayload(
      JSON.stringify({
        entryUrl: 'http://[::ffff:7f00:1]:3456/artifact-runtime/host',
      }),
    ),
    {
      ok: false,
      code: 'policy_blocked',
      detail:
        'react bundle manifest entryUrl points at a shell-owned privileged path',
    },
  );
});
