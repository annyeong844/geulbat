import test from 'node:test';
import assert from 'node:assert/strict';

import {
  readReactBundleArtifactInputPayload,
  validateReactBundleArtifactPayload,
} from './validator.js';
import { REACT_BUNDLE_ENTRY_URL } from './validator-test-support.js';

void test('validateReactBundleArtifactPayload accepts absolute https manifest payloads', () => {
  assert.deepEqual(
    validateReactBundleArtifactPayload(
      JSON.stringify({
        entryUrl: REACT_BUNDLE_ENTRY_URL,
      }),
    ),
    {
      ok: true,
      manifest: {
        entryUrl: REACT_BUNDLE_ENTRY_URL,
      },
    },
  );
});

void test('validateReactBundleArtifactPayload rejects empty payloads', () => {
  assert.deepEqual(validateReactBundleArtifactPayload('  '), {
    ok: false,
    code: 'boot_failed',
    detail: 'react bundle artifact payload is empty',
  });
});

void test('validateReactBundleArtifactPayload rejects malformed manifest JSON', () => {
  assert.deepEqual(validateReactBundleArtifactPayload('{'), {
    ok: false,
    code: 'boot_failed',
    detail: 'react bundle payload must be a JSON manifest object',
  });
});

void test('validateReactBundleArtifactPayload rejects missing or relative entry URLs', () => {
  assert.deepEqual(validateReactBundleArtifactPayload(JSON.stringify({})), {
    ok: false,
    code: 'boot_failed',
    detail: 'react bundle manifest requires a string entryUrl',
  });
  assert.deepEqual(
    validateReactBundleArtifactPayload(
      JSON.stringify({
        entryUrl: './entry.js',
      }),
    ),
    {
      ok: false,
      code: 'boot_failed',
      detail: 'react bundle manifest entryUrl must be an absolute URL',
    },
  );
});

void test('validateReactBundleArtifactPayload rejects inline source project manifests with files and entry', () => {
  assert.deepEqual(
    validateReactBundleArtifactPayload(
      JSON.stringify({
        files: {
          'App.jsx': 'export default function App() { return null; }',
          'styles.css': 'body { margin: 0; }',
        },
        entry: 'App.jsx',
      }),
    ),
    {
      ok: false,
      code: 'boot_failed',
      detail:
        'react bundle inline source manifests with files/entry are unsupported; current runtime requires {"entryUrl":"..."} for a prebuilt bundle',
    },
  );
});

void test('readReactBundleArtifactInputPayload accepts inline source project manifests for compile ingress', () => {
  assert.deepEqual(
    readReactBundleArtifactInputPayload(
      JSON.stringify({
        files: {
          'App.jsx': 'export default function App() { return null; }',
          'styles.css': 'body { margin: 0; }',
        },
        entry: 'App.jsx',
      }),
    ),
    {
      ok: true,
      kind: 'inline_source',
      input: {
        files: {
          'App.jsx': 'export default function App() { return null; }',
          'styles.css': 'body { margin: 0; }',
        },
        entry: 'App.jsx',
      },
    },
  );
});
