import assert from 'node:assert/strict';
import test from 'node:test';

import {
  parseToolLibraryProjectionManifestModule,
  parseToolLibraryProjectionPin,
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
