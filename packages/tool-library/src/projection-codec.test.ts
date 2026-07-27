import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createToolLibraryProjectionBundle,
  parseToolLibraryProjectionManifestModule,
  parseToolLibraryProjectionPin,
  parseToolLibraryProjectionBundle,
  serializeToolLibraryProjectionBundle,
  serializeToolLibraryProjectionManifestModule,
  verifyToolLibraryProjectionManifest,
  verifyToolLibraryProjectionPinMatchesManifest,
  type ToolLibraryProjectionManifest,
  type ToolLibraryProjectionPin,
} from './projection-codec.js';

const MANIFEST: ToolLibraryProjectionManifest = {
  sdkVersion: 'tool-library-sdk-v1',
  sdkProjectionHash:
    'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
  sourceRegistryVersion: 'registry-v1',
  policyId: 'policy-v1',
  runtimeCompatibilityRange: '>=0.0.0',
  modelFacingCatalogRef: 'geulbat-sdk://catalog/test',
  importSpecifier: 'geulbat-sdk://tool-library/test',
  catalogModule: 'catalog.js',
  searchModule: 'search.js',
  searchRuntimeModule: 'search-runtime.js',
  indexDeclarationModule: 'index.d.ts',
  allowedPublicNames: ['fetch_url'],
  allowedRegistryNames: ['fetch_url'],
  allowedCallbackNames: ['fetch_url'],
  importableModules: [
    {
      specifier: 'geulbat-sdk://tool-library/test',
      module: 'index.js',
      role: 'index',
    },
    {
      specifier: 'geulbat-sdk://tool-library/test/tools/fetch-url',
      module: 'tools/fetch-url.js',
      role: 'wrapper',
    },
  ],
};

const BUNDLE_MANIFEST: ToolLibraryProjectionManifest = {
  ...MANIFEST,
  importableModules: [
    {
      specifier: 'geulbat-sdk://tool-library/test',
      module: 'index.js',
      role: 'index',
    },
    {
      specifier: 'geulbat-sdk://tool-library/test/manifest',
      module: 'manifest.js',
      role: 'manifest',
    },
    {
      specifier: 'geulbat-sdk://tool-library/test/tools/fetch-url',
      module: 'tools/fetch-url.js',
      role: 'wrapper',
    },
  ],
};

function createBundleFiles() {
  return [
    {
      path: 'manifest.js',
      role: 'manifest' as const,
      content: serializeToolLibraryProjectionManifestModule(BUNDLE_MANIFEST),
    },
    {
      path: 'index.js',
      role: 'index' as const,
      content: 'export const tools = ["fetch_url"];\n',
    },
    {
      path: 'tools/fetch-url.js',
      role: 'wrapper' as const,
      content: 'export async function fetchUrl() {}\n',
    },
  ];
}

void test('projection codec serializes and parses manifest modules', () => {
  const source = serializeToolLibraryProjectionManifestModule(MANIFEST);
  const parsed = parseToolLibraryProjectionManifestModule(source);

  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.ok ? parsed.manifest : null, MANIFEST);
});

void test('projection codec rejects traversal-shaped importable module paths', () => {
  const source = serializeToolLibraryProjectionManifestModule({
    ...MANIFEST,
    importableModules: [
      {
        specifier: 'geulbat-sdk://tool-library/test/escape',
        module: '../escape.js',
        role: 'wrapper',
      },
    ],
  });

  const parsed = parseToolLibraryProjectionManifestModule(source);

  assert.equal(parsed.ok, false);
  assert.equal(parsed.ok ? null : parsed.reason, 'manifest_invalid');
});

void test('projection codec verifies expected manifest equality', () => {
  const result = verifyToolLibraryProjectionManifest({
    manifest: MANIFEST,
    expectedManifest: {
      ...MANIFEST,
      searchModule: 'different.js',
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.ok ? null : result.reason, 'manifest_mismatch');
});

void test('projection codec parses pins and verifies pinned manifest fields', () => {
  const pin: ToolLibraryProjectionPin = {
    ...MANIFEST,
    projectionDirectory:
      'sha256-0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
  };

  const parsed = parseToolLibraryProjectionPin(JSON.stringify(pin));
  assert.equal(parsed.ok, true);

  const verified = verifyToolLibraryProjectionPinMatchesManifest({
    pin,
    manifest: MANIFEST,
  });
  assert.equal(verified.ok, true);

  const mismatch = verifyToolLibraryProjectionPinMatchesManifest({
    pin: {
      ...pin,
      searchRuntimeModule: 'different-runtime.js',
    },
    manifest: MANIFEST,
  });
  assert.equal(mismatch.ok, false);
  assert.equal(mismatch.ok ? null : mismatch.reason, 'pin_mismatch');
});

void test('projection codec round-trips one canonical portable bundle', () => {
  const bundle = createToolLibraryProjectionBundle({
    manifest: BUNDLE_MANIFEST,
    files: createBundleFiles(),
  });
  const serialized = serializeToolLibraryProjectionBundle(bundle);
  const parsed = parseToolLibraryProjectionBundle(serialized);

  assert.deepEqual(parsed, bundle);
  assert.match(bundle.bundleId, /^sha256:[0-9a-f]{64}$/u);
  assert.equal(serialized.includes('computerSessionId'), false);
  assert.equal(serialized.includes('threadId'), false);
  assert.equal(serialized.includes('runId'), false);
  assert.equal(serialized.includes('approvalGrant'), false);
  assert.equal(serialized.includes('approvalDecision'), false);
  assert.deepEqual(
    parsed.files.map(({ path }) => path),
    ['index.js', 'manifest.js', 'tools/fetch-url.js'],
  );
});

void test('projection codec rejects missing, extra, and traversal bundle files', () => {
  const files = createBundleFiles();
  assert.throws(
    () =>
      createToolLibraryProjectionBundle({
        manifest: BUNDLE_MANIFEST,
        files: files.slice(1),
      }),
    /file set does not match/u,
  );
  assert.throws(
    () =>
      createToolLibraryProjectionBundle({
        manifest: BUNDLE_MANIFEST,
        files: [
          ...files,
          {
            path: 'extra.js',
            role: 'wrapper',
            content: 'export {};\n',
          },
        ],
      }),
    /does not match the manifest/u,
  );
  assert.throws(
    () =>
      createToolLibraryProjectionBundle({
        manifest: {
          ...BUNDLE_MANIFEST,
          importableModules: [
            ...BUNDLE_MANIFEST.importableModules.slice(0, -1),
            {
              specifier: 'geulbat-sdk://tool-library/test/escape',
              module: '../escape.js',
              role: 'wrapper',
            },
          ],
        },
        files,
      }),
    /manifest is invalid/u,
  );
});

void test('projection codec rejects tampering and authority-shaped extra fields', () => {
  const serialized = serializeToolLibraryProjectionBundle(
    createToolLibraryProjectionBundle({
      manifest: BUNDLE_MANIFEST,
      files: createBundleFiles(),
    }),
  );

  assert.throws(
    () =>
      parseToolLibraryProjectionBundle(
        serialized.replace(
          'export const tools = [\\"fetch_url\\"];',
          'export const tools = [\\"tampered\\"];',
        ),
      ),
    /contentHash does not match/u,
  );
  assert.throws(
    () =>
      parseToolLibraryProjectionBundle(
        serialized.replace(
          '{"bundleId":',
          '{"approval":{"scope":"session"},"bundleId":',
        ),
      ),
    /unexpected or missing fields/u,
  );
});
