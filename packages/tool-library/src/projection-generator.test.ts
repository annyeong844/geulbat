import assert from 'node:assert/strict';
import test from 'node:test';

import {
  type ToolLibraryProjectionManifest,
  parseToolLibraryProjectionManifestModule,
} from './projection-codec.js';
import type { ToolLibraryProjectionGeneratedTool } from './projection-descriptor.js';
import {
  buildToolLibraryProjectionFiles,
  buildToolLibraryProjectionImportableModules,
  TOOL_LIBRARY_PROJECTION_GENERATOR_VERSION,
} from './projection-generator.js';

const sampleTool: ToolLibraryProjectionGeneratedTool = {
  publicName: 'fetch_url',
  registryName: 'fetch_url',
  callbackName: 'fetch_url',
  summary: 'Fetch one public URL.',
  signatureRef: 'fetch_url@sha256:abc',
  signatureModule: 'signatures/fetch-url.js',
  signatureImportSpecifier: '@geulbat/generated-tools/signatures/fetch-url',
  signatureDeclarationModule: 'signatures/fetch-url.d.ts',
  signatureDeclarationImportSpecifier:
    '@geulbat/generated-tools/signatures/fetch-url.d.ts',
  signatureExportName: 'fetchUrlSignature',
  wrapperModule: 'tools/fetch-url.js',
  wrapperImportSpecifier: '@geulbat/generated-tools/tools/fetch-url',
  wrapperDeclarationModule: 'tools/fetch-url.d.ts',
  wrapperDeclarationImportSpecifier:
    '@geulbat/generated-tools/tools/fetch-url.d.ts',
  wrapperExportName: 'fetchUrl',
  argsTypeName: 'FetchUrlArgs',
  sideEffectLevel: 'read',
  approvalClass: 'approval_free',
  mayMutateComputerFiles: false,
  family: 'network',
  searchHints: ['fetch url', 'open webpage'],
  tags: ['network'],
  whenToUse: 'Fetch a known public HTTP URL.',
  notFor: 'Do not search the web.',
  parameters: {
    type: 'object',
    properties: {
      url: { type: 'string' },
      timeoutMs: { type: 'integer' },
      responseMode: { enum: ['text', 'headers'] },
    },
    required: ['url'],
    additionalProperties: false,
  },
};

const sampleProjectionHash =
  'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

const sampleManifest: ToolLibraryProjectionManifest = {
  sdkVersion: 'tool-library-projection-v1',
  sdkProjectionHash: sampleProjectionHash,
  policyId: 'tool-library-projection-policy-v1',
  sourceRegistryVersion: 'registry-v1',
  runtimeCompatibilityRange: '>=0.0.0',
  modelFacingCatalogRef: `catalog@${sampleProjectionHash}`,
  importSpecifier: '@geulbat/generated-tools',
  catalogModule: 'catalog.js',
  searchModule: 'search.js',
  searchRuntimeModule: 'search-runtime.js',
  indexDeclarationModule: 'index.d.ts',
  allowedPublicNames: ['fetch_url'],
  allowedRegistryNames: ['fetch_url'],
  allowedCallbackNames: ['fetch_url'],
  importableModules: [],
};

void test('projection generator builds importable module descriptors', () => {
  assert.equal(
    TOOL_LIBRARY_PROJECTION_GENERATOR_VERSION,
    'geulbat-tool-library-projection-v10',
  );
  const importableModules = buildToolLibraryProjectionImportableModules({
    importSpecifier: '@geulbat/generated-tools',
    tools: [sampleTool],
  });

  assert.deepEqual(
    importableModules.map(({ role }) => role),
    [
      'index',
      'catalog',
      'search',
      'search_runtime',
      'manifest',
      'index_declaration',
      'signature',
      'signature_declaration',
      'wrapper',
      'wrapper_declaration',
    ],
  );
  assert.equal(importableModules[0]?.specifier, '@geulbat/generated-tools');
  assert.equal(
    importableModules.find(({ role }) => role === 'manifest')?.specifier,
    '@geulbat/generated-tools/manifest',
  );
});

void test('projection generator emits importable files from descriptors', async () => {
  const files = buildToolLibraryProjectionFiles({
    projectionManifest: sampleManifest,
    tools: [sampleTool],
  });
  const byPath = new Map(files.map((file) => [file.path, file]));

  assert.equal(byPath.get('manifest.js')?.role, 'manifest');
  assert.equal(byPath.get('catalog.js')?.role, 'catalog');
  assert.equal(byPath.get('search-runtime.js')?.role, 'search_runtime');
  assert.equal(byPath.get('index.js')?.role, 'index');
  assert.equal(byPath.get('index.d.ts')?.role, 'declaration');
  assert.equal(byPath.get('tools/fetch-url.js')?.role, 'wrapper');
  assert.equal(byPath.get('signatures/fetch-url.js')?.role, 'signature');

  const manifestFile = byPath.get('manifest.js');
  assert.ok(manifestFile);
  const parsedManifest = parseToolLibraryProjectionManifestModule(
    manifestFile.content,
  );
  assert.equal(parsedManifest.ok, true);
  if (parsedManifest.ok) {
    assert.equal(
      parsedManifest.manifest.sdkProjectionHash,
      sampleProjectionHash,
    );
  }

  assert.equal(byPath.get('catalog.js')?.content.includes('whenToUse'), true);
  assert.equal(
    byPath
      .get('search-runtime.js')
      ?.content.includes('searchRankedToolCatalog'),
    true,
  );
  assert.equal(
    byPath.get('tools/fetch-url.js')?.content.includes('normalizeToolResult'),
    true,
  );
  assert.equal(
    byPath
      .get('tools/fetch-url.d.ts')
      ?.content.includes('"timeoutMs"?: number'),
    true,
  );

  const signatureModule = byPath.get('signatures/fetch-url.js');
  assert.ok(signatureModule);
  const importedSignature = (await import(
    `data:text/javascript;base64,${Buffer.from(
      signatureModule.content,
    ).toString('base64')}`
  )) as { signature: { invocationExample?: unknown } };
  assert.equal(
    importedSignature.signature.invocationExample,
    [
      'if (!geulbat.help().callbacks.enabled) throw new Error("PTC callbacks unavailable");',
      'const { fetchUrl } = require("@geulbat/generated-tools/tools/fetch-url");',
      'return await fetchUrl({ /* arguments matching parameters */ });',
    ].join('\n'),
  );
  assert.equal(
    byPath
      .get('signatures/fetch-url.d.ts')
      ?.content.includes('readonly invocationExample:'),
    true,
  );
});
