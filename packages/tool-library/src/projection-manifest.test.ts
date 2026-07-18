import assert from 'node:assert/strict';
import test from 'node:test';

import type {
  ToolLibraryProjectionImportableModule,
  ToolLibraryProjectionManifest,
} from './projection-codec.js';
import {
  getToolLibraryProjectionIdentity,
  getToolLibraryProjectionManifest,
  getToolLibraryProjectionPin,
  projectionDirectoryNameForHash,
  type ToolLibraryProjectionManifestSource,
} from './projection-manifest.js';

const importableModules: readonly ToolLibraryProjectionImportableModule[] = [
  {
    specifier: '@geulbat/generated-tools',
    module: 'index.js',
    role: 'index',
  },
];

const projectionHash =
  'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

const manifestSource: ToolLibraryProjectionManifestSource = {
  sdkVersion: 'tool-library-sdk-v1',
  sdkProjectionHash: projectionHash,
  sourceRegistryVersion: 'registry-v1',
  policyId: 'policy-v1',
  runtimeCompatibilityRange: '>=0.0.0',
  modelFacingCatalogRef: 'geulbat-sdk://catalog/test',
  importSpecifier: '@geulbat/generated-tools',
  allowedPublicNames: ['fetch_url'],
  allowedRegistryNames: ['fetch_url'],
  allowedCallbackNames: ['fetch_url'],
  importableModules,
};

void test('projection manifest construction owns generated module names', () => {
  const manifest = getToolLibraryProjectionManifest(manifestSource);

  assert.deepEqual(manifest, {
    ...manifestSource,
    catalogModule: 'catalog.js',
    searchModule: 'search.js',
    searchRuntimeModule: 'search-runtime.js',
    indexDeclarationModule: 'index.d.ts',
  } satisfies ToolLibraryProjectionManifest);
});

void test('projection pin construction owns hash-addressed directory naming', () => {
  const pin = getToolLibraryProjectionPin(manifestSource);

  assert.equal(
    pin.projectionDirectory,
    'sha256-0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
  );
  assert.equal(pin.catalogModule, 'catalog.js');
});

void test('projection identity omits host paths and generated files', () => {
  assert.deepEqual(
    getToolLibraryProjectionIdentity(
      getToolLibraryProjectionPin(manifestSource),
    ),
    {
      sdkVersion: 'tool-library-sdk-v1',
      sdkProjectionHash: projectionHash,
      policyId: 'policy-v1',
    },
  );
});

void test('projectionDirectoryNameForHash maps projection hashes to pin directories', () => {
  assert.equal(
    projectionDirectoryNameForHash(projectionHash),
    'sha256-0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
  );
});
