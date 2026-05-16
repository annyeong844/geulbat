import test from 'node:test';
import assert from 'node:assert/strict';
import { PUBLIC_WEB_REACT_BUNDLE_COUNTER_ENTRY_PATH } from '@geulbat/protocol/public-web-fixtures';
import { PUBLIC_GENERATED_REACT_BUNDLE_INLINE_PATH_PREFIX } from '@geulbat/protocol/react-bundle-inline-compile';

import {
  readReactBundleArtifactInputPayload,
  validateReactBundleArtifactPayload,
} from './validator.js';

const REACT_BUNDLE_ENTRY_URL = `https://fixtures.geulbat.local${PUBLIC_WEB_REACT_BUNDLE_COUNTER_ENTRY_PATH}`;
const LOCAL_FIXTURE_ENTRY_URL = `http://127.0.0.1:3456${PUBLIC_WEB_REACT_BUNDLE_COUNTER_ENTRY_PATH}`;
const LOCAL_GENERATED_ENTRY_URL = `http://127.0.0.1:3456${PUBLIC_GENERATED_REACT_BUNDLE_INLINE_PATH_PREFIX}cache-key/entry.js`;
const CDN_ENTRY_URL = 'https://cdn.example.com/react-entry.js';

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
        entryUrl: `http://[::ffff:7f00:1]:3456${PUBLIC_WEB_REACT_BUNDLE_COUNTER_ENTRY_PATH}`,
      }),
    ),
    {
      ok: true,
      manifest: {
        entryUrl: `http://[::ffff:7f00:1]:3456${PUBLIC_WEB_REACT_BUNDLE_COUNTER_ENTRY_PATH}`,
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

void test('validateReactBundleArtifactPayload accepts arbitrary http entry URLs outside explicit shell-owned privileged paths', () => {
  assert.deepEqual(
    validateReactBundleArtifactPayload(
      JSON.stringify({
        entryUrl: `http://fixtures.geulbat.local${PUBLIC_WEB_REACT_BUNDLE_COUNTER_ENTRY_PATH}`,
      }),
    ),
    {
      ok: true,
      manifest: {
        entryUrl: `http://fixtures.geulbat.local${PUBLIC_WEB_REACT_BUNDLE_COUNTER_ENTRY_PATH}`,
      },
    },
  );
});

void test('validateReactBundleArtifactPayload accepts private and generated absolute entry URLs at shell preflight', () => {
  assert.deepEqual(
    validateReactBundleArtifactPayload(
      JSON.stringify({
        entryUrl: `https://192.168.0.1${PUBLIC_WEB_REACT_BUNDLE_COUNTER_ENTRY_PATH}`,
      }),
    ),
    {
      ok: true,
      manifest: {
        entryUrl: `https://192.168.0.1${PUBLIC_WEB_REACT_BUNDLE_COUNTER_ENTRY_PATH}`,
      },
    },
  );
  assert.deepEqual(
    validateReactBundleArtifactPayload(
      JSON.stringify({
        entryUrl: 'javascript:globalThis.__geulbatTest__=1',
      }),
    ),
    {
      ok: true,
      manifest: {
        entryUrl: 'javascript:globalThis.__geulbatTest__=1',
      },
    },
  );
  assert.deepEqual(
    validateReactBundleArtifactPayload(
      JSON.stringify({
        entryUrl: 'file:///tmp/react-entry.js',
      }),
    ),
    {
      ok: true,
      manifest: {
        entryUrl: 'file:///tmp/react-entry.js',
      },
    },
  );
  assert.deepEqual(
    validateReactBundleArtifactPayload(
      JSON.stringify({
        entryUrl: 'data:text/javascript,export default {}',
      }),
    ),
    {
      ok: true,
      manifest: {
        entryUrl: 'data:text/javascript,export default {}',
      },
    },
  );
  assert.deepEqual(
    validateReactBundleArtifactPayload(
      JSON.stringify({
        entryUrl: 'blob:https://fixtures.geulbat.local/react-bundle-entry',
      }),
    ),
    {
      ok: true,
      manifest: {
        entryUrl: 'blob:https://fixtures.geulbat.local/react-bundle-entry',
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
