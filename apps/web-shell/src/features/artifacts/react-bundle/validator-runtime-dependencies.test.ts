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
  PRIVATE_ENTRY_URL,
  REMOTE_HTTP_FIXTURE_ENTRY_URL,
} from './validator-test-support.js';

void test('validateReactBundleArtifactPayload accepts runtime dependencies', () => {
  const manifest = {
    entryUrl: CDN_ENTRY_URL,
    runtimeDependencies: {
      importMap: {
        imports: {
          'canvas-confetti': 'https://esm.sh/canvas-confetti@1.9.3',
        },
      },
      stylesheets: [
        'https://cdn.jsdelivr.net/npm/water.css@2/out/water.css',
        'https://cdn.example.com/theme.css',
      ],
    },
  };

  assert.deepEqual(
    validateReactBundleArtifactPayload(JSON.stringify(manifest)),
    {
      ok: true,
      manifest,
    },
  );
});

void test('readReactBundleArtifactInputPayload keeps runtime dependencies on the manifest path', () => {
  const manifest = {
    entryUrl: CDN_ENTRY_URL,
    runtimeDependencies: {
      importMap: {
        imports: {
          'canvas-confetti': 'https://esm.sh/canvas-confetti@1.9.3',
        },
      },
      stylesheets: ['https://cdn.example.com/app.css'],
    },
  };

  assert.deepEqual(
    readReactBundleArtifactInputPayload(JSON.stringify(manifest)),
    {
      ok: true,
      kind: 'manifest',
      manifest,
    },
  );
});

void test('validateReactBundleArtifactPayload accepts personal web-shell http runtime dependency URLs', () => {
  const manifest = {
    entryUrl: CDN_ENTRY_URL,
    runtimeDependencies: {
      importMap: {
        imports: {
          'local-fixture': LOCAL_FIXTURE_ENTRY_URL,
          'local-generated': LOCAL_GENERATED_ENTRY_URL,
          'private-lan': PRIVATE_ENTRY_URL,
          'remote-http': REMOTE_HTTP_FIXTURE_ENTRY_URL,
        },
      },
      stylesheets: [
        'http://127.0.0.1:3456/public-web/react-bundle-counter/theme.css',
        'https://192.168.0.1/public-web/react-bundle-counter/theme.css',
      ],
    },
  };

  assert.deepEqual(
    validateReactBundleArtifactPayload(JSON.stringify(manifest)),
    {
      ok: true,
      manifest,
    },
  );
  assert.deepEqual(
    readReactBundleArtifactInputPayload(JSON.stringify(manifest)),
    {
      ok: true,
      kind: 'manifest',
      manifest,
    },
  );
});

void test('validateReactBundleArtifactPayload does not interpret top-level dependency aliases', () => {
  assert.deepEqual(
    validateReactBundleArtifactPayload(
      JSON.stringify({
        entryUrl: CDN_ENTRY_URL,
        stylesheetUrls: ['https://cdn.example.com/app.css'],
        cdnScripts: ['https://cdn.example.com/app.js'],
        externalCss: ['https://cdn.example.com/theme.css'],
        packageUrls: ['https://esm.sh/canvas-confetti@1.9.3'],
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

void test('validateReactBundleArtifactPayload rejects unsupported import map keys', () => {
  assert.deepEqual(
    validateReactBundleArtifactPayload(
      JSON.stringify({
        entryUrl: CDN_ENTRY_URL,
        runtimeDependencies: {
          importMap: {
            imports: {},
            scopes: {
              '/': {},
            },
          },
        },
      }),
    ),
    {
      ok: false,
      code: 'boot_failed',
      detail:
        'react bundle runtimeDependencies.importMap supports imports only',
    },
  );
});

void test('validateReactBundleArtifactPayload rejects malformed runtime dependencies', () => {
  assert.deepEqual(
    validateReactBundleArtifactPayload(
      JSON.stringify({
        entryUrl: CDN_ENTRY_URL,
        runtimeDependencies: {
          importMap: {
            imports: {
              '   ': 'https://esm.sh/canvas-confetti@1.9.3',
            },
          },
        },
      }),
    ),
    {
      ok: false,
      code: 'boot_failed',
      detail:
        'react bundle runtime dependency import specifier must be non-empty',
    },
  );

  assert.deepEqual(
    validateReactBundleArtifactPayload(
      JSON.stringify({
        entryUrl: CDN_ENTRY_URL,
        runtimeDependencies: {
          stylesheets: ['https://cdn.example.com/app.css', 42],
        },
      }),
    ),
    {
      ok: false,
      code: 'boot_failed',
      detail:
        'react bundle runtimeDependencies.stylesheets entries must be strings',
    },
  );
});

void test('validateReactBundleArtifactPayload applies shell-owned privileged URL policy to dependencies', () => {
  assert.deepEqual(
    validateReactBundleArtifactPayload(
      JSON.stringify({
        entryUrl: CDN_ENTRY_URL,
        runtimeDependencies: {
          importMap: {
            imports: {
              local: 'http://127.0.0.1:3456/artifact-runtime/host',
            },
          },
        },
      }),
    ),
    {
      ok: false,
      code: 'policy_blocked',
      detail:
        'react bundle runtime dependency URL points at a shell-owned privileged path',
    },
  );

  assert.deepEqual(
    validateReactBundleArtifactPayload(
      JSON.stringify({
        entryUrl: CDN_ENTRY_URL,
        runtimeDependencies: {
          stylesheets: ['http://127.0.0.1:3456/artifact-runtime/host'],
        },
      }),
    ),
    {
      ok: false,
      code: 'policy_blocked',
      detail:
        'react bundle runtime dependency URL points at a shell-owned privileged path',
    },
  );
});

void test('validateReactBundleArtifactPayload accepts generated runtime dependency URL schemes', () => {
  const manifest = {
    entryUrl: CDN_ENTRY_URL,
    runtimeDependencies: {
      importMap: {
        imports: {
          blob: 'blob:https://fixtures.geulbat.local/react-bundle-module',
          data: 'data:text/javascript,export default {}',
          file: 'file:///tmp/geulbat-runtime-dependency.js',
          javascript: 'javascript:globalThis.__geulbatDependency=1',
        },
      },
      stylesheets: [
        'blob:https://fixtures.geulbat.local/react-bundle-style',
        'data:text/css,.card%7Bcolor%3Ared%7D',
        'file:///tmp/geulbat-runtime-dependency.css',
        'javascript:globalThis.__geulbatStyle=1',
      ],
    },
  };

  assert.deepEqual(
    validateReactBundleArtifactPayload(JSON.stringify(manifest)),
    {
      ok: true,
      manifest,
    },
  );
  assert.deepEqual(
    readReactBundleArtifactInputPayload(JSON.stringify(manifest)),
    {
      ok: true,
      kind: 'manifest',
      manifest,
    },
  );
});
