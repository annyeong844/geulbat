import assert from 'node:assert/strict';
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

import { createBuiltinToolRegistryStore } from './builtin/catalog.js';
import {
  buildToolSearchCatalog,
  searchToolCatalog,
  type ToolSearchCatalogCard,
} from './builtin/tool-search.js';
import { createToolRegistryStore } from './registry.js';
import {
  buildToolLibraryProjection,
  createToolLibraryProjectionPort,
} from './tool-library-projection.js';
import { buildToolSignatureRef } from '@geulbat/tool-library/projection-signature';
import type {
  BuildToolLibraryProjectionArgs,
  ToolLibraryProjection,
} from './tool-library-projection-port.js';
import {
  getToolLibraryProjectionManifest,
  getToolLibraryProjectionIdentity,
  getToolLibraryProjectionPin,
} from '@geulbat/tool-library/projection-manifest';
import {
  getToolLibraryProjectionMount,
  resolveToolLibraryProjectionMountedModule,
} from './tool-library-projection-mount.js';
import {
  readVerifiedToolLibraryProjectionMount,
  writeToolLibraryProjectionFiles,
} from './tool-library-projection-store.js';
import {
  isToolObjectParameters,
  type AnyTool,
  type ToolParameters,
} from './types.js';

const BASE_PROJECTION_ARGS = {
  sdkVersion: 'sdk-test-v1',
  sourceRegistryVersion: 'registry-test-v1',
  policyId: 'test-readonly-policy',
  runtimeCompatibilityRange: 'daemon-test-runtime',
  rootPath: '/private/geulbat/generated-tools',
  catalogPath: '/private/geulbat/generated-tools/catalog.js',
  modelFacingCatalogRef: 'geulbat-sdk://catalog',
  importSpecifier: '@geulbat/generated-tools',
} as const;

void test('buildToolLibraryProjection materializes a one-tool SDK surface from the registry', () => {
  const projection = buildTestProjection({
    registry: createBuiltinToolRegistryStore(),
    allowedRegistryNames: ['read_file'],
  });

  assert.equal(projection.sdkVersion, BASE_PROJECTION_ARGS.sdkVersion);
  assert.match(projection.sdkProjectionHash, /^sha256:[0-9a-f]{64}$/u);
  assert.deepEqual(projection.allowedPublicNames, ['read_file']);
  assert.deepEqual(projection.allowedRegistryNames, ['read_file']);
  assert.deepEqual(projection.allowedCallbackNames, ['read_file']);

  const tool = projection.tools[0];
  assert.ok(tool);
  assert.equal(tool.publicName, 'read_file');
  assert.equal(tool.registryName, 'read_file');
  assert.equal(tool.callbackName, 'read_file');
  assert.equal(tool.signatureRef, buildToolSignatureRef('read_file'));
  assert.equal(tool.signatureModule, 'signatures/read-file.js');
  assert.equal(
    tool.signatureImportSpecifier,
    '@geulbat/generated-tools/signatures/read-file',
  );
  assert.equal(tool.signatureDeclarationModule, 'signatures/read-file.d.ts');
  assert.equal(
    tool.signatureDeclarationImportSpecifier,
    '@geulbat/generated-tools/signatures/read-file.d.ts',
  );
  assert.equal(tool.signatureExportName, 'readFileSignature');
  assert.equal(tool.wrapperModule, 'files/readFile.js');
  assert.equal(
    tool.wrapperImportSpecifier,
    '@geulbat/generated-tools/files/readFile',
  );
  assert.equal(tool.wrapperDeclarationModule, 'files/readFile.d.ts');
  assert.equal(
    tool.wrapperDeclarationImportSpecifier,
    '@geulbat/generated-tools/files/readFile.d.ts',
  );
  assert.equal(tool.wrapperExportName, 'readFile');
  assert.equal(tool.argsTypeName, 'ReadFileArgs');
  assert.equal(tool.family, 'file');
  assert.equal(tool.approvalClass, 'approval_free');
  assert.equal(isToolObjectParameters(tool.parameters), true);

  assert.deepEqual(
    projection.files.map((file) => [file.path, file.role]),
    [
      ['manifest.js', 'manifest'],
      ['catalog.js', 'catalog'],
      ['search.js', 'search'],
      ['search-runtime.js', 'search_runtime'],
      ['index.js', 'index'],
      ['index.d.ts', 'declaration'],
      ['signatures/read-file.js', 'signature'],
      ['signatures/read-file.d.ts', 'declaration'],
      ['files/readFile.js', 'wrapper'],
      ['files/readFile.d.ts', 'declaration'],
    ],
  );

  const manifest = projection.files.find((file) => file.path === 'manifest.js');
  assert.ok(manifest);
  assert.equal(manifest.content.includes('/private/geulbat'), false);
  assert.equal(
    manifest.content.includes('export const projectionManifest'),
    true,
  );
  assert.equal(manifest.content.includes('"catalogModule":"catalog.js"'), true);
  assert.equal(manifest.content.includes('"searchModule":"search.js"'), true);
  assert.equal(
    manifest.content.includes('"searchRuntimeModule":"search-runtime.js"'),
    true,
  );
  assert.equal(
    manifest.content.includes('"indexDeclarationModule":"index.d.ts"'),
    true,
  );
  assert.equal(
    manifest.content.includes(
      '"specifier":"@geulbat/generated-tools/files/readFile"',
    ),
    true,
  );
  assert.equal(
    manifest.content.includes(
      '"modelFacingCatalogRef":"geulbat-sdk://catalog"',
    ),
    true,
  );
  assert.equal(
    manifest.content.includes('"allowedPublicNames":["read_file"]'),
    true,
  );

  const catalog = projection.files.find((file) => file.path === 'catalog.js');
  assert.ok(catalog);
  assert.match(catalog.content, /sdkProjectionHash/);
  assert.match(catalog.content, /read_file/);
  assert.match(catalog.content, /signatures\/read-file\.js/);
  assert.match(
    catalog.content,
    /@geulbat\/generated-tools\/signatures\/read-file/,
  );
  assert.match(catalog.content, /signatures\/read-file\.d\.ts/);
  assert.match(catalog.content, /files\/readFile\.js/);
  assert.match(catalog.content, /@geulbat\/generated-tools\/files\/readFile/);
  assert.match(catalog.content, /files\/readFile\.d\.ts/);
  assert.match(catalog.content, /"whenToUse"/);
  assert.match(catalog.content, /"notFor"/);
  assert.match(catalog.content, /"summary"/);
  assert.equal(catalog.content.includes('/private/geulbat'), false);

  const search = projection.files.find((file) => file.path === 'search.js');
  assert.ok(search);
  assert.equal(search.content.includes('/private/geulbat'), false);
  assert.equal(
    search.content.includes('import { searchRankedToolCatalog }'),
    true,
  );
  assert.equal(search.content.includes('export function searchTools'), true);
  assert.equal(search.content.includes('const BM25_K1 = 1.2;'), false);
  const searchRuntime = projection.files.find(
    (file) => file.path === 'search-runtime.js',
  );
  assert.ok(searchRuntime);
  assert.equal(searchRuntime.content.includes('/private/geulbat'), false);
  assert.equal(searchRuntime.content.includes('const BM25_K1 = 1.2;'), true);
  assert.equal(searchRuntime.content.includes('whenToUse'), true);
  assert.equal(
    search.content.includes('return left.card.publicName.localeCompare'),
    false,
  );

  const index = projection.files.find((file) => file.path === 'index.js');
  assert.ok(index);
  assert.equal(index.content.includes('./manifest.js'), true);
  assert.equal(index.content.includes('./catalog.js'), true);
  assert.equal(index.content.includes('./search.js'), true);
  assert.equal(index.content.includes('./files/readFile.js'), true);
  assert.equal(index.content.includes('./signatures/read-file.js'), true);

  const indexDeclaration = projection.files.find(
    (file) => file.path === 'index.d.ts',
  );
  assert.ok(indexDeclaration);
  assert.equal(indexDeclaration.content.includes('/private/geulbat'), false);
  assert.equal(
    indexDeclaration.content.includes('export declare const catalog'),
    true,
  );
  assert.equal(
    indexDeclaration.content.includes(
      'export { signature as readFileSignature } from "./signatures/read-file.js";',
    ),
    true,
  );
  assert.equal(
    indexDeclaration.content.includes(
      'export { readFile } from "./files/readFile.js";',
    ),
    true,
  );
  assert.equal(
    indexDeclaration.content.includes(
      'export type { ReadFileArgs } from "./files/readFile.js";',
    ),
    true,
  );

  const signature = projection.files.find(
    (file) => file.path === 'signatures/read-file.js',
  );
  assert.ok(signature);
  assert.equal(signature.content.includes('/private/geulbat'), false);
  assert.equal(signature.content.includes('export const signature'), true);
  assert.equal(signature.content.includes('"publicName":"read_file"'), true);
  assert.equal(
    signature.content.includes(
      '"signatureRef":"geulbat-sdk://signature/read_file"',
    ),
    true,
  );
  assert.equal(
    signature.content.includes('"signatureModule":"signatures/read-file.js"'),
    true,
  );
  assert.equal(
    signature.content.includes(
      '"signatureDeclarationModule":"signatures/read-file.d.ts"',
    ),
    true,
  );
  assert.equal(
    signature.content.includes(
      '"wrapperDeclarationModule":"files/readFile.d.ts"',
    ),
    true,
  );
  assert.equal(signature.content.includes('"parameters"'), true);
  assert.equal(
    signature.content.includes('export type { ReadFileArgs }'),
    false,
  );

  const declaration = projection.files.find(
    (file) => file.path === 'signatures/read-file.d.ts',
  );
  assert.ok(declaration);
  assert.equal(declaration.content.includes('/private/geulbat'), false);
  assert.equal(
    declaration.content.includes(
      'export type { ReadFileArgs } from "../files/readFile.js";',
    ),
    true,
  );
  assert.equal(
    declaration.content.includes('export interface ReadFileToolSignature'),
    true,
  );
  assert.equal(
    declaration.content.includes('readonly args: ReadFileArgs;'),
    true,
  );
  assert.equal(
    declaration.content.includes(
      'readonly signatureDeclarationModule: "signatures/read-file.d.ts";',
    ),
    true,
  );
  assert.equal(
    declaration.content.includes(
      'readonly wrapperDeclarationModule: "files/readFile.d.ts";',
    ),
    true,
  );

  const wrapper = projection.files.find(
    (file) => file.path === 'files/readFile.js',
  );
  assert.ok(wrapper);
  assert.equal(wrapper.content.includes('export interface'), false);
  assert.equal(wrapper.content.includes('/**'), false);
  assert.equal(wrapper.content.includes('"parameters"'), false);
  assert.equal(wrapper.content.includes('"signatureRef"'), false);
  assert.equal(wrapper.content.includes('"searchHints"'), false);
  assert.equal(wrapper.content.includes('"path"'), false);
  assert.equal(
    wrapper.content.includes('export async function readFile(args)'),
    true,
  );
  assert.equal(
    wrapper.content.includes('await callTool("read_file", args);'),
    true,
  );
  assert.equal(
    wrapper.content.includes('return normalizeToolResult(result);'),
    true,
  );
  assert.equal(wrapper.content.includes('kind: "offloaded"'), true);
  assert.equal(
    wrapper.content.includes('return { kind: "inline", value: result };'),
    true,
  );

  const wrapperDeclaration = projection.files.find(
    (file) => file.path === 'files/readFile.d.ts',
  );
  assert.ok(wrapperDeclaration);
  assert.equal(wrapperDeclaration.content.includes('/private/geulbat'), false);
  assert.match(wrapperDeclaration.content, /export interface ReadFileArgs/);
  assert.match(wrapperDeclaration.content, /"path": string;/);
  assert.doesNotMatch(wrapperDeclaration.content, /"root"\??:/);
  assert.equal(
    wrapperDeclaration.content.includes('export type GeulbatToolResult ='),
    true,
  );
  assert.equal(
    wrapperDeclaration.content.includes('export declare function readFile('),
    true,
  );
  assert.equal(wrapperDeclaration.content.includes('GeulbatToolCaller'), false);
  assert.equal(
    wrapperDeclaration.content.includes('): Promise<GeulbatToolResult>;'),
    true,
  );
});

void test('buildToolLibraryProjection hash is stable across caller path and name ordering', () => {
  const registry = createBuiltinToolRegistryStore();
  const left = buildTestProjection({
    registry,
    allowedRegistryNames: ['fetch_url', 'read_file'],
  });
  const right = buildToolLibraryProjection({
    ...BASE_PROJECTION_ARGS,
    registry,
    allowedRegistryNames: ['read_file', 'fetch_url'],
    rootPath: '/another/private/root',
    catalogPath: '/another/private/root/catalog.js',
  });

  assert.equal(left.sdkProjectionHash, right.sdkProjectionHash);
  assert.deepEqual(left.allowedRegistryNames, ['fetch_url', 'read_file']);
  assert.deepEqual(right.allowedRegistryNames, ['fetch_url', 'read_file']);
});

void test('buildToolLibraryProjection hash changes when registry schema changes', () => {
  const base = buildTestProjection({
    registry: createToolRegistryStore({
      builtins: [createProjectionTestTool({ includeExtraParameter: false })],
    }),
    allowedRegistryNames: ['projection_test'],
  });
  const changed = buildTestProjection({
    registry: createToolRegistryStore({
      builtins: [createProjectionTestTool({ includeExtraParameter: true })],
    }),
    allowedRegistryNames: ['projection_test'],
  });

  assert.notEqual(base.sdkProjectionHash, changed.sdkProjectionHash);
});

void test('buildToolLibraryProjection rejects unknown registry names instead of creating aliases', () => {
  assert.throws(
    () =>
      buildTestProjection({
        registry: createBuiltinToolRegistryStore(),
        allowedRegistryNames: ['web_fetch'],
      }),
    /unknown tools: web_fetch/u,
  );
});

void test('getToolLibraryProjectionIdentity omits host paths and generated content', () => {
  const projection = buildTestProjection({
    registry: createBuiltinToolRegistryStore(),
    allowedRegistryNames: ['read_file'],
  });

  assert.deepEqual(getToolLibraryProjectionIdentity(projection), {
    sdkVersion: projection.sdkVersion,
    sdkProjectionHash: projection.sdkProjectionHash,
    policyId: projection.policyId,
  });
  assert.deepEqual(Object.keys(getToolLibraryProjectionIdentity(projection)), [
    'sdkVersion',
    'sdkProjectionHash',
    'policyId',
  ]);
});

void test('writeToolLibraryProjectionFiles writes generated SDK files under the projection root', async () => {
  const rootPath = await mkdtemp(join(tmpdir(), 'geulbat-tool-library-'));
  try {
    const projection = buildToolLibraryProjection({
      ...BASE_PROJECTION_ARGS,
      registry: createBuiltinToolRegistryStore(),
      allowedRegistryNames: ['read_file'],
      rootPath,
      catalogPath: join(rootPath, 'catalog.js'),
    });

    const result = await writeToolLibraryProjectionFiles(projection);

    assert.deepEqual(result, {
      rootPath,
      writtenFiles: projection.files.map((file) => file.path),
    });

    for (const file of projection.files) {
      assert.equal(
        await readFile(join(rootPath, ...file.path.split('/')), 'utf8'),
        file.content,
      );
    }
  } finally {
    await rm(rootPath, { recursive: true, force: true });
  }
});

void test('createToolLibraryProjectionPort writes a pinned projection under the runtime root', async () => {
  const stateRoot = await mkdtemp(join(tmpdir(), 'geulbat-tool-library-'));
  try {
    const runtime = createToolLibraryProjectionPort({
      registry: createBuiltinToolRegistryStore(),
      runtimeRootForState(root) {
        return join(root, '.geulbat', 'tool-library', 'projections');
      },
      sdkVersion: BASE_PROJECTION_ARGS.sdkVersion,
      sourceRegistryVersion: BASE_PROJECTION_ARGS.sourceRegistryVersion,
      runtimeCompatibilityRange: BASE_PROJECTION_ARGS.runtimeCompatibilityRange,
      modelFacingCatalogRef: BASE_PROJECTION_ARGS.modelFacingCatalogRef,
      importSpecifier: BASE_PROJECTION_ARGS.importSpecifier,
    });

    const result = await runtime.resolveProjection({
      stateRoot,
      threadId: 'thread-runtime-test',
      allowedRegistryNames: ['read_file'],
    });

    assert.equal(result.ok, true);
    if (!result.ok) {
      assert.fail('expected projection port to resolve');
    }
    assert.match(
      result.projection.rootPath,
      /\.geulbat[\\/]+tool-library[\\/]+projections[\\/]+thread-[0-9a-f]{16}[\\/]+sha256-[0-9a-f]{64}$/u,
    );
    assert.equal(
      result.projection.rootPath.includes('thread-runtime-test'),
      false,
    );
    assert.deepEqual(result.writtenFiles, [
      'manifest.js',
      'catalog.js',
      'search.js',
      'search-runtime.js',
      'index.js',
      'index.d.ts',
      'signatures/read-file.js',
      'signatures/read-file.d.ts',
      'files/readFile.js',
      'files/readFile.d.ts',
    ]);
    assert.deepEqual(
      result.pin,
      getToolLibraryProjectionPin(result.projection),
    );
    assert.equal(
      await readFile(join(result.projection.rootPath, 'manifest.js'), 'utf8'),
      result.projection.files.find((file) => file.path === 'manifest.js')
        ?.content,
    );
    assert.equal(
      containsStringValue(
        getToolLibraryProjectionIdentity(result.projection),
        stateRoot,
      ),
      false,
    );

    const threadProjectionRootPath = dirname(result.projection.rootPath);
    const expectedPin = getToolLibraryProjectionPin(result.projection);
    const mountResult = await readVerifiedToolLibraryProjectionMount({
      threadProjectionRootPath,
      expectedPin,
      importSpecifier: BASE_PROJECTION_ARGS.importSpecifier,
    });
    assert.equal(mountResult.ok, true);
    if (!mountResult.ok) {
      assert.fail('expected projection mount verification to succeed');
    }
    assert.deepEqual(mountResult.pin, expectedPin);
    assert.deepEqual(
      mountResult.manifest,
      getToolLibraryProjectionManifest(result.projection),
    );
    assert.equal(
      mountResult.pin.projectionDirectory,
      basename(result.projection.rootPath),
    );
    assert.equal(containsStringValue(mountResult.pin, stateRoot), false);
    assert.equal(
      containsStringValue(mountResult.pin, 'thread-runtime-test'),
      false,
    );
    assert.deepEqual(
      mountResult.mount,
      getToolLibraryProjectionMount({
        pin: expectedPin,
        projectionRootPath: result.projection.rootPath,
      }),
    );
    assert.equal(mountResult.mount.importSpecifier, '@geulbat/generated-tools');
    assert.equal(
      mountResult.mount.indexModulePath,
      join(result.projection.rootPath, 'index.js'),
    );
    assert.equal(containsStringValue(mountResult.mount, stateRoot), true);
    assert.equal(
      containsStringValue(
        {
          sdkVersion: mountResult.mount.sdkVersion,
          sdkProjectionHash: mountResult.mount.sdkProjectionHash,
          policyId: mountResult.mount.policyId,
          importSpecifier: mountResult.mount.importSpecifier,
          modelFacingCatalogRef: mountResult.mount.modelFacingCatalogRef,
        },
        stateRoot,
      ),
      false,
    );
  } finally {
    await rm(stateRoot, { recursive: true, force: true });
  }
});

void test('createToolLibraryProjectionPort builds the written projection from one registry pass', async () => {
  const stateRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-tool-library-single-pass-'),
  );
  const baseRegistry = createBuiltinToolRegistryStore();
  let registeredNamesReadCount = 0;
  const resolvedToolNames: string[] = [];
  try {
    const runtime = createToolLibraryProjectionPort({
      registry: {
        getAllRegisteredToolNames() {
          registeredNamesReadCount += 1;
          return baseRegistry.getAllRegisteredToolNames();
        },
        getTool(name) {
          resolvedToolNames.push(name);
          return baseRegistry.getTool(name);
        },
      },
      runtimeRootForState(root) {
        return join(root, '.geulbat', 'tool-library', 'projections');
      },
      sdkVersion: BASE_PROJECTION_ARGS.sdkVersion,
      sourceRegistryVersion: BASE_PROJECTION_ARGS.sourceRegistryVersion,
      runtimeCompatibilityRange: BASE_PROJECTION_ARGS.runtimeCompatibilityRange,
      modelFacingCatalogRef: BASE_PROJECTION_ARGS.modelFacingCatalogRef,
      importSpecifier: BASE_PROJECTION_ARGS.importSpecifier,
    });

    const result = await runtime.resolveProjection({
      stateRoot,
      threadId: 'thread-single-pass-test',
      allowedRegistryNames: ['read_file', 'list_files'],
    });

    assert.equal(result.ok, true);
    assert.equal(registeredNamesReadCount, 1);
    assert.deepEqual(resolvedToolNames, ['list_files', 'read_file']);
  } finally {
    await rm(stateRoot, { recursive: true, force: true });
  }
});

void test('createToolLibraryProjectionPort keeps projection catch diagnostics sanitized', async () => {
  const projectionError = new Error(
    'raw /private/geulbat/token-value should not leak',
  ) as Error & { code: string };
  projectionError.code = 'EACCES';
  const runtime = createToolLibraryProjectionPort({
    registry: createBuiltinToolRegistryStore(),
    runtimeRootForState() {
      throw projectionError;
    },
    sdkVersion: BASE_PROJECTION_ARGS.sdkVersion,
    sourceRegistryVersion: BASE_PROJECTION_ARGS.sourceRegistryVersion,
    runtimeCompatibilityRange: BASE_PROJECTION_ARGS.runtimeCompatibilityRange,
    modelFacingCatalogRef: BASE_PROJECTION_ARGS.modelFacingCatalogRef,
    importSpecifier: BASE_PROJECTION_ARGS.importSpecifier,
  });

  const resolved = await runtime.resolveProjection({
    stateRoot: '/private/geulbat',
    threadId: 'thread-projection-failure',
    allowedRegistryNames: ['read_file'],
  });
  assert.deepEqual(resolved, {
    ok: false,
    reason: 'projection_failed',
    message: 'Tool library projection failed',
    diagnostics: { errorCode: 'EACCES', errorName: 'Error' },
  });
  assert.equal(containsStringValue(resolved, '/private/geulbat'), false);
  assert.equal(containsStringValue(resolved, 'token-value'), false);

  const rehydrated = await runtime.rehydrateProjectionMount({
    stateRoot: '/private/geulbat',
    threadId: 'thread-projection-failure',
    expectedIdentity: {
      sdkVersion: BASE_PROJECTION_ARGS.sdkVersion,
      sdkProjectionHash:
        'sha256:0000000000000000000000000000000000000000000000000000000000000000',
      policyId: 'test-policy',
    },
  });
  assert.deepEqual(rehydrated, {
    ok: false,
    reason: 'projection_failed',
    message: 'Tool library projection rehydration failed',
    diagnostics: { errorCode: 'EACCES', errorName: 'Error' },
  });
  assert.equal(containsStringValue(rehydrated, '/private/geulbat'), false);
  assert.equal(containsStringValue(rehydrated, 'token-value'), false);
});

void test('createToolLibraryProjectionPort drops token-shaped projection diagnostics', async () => {
  const tokenShapedCode = 'TOKEN_SHAPED_DIAGNOSTIC_123456';
  const tokenShapedName = [
    'ghp',
    'projectionDiagnosticTokenShouldNotLeak',
  ].join('_');
  const runtime = createToolLibraryProjectionPort({
    registry: createBuiltinToolRegistryStore(),
    runtimeRootForState() {
      throw {
        code: tokenShapedCode,
        name: tokenShapedName,
      };
    },
    sdkVersion: BASE_PROJECTION_ARGS.sdkVersion,
    sourceRegistryVersion: BASE_PROJECTION_ARGS.sourceRegistryVersion,
    runtimeCompatibilityRange: BASE_PROJECTION_ARGS.runtimeCompatibilityRange,
    modelFacingCatalogRef: BASE_PROJECTION_ARGS.modelFacingCatalogRef,
    importSpecifier: BASE_PROJECTION_ARGS.importSpecifier,
  });

  const result = await runtime.resolveProjection({
    stateRoot: '/private/geulbat',
    threadId: 'thread-token-shaped-diagnostics',
    allowedRegistryNames: ['read_file'],
  });

  assert.deepEqual(result, {
    ok: false,
    reason: 'projection_failed',
    message: 'Tool library projection failed',
  });
  assert.equal(containsStringValue(result, tokenShapedCode), false);
  assert.equal(containsStringValue(result, tokenShapedName), false);
});

void test('createToolLibraryProjectionPort keeps a live thread pinned while a new thread sees an additive registry change', async () => {
  const stateRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-tool-library-pinned-reuse-'),
  );
  try {
    const registry = createBuiltinToolRegistryStore();
    const runtime = createToolLibraryProjectionPort({
      registry,
      runtimeRootForState(root) {
        return join(root, '.geulbat', 'tool-library', 'projections');
      },
      sdkVersion: BASE_PROJECTION_ARGS.sdkVersion,
      sourceRegistryVersion: BASE_PROJECTION_ARGS.sourceRegistryVersion,
      runtimeCompatibilityRange: BASE_PROJECTION_ARGS.runtimeCompatibilityRange,
      modelFacingCatalogRef: BASE_PROJECTION_ARGS.modelFacingCatalogRef,
      importSpecifier: BASE_PROJECTION_ARGS.importSpecifier,
      projectionPolicy: { policyId: 'test-sdk-reachable-policy' },
    });

    const first = await runtime.resolveProjection({
      stateRoot,
      threadId: 'thread-pinned-reuse-test',
    });
    assert.equal(first.ok, true);
    if (!first.ok) {
      assert.fail('expected initial projection port to resolve');
    }
    const threadProjectionRootPath = dirname(first.projection.rootPath);
    const invalidProjectionDirectory = `sha256-${'0'.repeat(64)}`;
    const invalidProjectionRootPath = join(
      threadProjectionRootPath,
      invalidProjectionDirectory,
    );
    await mkdir(invalidProjectionRootPath, { recursive: true });
    await writeFile(
      join(invalidProjectionRootPath, 'manifest.js'),
      'export const projectionManifest = { invalid: true };\n',
      'utf8',
    );

    const second = await runtime.resolveProjection({
      stateRoot,
      threadId: 'thread-pinned-reuse-test',
    });
    assert.equal(second.ok, true);
    if (!second.ok) {
      assert.fail('expected pinned projection port to resolve');
    }
    assert.deepEqual(second.pin, first.pin);
    assert.deepEqual(second.mount, first.mount);
    assert.deepEqual(second.writtenFiles, []);
    assert.deepEqual(second.prunedProjectionDirectories, [
      invalidProjectionDirectory,
    ]);
    assert.deepEqual(second.projectionPruneFailedDirectories, []);
    assert.equal(await pathExists(invalidProjectionRootPath), false);
    assert.equal(await pathExists(first.projection.rootPath), true);

    registry.registerTool(
      createProjectionTestTool({ includeExtraParameter: false }),
    );

    const sameThreadAfterRegistryChange = await runtime.resolveProjection({
      stateRoot,
      threadId: 'thread-pinned-reuse-test',
    });
    assert.equal(sameThreadAfterRegistryChange.ok, true);
    if (!sameThreadAfterRegistryChange.ok) {
      assert.fail('expected the live thread projection to stay pinned');
    }
    assert.deepEqual(sameThreadAfterRegistryChange.pin, first.pin);
    assert.deepEqual(
      sameThreadAfterRegistryChange.projection.allowedRegistryNames,
      first.projection.allowedRegistryNames,
    );
    assert.deepEqual(sameThreadAfterRegistryChange.writtenFiles, []);

    const newThreadAfterRegistryChange = await runtime.resolveProjection({
      stateRoot,
      threadId: 'thread-after-registry-change-test',
    });
    assert.equal(newThreadAfterRegistryChange.ok, true);
    if (!newThreadAfterRegistryChange.ok) {
      assert.fail('expected a new thread to see the changed registry');
    }
    assert.notDeepEqual(newThreadAfterRegistryChange.pin, first.pin);
    assert.equal(
      newThreadAfterRegistryChange.pin.allowedRegistryNames.includes(
        'projection_test',
      ),
      true,
    );
    assert.equal(
      newThreadAfterRegistryChange.projection.tools.some(
        (tool) => tool.wrapperModule === 'tools/projection-test.js',
      ),
      true,
    );

    const storedMount = await readVerifiedToolLibraryProjectionMount({
      threadProjectionRootPath,
      expectedPin: first.pin,
      importSpecifier: BASE_PROJECTION_ARGS.importSpecifier,
    });
    assert.equal(storedMount.ok, true);
    if (!storedMount.ok) {
      assert.fail('expected pinned stored projection to remain mountable');
    }
    assert.deepEqual(storedMount.pin, first.pin);

    const firstProjectionRehydrated = await runtime.rehydrateProjectionMount({
      stateRoot,
      threadId: 'thread-pinned-reuse-test',
      expectedIdentity: getToolLibraryProjectionIdentity(first.pin),
    });
    assert.equal(firstProjectionRehydrated.ok, true);
    if (!firstProjectionRehydrated.ok) {
      assert.fail('expected live pinned projection identity to rehydrate');
    }
    assert.equal(
      firstProjectionRehydrated.mount.projectionRootPath,
      first.projection.rootPath,
    );
    assert.equal(await pathExists(first.projection.rootPath), true);
  } finally {
    await rm(stateRoot, { recursive: true, force: true });
  }
});

void test('createToolLibraryProjectionPort refreshes a live pin when an existing tool schema changes', async () => {
  const stateRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-tool-library-schema-refresh-'),
  );
  try {
    let includeExtraParameter = false;
    const registry = {
      getAllRegisteredToolNames() {
        return ['projection_test'];
      },
      getTool(name: string) {
        return name === 'projection_test'
          ? createProjectionTestTool({ includeExtraParameter })
          : undefined;
      },
    };
    const runtime = createToolLibraryProjectionPort({
      registry,
      runtimeRootForState(root) {
        return join(root, '.geulbat', 'tool-library', 'projections');
      },
      sdkVersion: BASE_PROJECTION_ARGS.sdkVersion,
      sourceRegistryVersion: BASE_PROJECTION_ARGS.sourceRegistryVersion,
      runtimeCompatibilityRange: BASE_PROJECTION_ARGS.runtimeCompatibilityRange,
      modelFacingCatalogRef: BASE_PROJECTION_ARGS.modelFacingCatalogRef,
      importSpecifier: BASE_PROJECTION_ARGS.importSpecifier,
    });

    const first = await runtime.resolveProjection({
      stateRoot,
      threadId: 'thread-schema-refresh-test',
    });
    assert.equal(first.ok, true);
    if (!first.ok) {
      assert.fail('expected initial projection port to resolve');
    }

    includeExtraParameter = true;
    const refreshed = await runtime.resolveProjection({
      stateRoot,
      threadId: 'thread-schema-refresh-test',
    });
    assert.equal(
      refreshed.ok,
      true,
      refreshed.ok ? undefined : refreshed.message,
    );
    if (!refreshed.ok) {
      assert.fail('expected changed generated source to refresh the live pin');
    }
    assert.notEqual(
      refreshed.pin.sdkProjectionHash,
      first.pin.sdkProjectionHash,
    );
    assert.equal(refreshed.writtenFiles.length > 0, true);
    assert.equal(await pathExists(first.projection.rootPath), true);

    const stable = await runtime.resolveProjection({
      stateRoot,
      threadId: 'thread-schema-refresh-test',
    });
    assert.equal(stable.ok, true);
    if (!stable.ok) {
      assert.fail('expected refreshed projection pin to remain stable');
    }
    assert.deepEqual(stable.pin, refreshed.pin);
    assert.deepEqual(stable.writtenFiles, []);
  } finally {
    await rm(stateRoot, { recursive: true, force: true });
  }
});

void test('generated tool library SDK modules can be imported and used at runtime', async () => {
  const stateRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-tool-library-runtime-import-'),
  );
  try {
    const runtime = createToolLibraryProjectionPort({
      registry: createBuiltinToolRegistryStore(),
      runtimeRootForState(root) {
        return join(root, '.geulbat', 'tool-library', 'projections');
      },
      sdkVersion: BASE_PROJECTION_ARGS.sdkVersion,
      sourceRegistryVersion: BASE_PROJECTION_ARGS.sourceRegistryVersion,
      runtimeCompatibilityRange: BASE_PROJECTION_ARGS.runtimeCompatibilityRange,
      modelFacingCatalogRef: BASE_PROJECTION_ARGS.modelFacingCatalogRef,
      importSpecifier: BASE_PROJECTION_ARGS.importSpecifier,
    });
    const result = await runtime.resolveProjection({
      stateRoot,
      threadId: 'thread-runtime-import-test',
      allowedRegistryNames: ['read_file'],
    });
    assert.equal(result.ok, true);
    if (!result.ok) {
      assert.fail('expected projection port to resolve');
    }

    const imported = asRecord(
      await import(pathToFileURL(result.mount.indexModulePath).href),
    );
    assert.notEqual(imported, null);
    if (imported === null) {
      assert.fail('expected generated SDK module object');
    }

    const searchTools = imported['searchTools'];
    assert.equal(typeof searchTools, 'function');
    const searchResults = (
      searchTools as (
        query: string,
      ) => readonly Readonly<Record<string, unknown>>[]
    )('read file');
    assert.equal(searchResults[0]?.['publicName'], 'read_file');

    const readFile = imported['readFile'];
    assert.equal(typeof readFile, 'function');
    const calls: Array<{ name: string; args: unknown }> = [];
    const readFileTool = result.projection.tools.find(
      (tool) => tool.publicName === 'read_file',
    );
    assert.ok(readFileTool);
    const mountedWrapper = resolveToolLibraryProjectionMountedModule({
      mount: result.mount,
      specifier: readFileTool.wrapperImportSpecifier,
    });
    assert.equal(mountedWrapper.ok, true);
    if (!mountedWrapper.ok) {
      assert.fail('expected read_file wrapper module to resolve');
    }
    const wrapperNamespace = asRecord(
      await import(pathToFileURL(mountedWrapper.module.filePath).href),
    );
    assert.notEqual(wrapperNamespace, null);
    const bindRuntime = wrapperNamespace?.['bindGeulbatRuntime'];
    assert.equal(typeof bindRuntime, 'function');
    (
      bindRuntime as (geulbat: {
        callTool(name: string, args: unknown): Promise<unknown>;
      }) => void
    )({
      async callTool(name, args) {
        calls.push({ name, args });
        return {
          offloaded: true,
          outputRef: 'tool-output-ref-1',
          summary: 'read_file output',
        };
      },
    });
    const wrapperResult = await (
      readFile as (args: unknown) => Promise<Readonly<Record<string, unknown>>>
    )({ path: 'README.md' });

    assert.deepEqual(calls, [
      { name: 'read_file', args: { path: 'README.md' } },
    ]);
    assert.deepEqual(wrapperResult, {
      kind: 'offloaded',
      outputRef: 'tool-output-ref-1',
      summary: 'read_file output',
      raw: {
        offloaded: true,
        outputRef: 'tool-output-ref-1',
        summary: 'read_file output',
      },
    });
  } finally {
    await rm(stateRoot, { recursive: true, force: true });
  }
});

void test('model-facing generated SDK specifiers resolve through the mount before import', async () => {
  const stateRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-tool-library-import-specifier-'),
  );
  try {
    const runtime = createToolLibraryProjectionPort({
      registry: createBuiltinToolRegistryStore(),
      runtimeRootForState(root) {
        return join(root, '.geulbat', 'tool-library', 'projections');
      },
      sdkVersion: BASE_PROJECTION_ARGS.sdkVersion,
      sourceRegistryVersion: BASE_PROJECTION_ARGS.sourceRegistryVersion,
      runtimeCompatibilityRange: BASE_PROJECTION_ARGS.runtimeCompatibilityRange,
      modelFacingCatalogRef: BASE_PROJECTION_ARGS.modelFacingCatalogRef,
      importSpecifier: BASE_PROJECTION_ARGS.importSpecifier,
    });
    const result = await runtime.resolveProjection({
      stateRoot,
      threadId: 'thread-import-specifier-test',
      allowedRegistryNames: ['fetch_url', 'read_file'],
    });
    assert.equal(result.ok, true);
    if (!result.ok) {
      assert.fail('expected projection port to resolve');
    }

    const indexModule = resolveToolLibraryProjectionMountedModule({
      mount: result.mount,
      specifier: '@geulbat/generated-tools',
    });
    assert.equal(indexModule.ok, true);
    if (!indexModule.ok) {
      assert.fail('expected generated SDK root specifier to resolve');
    }
    assert.equal(indexModule.module.filePath, result.mount.indexModulePath);
    const importedIndex = asRecord(
      await import(pathToFileURL(indexModule.module.filePath).href),
    );
    assert.notEqual(importedIndex, null);
    if (importedIndex === null) {
      assert.fail('expected generated SDK index module object');
    }
    assert.equal(typeof importedIndex['readFile'], 'function');

    const searchModule = resolveToolLibraryProjectionMountedModule({
      mount: result.mount,
      specifier: '@geulbat/generated-tools/search',
    });
    assert.equal(searchModule.ok, true);
    if (!searchModule.ok) {
      assert.fail('expected generated SDK search specifier to resolve');
    }
    const importedSearch = asRecord(
      await import(pathToFileURL(searchModule.module.filePath).href),
    );
    assert.notEqual(importedSearch, null);
    if (importedSearch === null) {
      assert.fail('expected generated SDK search module object');
    }
    const searchTools = importedSearch['searchTools'];
    assert.equal(typeof searchTools, 'function');
    const searchResults = (
      searchTools as (
        query: string,
      ) => readonly Readonly<Record<string, unknown>>[]
    )('open url');
    assert.equal(searchResults[0]?.['publicName'], 'fetch_url');

    const catalogModule = resolveToolLibraryProjectionMountedModule({
      mount: result.mount,
      specifier: '@geulbat/generated-tools/catalog',
    });
    assert.equal(catalogModule.ok, true);
    if (!catalogModule.ok) {
      assert.fail('expected generated SDK catalog specifier to resolve');
    }
    const importedCatalog = asRecord(
      await import(pathToFileURL(catalogModule.module.filePath).href),
    );
    assert.notEqual(importedCatalog, null);
    if (importedCatalog === null) {
      assert.fail('expected generated SDK catalog module object');
    }
    assert.equal(
      containsStringValue(importedCatalog['catalog'], stateRoot),
      false,
    );
  } finally {
    await rm(stateRoot, { recursive: true, force: true });
  }
});

void test('model-facing discovery result can seed the generated SDK projection', async () => {
  const stateRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-tool-library-discovery-workflow-'),
  );
  try {
    const registry = createBuiltinToolRegistryStore();
    const discoveredTool = searchToolCatalog(
      'open url',
      buildToolSearchCatalog(readRegisteredBuiltinTools(registry)),
    )[0];
    assert.equal(discoveredTool?.publicName, 'fetch_url');
    assert.equal(
      discoveredTool?.signatureRef,
      buildToolSignatureRef('fetch_url'),
    );

    const runtime = createToolLibraryProjectionPort({
      registry,
      runtimeRootForState(root) {
        return join(root, '.geulbat', 'tool-library', 'projections');
      },
      sdkVersion: BASE_PROJECTION_ARGS.sdkVersion,
      sourceRegistryVersion: BASE_PROJECTION_ARGS.sourceRegistryVersion,
      runtimeCompatibilityRange: BASE_PROJECTION_ARGS.runtimeCompatibilityRange,
      modelFacingCatalogRef: BASE_PROJECTION_ARGS.modelFacingCatalogRef,
      importSpecifier: BASE_PROJECTION_ARGS.importSpecifier,
    });
    const result = await runtime.resolveProjection({
      stateRoot,
      threadId: 'thread-discovery-workflow-test',
      allowedRegistryNames: [discoveredTool.publicName],
    });
    assert.equal(result.ok, true);
    if (!result.ok) {
      assert.fail('expected projection port to resolve');
    }

    const indexModule = resolveToolLibraryProjectionMountedModule({
      mount: result.mount,
      specifier: '@geulbat/generated-tools',
    });
    assert.equal(indexModule.ok, true);
    if (!indexModule.ok) {
      assert.fail('expected generated SDK root specifier to resolve');
    }

    const importedIndex = asRecord(
      await import(pathToFileURL(indexModule.module.filePath).href),
    );
    assert.notEqual(importedIndex, null);
    if (importedIndex === null) {
      assert.fail('expected generated SDK index module object');
    }

    const searchTools = importedIndex['searchTools'];
    assert.equal(typeof searchTools, 'function');
    const searchResults = (
      searchTools as (
        query: string,
      ) => readonly Readonly<Record<string, unknown>>[]
    )('open url');
    assert.equal(searchResults[0]?.['publicName'], discoveredTool.publicName);

    const fetchUrl = importedIndex['fetchUrl'];
    assert.equal(typeof fetchUrl, 'function');
    const calls: Array<{ name: string; args: unknown }> = [];
    const fetchUrlTool = result.projection.tools.find(
      (tool) => tool.publicName === 'fetch_url',
    );
    assert.ok(fetchUrlTool);
    const mountedWrapper = resolveToolLibraryProjectionMountedModule({
      mount: result.mount,
      specifier: fetchUrlTool.wrapperImportSpecifier,
    });
    assert.equal(mountedWrapper.ok, true);
    if (!mountedWrapper.ok) {
      assert.fail('expected fetch_url wrapper module to resolve');
    }
    const wrapperNamespace = asRecord(
      await import(pathToFileURL(mountedWrapper.module.filePath).href),
    );
    const bindRuntime = wrapperNamespace?.['bindGeulbatRuntime'];
    assert.equal(typeof bindRuntime, 'function');
    (
      bindRuntime as (geulbat: {
        callTool(name: string, args: unknown): Promise<unknown>;
      }) => void
    )({
      async callTool(name, args) {
        calls.push({ name, args });
        return { ok: true, status: 200 };
      },
    });
    const wrapperResult = await (
      fetchUrl as (args: unknown) => Promise<Readonly<Record<string, unknown>>>
    )({ url: 'https://example.com' });

    assert.deepEqual(calls, [
      { name: 'fetch_url', args: { url: 'https://example.com' } },
    ]);
    assert.deepEqual(wrapperResult, {
      kind: 'inline',
      value: { ok: true, status: 200 },
    });
  } finally {
    await rm(stateRoot, { recursive: true, force: true });
  }
});

void test('generated SDK root import exposes multi-family wrappers and signatures', async () => {
  const stateRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-tool-library-multifamily-runtime-'),
  );
  try {
    const runtime = createToolLibraryProjectionPort({
      registry: createBuiltinToolRegistryStore(),
      runtimeRootForState(root) {
        return join(root, '.geulbat', 'tool-library', 'projections');
      },
      sdkVersion: BASE_PROJECTION_ARGS.sdkVersion,
      sourceRegistryVersion: BASE_PROJECTION_ARGS.sourceRegistryVersion,
      runtimeCompatibilityRange: BASE_PROJECTION_ARGS.runtimeCompatibilityRange,
      modelFacingCatalogRef: BASE_PROJECTION_ARGS.modelFacingCatalogRef,
      importSpecifier: BASE_PROJECTION_ARGS.importSpecifier,
    });
    const result = await runtime.resolveProjection({
      stateRoot,
      threadId: 'thread-multifamily-runtime-test',
      allowedRegistryNames: [
        'apply_patch',
        'exec_command',
        'fetch_url',
        'read_file',
      ],
    });
    assert.equal(result.ok, true);
    if (!result.ok) {
      assert.fail('expected projection port to resolve');
    }

    const indexModule = resolveToolLibraryProjectionMountedModule({
      mount: result.mount,
      specifier: '@geulbat/generated-tools',
    });
    assert.equal(indexModule.ok, true);
    if (!indexModule.ok) {
      assert.fail('expected generated SDK root specifier to resolve');
    }
    const importedIndex = asRecord(
      await import(pathToFileURL(indexModule.module.filePath).href),
    );
    assert.notEqual(importedIndex, null);
    if (importedIndex === null) {
      assert.fail('expected generated SDK index module object');
    }

    const catalog = importedIndex['catalog'];
    assert.equal(containsStringValue(catalog, stateRoot), false);
    for (const expected of [
      {
        publicName: 'apply_patch',
        wrapperExport: 'applyPatch',
        signatureExport: 'applyPatchSignature',
        approvalClass: 'approval_required',
        sideEffectLevel: 'write',
      },
      {
        publicName: 'exec_command',
        wrapperExport: 'execCommand',
        signatureExport: 'execCommandSignature',
        approvalClass: 'approval_required',
        sideEffectLevel: 'destructive',
      },
      {
        publicName: 'fetch_url',
        wrapperExport: 'fetchUrl',
        signatureExport: 'fetchUrlSignature',
        approvalClass: 'approval_free',
        sideEffectLevel: 'read',
      },
      {
        publicName: 'read_file',
        wrapperExport: 'readFile',
        signatureExport: 'readFileSignature',
        approvalClass: 'approval_free',
        sideEffectLevel: 'read',
      },
    ] as const) {
      assert.equal(typeof importedIndex[expected.wrapperExport], 'function');
      const signature = asRecord(importedIndex[expected.signatureExport]);
      assert.notEqual(signature, null);
      if (signature === null) {
        assert.fail(`expected ${expected.signatureExport} object`);
      }
      assert.equal(signature['publicName'], expected.publicName);
      assert.equal(signature['approvalClass'], expected.approvalClass);
      assert.equal(signature['sideEffectLevel'], expected.sideEffectLevel);
    }

    const searchTools = importedIndex['searchTools'];
    assert.equal(typeof searchTools, 'function');
    const shellSearchResults = (
      searchTools as (
        query: string,
      ) => readonly Readonly<Record<string, unknown>>[]
    )('shell command');
    assert.equal(shellSearchResults[0]?.['publicName'], 'exec_command');

    const calls: Array<{ name: string; args: unknown }> = [];
    for (const [exportName, callbackName, args] of [
      ['applyPatch', 'apply_patch', { patch: '*** Begin Patch\n' }],
      ['execCommand', 'exec_command', { cmd: 'pwd' }],
      ['fetchUrl', 'fetch_url', { url: 'https://example.com' }],
      ['readFile', 'read_file', { path: 'README.md' }],
    ] as const) {
      const wrapper: unknown = importedIndex[exportName];
      assert.equal(typeof wrapper, 'function');
      const projectedTool = result.projection.tools.find(
        (tool) => tool.callbackName === callbackName,
      );
      assert.ok(projectedTool);
      const mountedWrapper = resolveToolLibraryProjectionMountedModule({
        mount: result.mount,
        specifier: projectedTool.wrapperImportSpecifier,
      });
      assert.equal(mountedWrapper.ok, true);
      if (!mountedWrapper.ok) {
        assert.fail(`expected ${callbackName} wrapper module to resolve`);
      }
      const wrapperNamespace = asRecord(
        await import(pathToFileURL(mountedWrapper.module.filePath).href),
      );
      const bindRuntime = wrapperNamespace?.['bindGeulbatRuntime'];
      assert.equal(typeof bindRuntime, 'function');
      (
        bindRuntime as (geulbat: {
          callTool(name: string, args: unknown): Promise<unknown>;
        }) => void
      )({
        async callTool(name, receivedArgs) {
          calls.push({ name, args: receivedArgs });
          return { ok: true, tool: name };
        },
      });
      const wrapperResult = await (
        wrapper as (args: unknown) => Promise<Readonly<Record<string, unknown>>>
      )(args);
      assert.deepEqual(wrapperResult, {
        kind: 'inline',
        value: { ok: true, tool: callbackName },
      });
    }

    assert.deepEqual(calls, [
      { name: 'apply_patch', args: { patch: '*** Begin Patch\n' } },
      { name: 'exec_command', args: { cmd: 'pwd' } },
      { name: 'fetch_url', args: { url: 'https://example.com' } },
      { name: 'read_file', args: { path: 'README.md' } },
    ]);
  } finally {
    await rm(stateRoot, { recursive: true, force: true });
  }
});

void test('generated catalog search results resolve to narrow signature descriptors', async () => {
  const stateRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-tool-library-catalog-signature-'),
  );
  try {
    const registry = createBuiltinToolRegistryStore();
    const allowedRegistryNames = [
      'apply_patch',
      'exec_command',
      'fetch_url',
      'read_file',
    ] as const;
    const runtime = createToolLibraryProjectionPort({
      registry,
      runtimeRootForState(root) {
        return join(root, '.geulbat', 'tool-library', 'projections');
      },
      sdkVersion: BASE_PROJECTION_ARGS.sdkVersion,
      sourceRegistryVersion: BASE_PROJECTION_ARGS.sourceRegistryVersion,
      runtimeCompatibilityRange: BASE_PROJECTION_ARGS.runtimeCompatibilityRange,
      modelFacingCatalogRef: BASE_PROJECTION_ARGS.modelFacingCatalogRef,
      importSpecifier: BASE_PROJECTION_ARGS.importSpecifier,
    });
    const result = await runtime.resolveProjection({
      stateRoot,
      threadId: 'thread-catalog-signature-test',
      allowedRegistryNames,
    });
    assert.equal(result.ok, true);
    if (!result.ok) {
      assert.fail('expected projection port to resolve');
    }

    const searchModule = resolveToolLibraryProjectionMountedModule({
      mount: result.mount,
      specifier: '@geulbat/generated-tools/search',
    });
    assert.equal(searchModule.ok, true);
    if (!searchModule.ok) {
      assert.fail('expected generated SDK search specifier to resolve');
    }
    const importedSearch = asRecord(
      await import(pathToFileURL(searchModule.module.filePath).href),
    );
    assert.notEqual(importedSearch, null);
    if (importedSearch === null) {
      assert.fail('expected generated SDK search module object');
    }
    const searchTools = importedSearch['searchTools'];
    assert.equal(typeof searchTools, 'function');
    const shellSearchResults = (
      searchTools as (
        query: string,
      ) => readonly Readonly<Record<string, unknown>>[]
    )('shell command');

    const catalogModule = resolveToolLibraryProjectionMountedModule({
      mount: result.mount,
      specifier: '@geulbat/generated-tools/catalog',
    });
    assert.equal(catalogModule.ok, true);
    if (!catalogModule.ok) {
      assert.fail('expected generated SDK catalog specifier to resolve');
    }
    const importedCatalog = asRecord(
      await import(pathToFileURL(catalogModule.module.filePath).href),
    );
    assert.notEqual(importedCatalog, null);
    if (importedCatalog === null) {
      assert.fail('expected generated SDK catalog module object');
    }
    assert.deepEqual(
      shellSearchResults,
      searchToolCatalog(
        'shell command',
        importedCatalog['catalog'] as readonly ToolSearchCatalogCard[],
      ),
    );
    const allowedRegistryNameSet = new Set<string>(allowedRegistryNames);
    const liveCatalog = buildToolSearchCatalog(
      readRegisteredBuiltinTools(registry).filter((tool) =>
        allowedRegistryNameSet.has(tool.name),
      ),
    );
    assert.deepEqual(
      summarizeToolSearchRanking(shellSearchResults),
      summarizeToolSearchRanking(
        searchToolCatalog('shell command', liveCatalog),
      ),
    );

    const signatureRef = shellSearchResults[0]?.['signatureRef'];
    assert.equal(typeof signatureRef, 'string');
    if (typeof signatureRef !== 'string') {
      assert.fail('expected catalog result to carry a signature ref');
    }
    const signature = result.projection.tools.find(
      (tool) => tool.signatureRef === signatureRef,
    );
    if (signature === undefined) {
      assert.fail('expected signature ref to identify a projected tool');
    }

    assert.equal(signature.publicName, 'exec_command');
    assert.equal(signature.signatureRef, signatureRef);
    assert.equal(signature.wrapperExportName, 'execCommand');
    assert.equal(signature.signatureExportName, 'execCommandSignature');
    assert.equal(
      signature.signatureImportSpecifier,
      '@geulbat/generated-tools/signatures/exec-command',
    );
    assert.equal(
      signature.wrapperImportSpecifier,
      '@geulbat/generated-tools/tools/exec-command',
    );
    assert.equal(signature.approvalClass, 'approval_required');
    assert.equal(signature.sideEffectLevel, 'destructive');
    assert.equal(signature.mayMutateComputerFiles, true);
    assert.equal(containsStringValue(signature, stateRoot), false);

    const mountedSignature = resolveToolLibraryProjectionMountedModule({
      mount: result.mount,
      specifier: signature.signatureImportSpecifier,
    });
    assert.equal(mountedSignature.ok, true);
    if (!mountedSignature.ok) {
      assert.fail('expected catalog signature import specifier to mount');
    }
    assert.equal(mountedSignature.module.role, 'signature');
    const importedSignature = asRecord(
      await import(pathToFileURL(mountedSignature.module.filePath).href),
    );
    assert.notEqual(importedSignature, null);
    if (importedSignature === null) {
      assert.fail('expected generated signature module object');
    }
    assert.equal(
      asRecord(importedSignature['signature'])?.['publicName'],
      'exec_command',
    );

    const mountedWrapper = resolveToolLibraryProjectionMountedModule({
      mount: result.mount,
      specifier: signature.wrapperImportSpecifier,
    });
    assert.equal(mountedWrapper.ok, true);
    if (!mountedWrapper.ok) {
      assert.fail('expected catalog wrapper import specifier to mount');
    }
    assert.equal(mountedWrapper.module.role, 'wrapper');
    const importedWrapper = asRecord(
      await import(pathToFileURL(mountedWrapper.module.filePath).href),
    );
    assert.notEqual(importedWrapper, null);
    if (importedWrapper === null) {
      assert.fail('expected generated wrapper module object');
    }
    assert.equal(typeof importedWrapper['execCommand'], 'function');
  } finally {
    await rm(stateRoot, { recursive: true, force: true });
  }
});

void test('readVerifiedToolLibraryProjectionMount rejects a stale pinned manifest', async () => {
  const threadProjectionRootPath = await mkdtemp(
    join(tmpdir(), 'geulbat-tool-library-pinned-manifest-'),
  );
  try {
    const preliminaryProjection = buildToolLibraryProjection({
      ...BASE_PROJECTION_ARGS,
      registry: createBuiltinToolRegistryStore(),
      allowedRegistryNames: ['read_file'],
      rootPath: join(threadProjectionRootPath, 'preliminary'),
      catalogPath: join(threadProjectionRootPath, 'preliminary', 'catalog.js'),
    });
    const projectionRootPath = join(
      threadProjectionRootPath,
      getToolLibraryProjectionPin(preliminaryProjection).projectionDirectory,
    );
    const projection = buildToolLibraryProjection({
      ...BASE_PROJECTION_ARGS,
      registry: createBuiltinToolRegistryStore(),
      allowedRegistryNames: ['read_file'],
      rootPath: projectionRootPath,
      catalogPath: join(projectionRootPath, 'catalog.js'),
    });
    await writeToolLibraryProjectionFiles(projection);
    const expectedPin = getToolLibraryProjectionPin(projection);
    await writeFile(
      join(threadProjectionRootPath, 'projection-pin.json'),
      `${JSON.stringify(expectedPin)}\n`,
      'utf8',
    );
    await writeFile(
      join(projectionRootPath, 'manifest.js'),
      `export const projectionManifest = ${JSON.stringify({
        ...getToolLibraryProjectionManifest(projection),
        policyId: 'stale-policy',
      })};\n`,
      'utf8',
    );

    assert.deepEqual(
      await readVerifiedToolLibraryProjectionMount({
        threadProjectionRootPath,
        expectedPin,
        importSpecifier: BASE_PROJECTION_ARGS.importSpecifier,
      }),
      {
        ok: false,
        reason: 'manifest_mismatch',
        message:
          'Tool library projection manifest does not match expected projection',
      },
    );
  } finally {
    await rm(threadProjectionRootPath, { recursive: true, force: true });
  }
});

void test('readVerifiedToolLibraryProjectionMount verifies an expected pin after the thread pointer moves', async () => {
  const threadProjectionRootPath = await mkdtemp(
    join(tmpdir(), 'geulbat-tool-library-pinned-pointer-moved-'),
  );
  try {
    const firstPreliminaryProjection = buildToolLibraryProjection({
      ...BASE_PROJECTION_ARGS,
      registry: createBuiltinToolRegistryStore(),
      allowedRegistryNames: ['read_file'],
      rootPath: join(threadProjectionRootPath, 'first-preliminary'),
      catalogPath: join(
        threadProjectionRootPath,
        'first-preliminary',
        'catalog.js',
      ),
    });
    const firstProjectionRootPath = join(
      threadProjectionRootPath,
      getToolLibraryProjectionPin(firstPreliminaryProjection)
        .projectionDirectory,
    );
    const firstProjection = buildToolLibraryProjection({
      ...BASE_PROJECTION_ARGS,
      registry: createBuiltinToolRegistryStore(),
      allowedRegistryNames: ['read_file'],
      rootPath: firstProjectionRootPath,
      catalogPath: join(firstProjectionRootPath, 'catalog.js'),
    });
    await writeToolLibraryProjectionFiles(firstProjection);
    const firstPin = getToolLibraryProjectionPin(firstProjection);

    const secondPreliminaryProjection = buildToolLibraryProjection({
      ...BASE_PROJECTION_ARGS,
      registry: createBuiltinToolRegistryStore(),
      allowedRegistryNames: ['fetch_url'],
      rootPath: join(threadProjectionRootPath, 'second-preliminary'),
      catalogPath: join(
        threadProjectionRootPath,
        'second-preliminary',
        'catalog.js',
      ),
    });
    const secondProjectionRootPath = join(
      threadProjectionRootPath,
      getToolLibraryProjectionPin(secondPreliminaryProjection)
        .projectionDirectory,
    );
    const secondProjection = buildToolLibraryProjection({
      ...BASE_PROJECTION_ARGS,
      registry: createBuiltinToolRegistryStore(),
      allowedRegistryNames: ['fetch_url'],
      rootPath: secondProjectionRootPath,
      catalogPath: join(secondProjectionRootPath, 'catalog.js'),
    });
    await writeToolLibraryProjectionFiles(secondProjection);
    const secondPin = getToolLibraryProjectionPin(secondProjection);
    await writeFile(
      join(threadProjectionRootPath, 'projection-pin.json'),
      `${JSON.stringify(secondPin)}\n`,
      'utf8',
    );

    const firstMountResult = await readVerifiedToolLibraryProjectionMount({
      threadProjectionRootPath,
      expectedPin: firstPin,
      importSpecifier: BASE_PROJECTION_ARGS.importSpecifier,
    });
    assert.equal(firstMountResult.ok, true);
    if (!firstMountResult.ok) {
      assert.fail('expected old expected pin to verify after pointer moved');
    }
    assert.equal(
      firstMountResult.mount.projectionRootPath,
      firstProjection.rootPath,
    );
    assert.deepEqual(firstMountResult.pin, firstPin);
  } finally {
    await rm(threadProjectionRootPath, { recursive: true, force: true });
  }
});

void test('readVerifiedToolLibraryProjectionMount rejects stored pin module drift without an expected pin', async () => {
  const threadProjectionRootPath = await mkdtemp(
    join(tmpdir(), 'geulbat-tool-library-pinned-module-drift-'),
  );
  try {
    const preliminaryProjection = buildToolLibraryProjection({
      ...BASE_PROJECTION_ARGS,
      registry: createBuiltinToolRegistryStore(),
      allowedRegistryNames: ['read_file'],
      rootPath: join(threadProjectionRootPath, 'preliminary'),
      catalogPath: join(threadProjectionRootPath, 'preliminary', 'catalog.js'),
    });
    const projectionRootPath = join(
      threadProjectionRootPath,
      getToolLibraryProjectionPin(preliminaryProjection).projectionDirectory,
    );
    const projection = buildToolLibraryProjection({
      ...BASE_PROJECTION_ARGS,
      registry: createBuiltinToolRegistryStore(),
      allowedRegistryNames: ['read_file'],
      rootPath: projectionRootPath,
      catalogPath: join(projectionRootPath, 'catalog.js'),
    });
    await writeToolLibraryProjectionFiles(projection);
    const pin = getToolLibraryProjectionPin(projection);
    await writeFile(
      join(threadProjectionRootPath, 'projection-pin.json'),
      `${JSON.stringify({
        ...pin,
        catalogModule: 'stale-catalog.js',
      })}\n`,
      'utf8',
    );

    assert.deepEqual(
      await readVerifiedToolLibraryProjectionMount({
        threadProjectionRootPath,
        importSpecifier: BASE_PROJECTION_ARGS.importSpecifier,
      }),
      {
        ok: false,
        reason: 'pin_mismatch',
        message: 'Tool library projection pin does not match pinned manifest',
      },
    );
  } finally {
    await rm(threadProjectionRootPath, { recursive: true, force: true });
  }
});

void test('readVerifiedToolLibraryProjectionMount rehydrates from observer projection identity', async () => {
  const stateRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-tool-library-replay-identity-'),
  );
  try {
    const runtime = createToolLibraryProjectionPort({
      registry: createBuiltinToolRegistryStore(),
      runtimeRootForState(root) {
        return join(root, '.geulbat', 'tool-library', 'projections');
      },
      sdkVersion: BASE_PROJECTION_ARGS.sdkVersion,
      sourceRegistryVersion: BASE_PROJECTION_ARGS.sourceRegistryVersion,
      runtimeCompatibilityRange: BASE_PROJECTION_ARGS.runtimeCompatibilityRange,
      modelFacingCatalogRef: BASE_PROJECTION_ARGS.modelFacingCatalogRef,
      importSpecifier: BASE_PROJECTION_ARGS.importSpecifier,
    });
    const result = await runtime.resolveProjection({
      stateRoot,
      threadId: 'thread-runtime-test',
      allowedRegistryNames: ['read_file'],
    });
    assert.equal(result.ok, true);
    if (!result.ok) {
      assert.fail('expected projection port to resolve');
    }

    const expectedIdentity = getToolLibraryProjectionIdentity(result.pin);
    const mountResult = await readVerifiedToolLibraryProjectionMount({
      threadProjectionRootPath: dirname(result.projection.rootPath),
      expectedIdentity,
      importSpecifier: BASE_PROJECTION_ARGS.importSpecifier,
    });

    assert.equal(mountResult.ok, true);
    if (!mountResult.ok) {
      assert.fail('expected projection mount verification to pass');
    }
    assert.deepEqual(getToolLibraryProjectionIdentity(mountResult.mount), {
      sdkVersion: expectedIdentity.sdkVersion,
      sdkProjectionHash: expectedIdentity.sdkProjectionHash,
      policyId: expectedIdentity.policyId,
    });
  } finally {
    await rm(stateRoot, { recursive: true, force: true });
  }
});

void test('readVerifiedToolLibraryProjectionMount rejects replay identity mismatch', async () => {
  const stateRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-tool-library-replay-identity-mismatch-'),
  );
  try {
    const runtime = createToolLibraryProjectionPort({
      registry: createBuiltinToolRegistryStore(),
      runtimeRootForState(root) {
        return join(root, '.geulbat', 'tool-library', 'projections');
      },
      sdkVersion: BASE_PROJECTION_ARGS.sdkVersion,
      sourceRegistryVersion: BASE_PROJECTION_ARGS.sourceRegistryVersion,
      runtimeCompatibilityRange: BASE_PROJECTION_ARGS.runtimeCompatibilityRange,
      modelFacingCatalogRef: BASE_PROJECTION_ARGS.modelFacingCatalogRef,
      importSpecifier: BASE_PROJECTION_ARGS.importSpecifier,
    });
    const result = await runtime.resolveProjection({
      stateRoot,
      threadId: 'thread-runtime-test',
      allowedRegistryNames: ['read_file'],
    });
    assert.equal(result.ok, true);
    if (!result.ok) {
      assert.fail('expected projection port to resolve');
    }

    assert.deepEqual(
      await readVerifiedToolLibraryProjectionMount({
        threadProjectionRootPath: dirname(result.projection.rootPath),
        expectedIdentity: {
          ...getToolLibraryProjectionIdentity(result.pin),
          policyId: 'stale-policy',
        },
        importSpecifier: BASE_PROJECTION_ARGS.importSpecifier,
      }),
      {
        ok: false,
        reason: 'projection_identity_mismatch',
        message:
          'Tool library projection identity does not match expected replay projection',
      },
    );
  } finally {
    await rm(stateRoot, { recursive: true, force: true });
  }
});

void test('createToolLibraryProjectionPort rehydrates pinned projection through daemon-owned port', async () => {
  const stateRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-tool-library-runtime-rehydrate-'),
  );
  try {
    const runtime = createToolLibraryProjectionPort({
      registry: createBuiltinToolRegistryStore(),
      runtimeRootForState(root) {
        return join(root, '.geulbat', 'tool-library', 'projections');
      },
      sdkVersion: BASE_PROJECTION_ARGS.sdkVersion,
      sourceRegistryVersion: BASE_PROJECTION_ARGS.sourceRegistryVersion,
      runtimeCompatibilityRange: BASE_PROJECTION_ARGS.runtimeCompatibilityRange,
      modelFacingCatalogRef: BASE_PROJECTION_ARGS.modelFacingCatalogRef,
      importSpecifier: BASE_PROJECTION_ARGS.importSpecifier,
    });
    const resolved = await runtime.resolveProjection({
      stateRoot,
      threadId: 'thread-runtime-test',
      allowedRegistryNames: ['read_file'],
    });
    assert.equal(resolved.ok, true);
    if (!resolved.ok) {
      assert.fail('expected projection port to resolve');
    }

    const rehydrated = await runtime.rehydrateProjectionMount({
      stateRoot,
      threadId: 'thread-runtime-test',
      expectedIdentity: getToolLibraryProjectionIdentity(resolved.pin),
    });
    assert.equal(rehydrated.ok, true);
    if (!rehydrated.ok) {
      assert.fail('expected projection port to rehydrate mount');
    }
    assert.equal(
      rehydrated.mount.indexModulePath,
      resolved.mount.indexModulePath,
    );
  } finally {
    await rm(stateRoot, { recursive: true, force: true });
  }
});

void test('createToolLibraryProjectionPort rejects stale rehydration identity', async () => {
  const stateRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-tool-library-runtime-rehydrate-mismatch-'),
  );
  try {
    const runtime = createToolLibraryProjectionPort({
      registry: createBuiltinToolRegistryStore(),
      runtimeRootForState(root) {
        return join(root, '.geulbat', 'tool-library', 'projections');
      },
      sdkVersion: BASE_PROJECTION_ARGS.sdkVersion,
      sourceRegistryVersion: BASE_PROJECTION_ARGS.sourceRegistryVersion,
      runtimeCompatibilityRange: BASE_PROJECTION_ARGS.runtimeCompatibilityRange,
      modelFacingCatalogRef: BASE_PROJECTION_ARGS.modelFacingCatalogRef,
      importSpecifier: BASE_PROJECTION_ARGS.importSpecifier,
    });
    const resolved = await runtime.resolveProjection({
      stateRoot,
      threadId: 'thread-runtime-test',
      allowedRegistryNames: ['read_file'],
    });
    assert.equal(resolved.ok, true);
    if (!resolved.ok) {
      assert.fail('expected projection port to resolve');
    }

    assert.deepEqual(
      await runtime.rehydrateProjectionMount({
        stateRoot,
        threadId: 'thread-runtime-test',
        expectedIdentity: {
          ...getToolLibraryProjectionIdentity(resolved.pin),
          sdkVersion: 'stale-sdk',
        },
      }),
      {
        ok: false,
        reason: 'projection_identity_mismatch',
        message:
          'Tool library projection identity does not match expected replay projection',
      },
    );
  } finally {
    await rm(stateRoot, { recursive: true, force: true });
  }
});

void test('readVerifiedToolLibraryProjectionMount rejects import specifier mismatch', async () => {
  const stateRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-tool-library-mount-mismatch-'),
  );
  try {
    const runtime = createToolLibraryProjectionPort({
      registry: createBuiltinToolRegistryStore(),
      runtimeRootForState(root) {
        return join(root, '.geulbat', 'tool-library', 'projections');
      },
      sdkVersion: BASE_PROJECTION_ARGS.sdkVersion,
      sourceRegistryVersion: BASE_PROJECTION_ARGS.sourceRegistryVersion,
      runtimeCompatibilityRange: BASE_PROJECTION_ARGS.runtimeCompatibilityRange,
      modelFacingCatalogRef: BASE_PROJECTION_ARGS.modelFacingCatalogRef,
      importSpecifier: BASE_PROJECTION_ARGS.importSpecifier,
    });
    const result = await runtime.resolveProjection({
      stateRoot,
      threadId: 'thread-runtime-test',
      allowedRegistryNames: ['read_file'],
    });
    assert.equal(result.ok, true);
    if (!result.ok) {
      assert.fail('expected projection port to resolve');
    }

    assert.deepEqual(
      await readVerifiedToolLibraryProjectionMount({
        threadProjectionRootPath: dirname(result.projection.rootPath),
        expectedPin: result.pin,
        importSpecifier: '@geulbat/other-tools',
      }),
      {
        ok: false,
        reason: 'import_specifier_mismatch',
        message:
          'Tool library projection import specifier does not match expected runtime mount',
      },
    );
  } finally {
    await rm(stateRoot, { recursive: true, force: true });
  }
});

void test('readVerifiedToolLibraryProjectionMount rejects missing mount files', async () => {
  const stateRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-tool-library-mount-missing-'),
  );
  try {
    const runtime = createToolLibraryProjectionPort({
      registry: createBuiltinToolRegistryStore(),
      runtimeRootForState(root) {
        return join(root, '.geulbat', 'tool-library', 'projections');
      },
      sdkVersion: BASE_PROJECTION_ARGS.sdkVersion,
      sourceRegistryVersion: BASE_PROJECTION_ARGS.sourceRegistryVersion,
      runtimeCompatibilityRange: BASE_PROJECTION_ARGS.runtimeCompatibilityRange,
      modelFacingCatalogRef: BASE_PROJECTION_ARGS.modelFacingCatalogRef,
      importSpecifier: BASE_PROJECTION_ARGS.importSpecifier,
    });
    const result = await runtime.resolveProjection({
      stateRoot,
      threadId: 'thread-runtime-test',
      allowedRegistryNames: ['read_file'],
    });
    assert.equal(result.ok, true);
    if (!result.ok) {
      assert.fail('expected projection port to resolve');
    }
    await rm(join(result.projection.rootPath, 'index.js'));

    const mountResult = await readVerifiedToolLibraryProjectionMount({
      threadProjectionRootPath: dirname(result.projection.rootPath),
      expectedPin: result.pin,
      importSpecifier: BASE_PROJECTION_ARGS.importSpecifier,
    });
    assert.equal(mountResult.ok, false);
    if (mountResult.ok) {
      assert.fail('expected projection mount verification to fail');
    }
    assert.equal(mountResult.reason, 'mount_file_missing');
    assert.equal(
      mountResult.message,
      'Tool library projection mount file could not be read',
    );
    assert.equal(mountResult.message.includes(stateRoot), false);
  } finally {
    await rm(stateRoot, { recursive: true, force: true });
  }
});

void test('resolveToolLibraryProjectionMountedModule resolves only owned generated modules', async () => {
  const stateRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-tool-library-mounted-module-'),
  );
  try {
    const runtime = createToolLibraryProjectionPort({
      registry: createBuiltinToolRegistryStore(),
      runtimeRootForState(root) {
        return join(root, '.geulbat', 'tool-library', 'projections');
      },
      sdkVersion: BASE_PROJECTION_ARGS.sdkVersion,
      sourceRegistryVersion: BASE_PROJECTION_ARGS.sourceRegistryVersion,
      runtimeCompatibilityRange: BASE_PROJECTION_ARGS.runtimeCompatibilityRange,
      modelFacingCatalogRef: BASE_PROJECTION_ARGS.modelFacingCatalogRef,
      importSpecifier: BASE_PROJECTION_ARGS.importSpecifier,
    });
    const result = await runtime.resolveProjection({
      stateRoot,
      threadId: 'thread-runtime-test',
      allowedRegistryNames: ['read_file'],
    });
    assert.equal(result.ok, true);
    if (!result.ok) {
      assert.fail('expected projection port to resolve');
    }
    const tool = result.projection.tools[0];
    assert.ok(tool);

    assert.deepEqual(
      resolveToolLibraryProjectionMountedModule({
        mount: result.mount,
        specifier: '@geulbat/generated-tools',
      }),
      {
        ok: true,
        module: {
          specifier: '@geulbat/generated-tools',
          filePath: result.mount.indexModulePath,
          role: 'index',
        },
      },
    );
    assert.deepEqual(
      resolveToolLibraryProjectionMountedModule({
        mount: result.mount,
        specifier: '@geulbat/generated-tools/catalog',
      }),
      {
        ok: true,
        module: {
          specifier: '@geulbat/generated-tools/catalog',
          filePath: result.mount.catalogModulePath,
          role: 'catalog',
        },
      },
    );
    assert.deepEqual(
      resolveToolLibraryProjectionMountedModule({
        mount: result.mount,
        specifier: '@geulbat/generated-tools/search',
      }),
      {
        ok: true,
        module: {
          specifier: '@geulbat/generated-tools/search',
          filePath: result.mount.searchModulePath,
          role: 'search',
        },
      },
    );
    assert.deepEqual(
      resolveToolLibraryProjectionMountedModule({
        mount: result.mount,
        specifier: '@geulbat/generated-tools/search-runtime',
      }),
      {
        ok: true,
        module: {
          specifier: '@geulbat/generated-tools/search-runtime',
          filePath: result.mount.searchRuntimeModulePath,
          role: 'search_runtime',
        },
      },
    );
    assert.deepEqual(
      resolveToolLibraryProjectionMountedModule({
        mount: result.mount,
        specifier: '@geulbat/generated-tools/manifest',
      }),
      {
        ok: true,
        module: {
          specifier: '@geulbat/generated-tools/manifest',
          filePath: result.mount.manifestModulePath,
          role: 'manifest',
        },
      },
    );
    assert.deepEqual(
      resolveToolLibraryProjectionMountedModule({
        mount: result.mount,
        specifier: '@geulbat/generated-tools/index.d.ts',
      }),
      {
        ok: true,
        module: {
          specifier: '@geulbat/generated-tools/index.d.ts',
          filePath: result.mount.indexDeclarationPath,
          role: 'index_declaration',
        },
      },
    );
    assert.deepEqual(
      resolveToolLibraryProjectionMountedModule({
        mount: result.mount,
        specifier: '@geulbat/generated-tools/signatures/read-file',
      }),
      {
        ok: true,
        module: {
          specifier: '@geulbat/generated-tools/signatures/read-file',
          filePath: join(result.mount.projectionRootPath, tool.signatureModule),
          role: 'signature',
        },
      },
    );
    assert.deepEqual(
      resolveToolLibraryProjectionMountedModule({
        mount: result.mount,
        specifier: '@geulbat/generated-tools/signatures/read-file.d.ts',
      }),
      {
        ok: true,
        module: {
          specifier: '@geulbat/generated-tools/signatures/read-file.d.ts',
          filePath: join(
            result.mount.projectionRootPath,
            tool.signatureDeclarationModule,
          ),
          role: 'signature_declaration',
        },
      },
    );
    assert.deepEqual(
      resolveToolLibraryProjectionMountedModule({
        mount: result.mount,
        specifier: '@geulbat/generated-tools/files/readFile',
      }),
      {
        ok: true,
        module: {
          specifier: '@geulbat/generated-tools/files/readFile',
          filePath: join(result.mount.projectionRootPath, tool.wrapperModule),
          role: 'wrapper',
        },
      },
    );
    assert.deepEqual(
      resolveToolLibraryProjectionMountedModule({
        mount: result.mount,
        specifier: '@geulbat/generated-tools/files/readFile.d.ts',
      }),
      {
        ok: true,
        module: {
          specifier: '@geulbat/generated-tools/files/readFile.d.ts',
          filePath: join(
            result.mount.projectionRootPath,
            tool.wrapperDeclarationModule,
          ),
          role: 'wrapper_declaration',
        },
      },
    );
  } finally {
    await rm(stateRoot, { recursive: true, force: true });
  }
});

void test('resolveToolLibraryProjectionMountedModule rejects aliases and traversal-shaped subpaths', async () => {
  const stateRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-tool-library-mounted-module-reject-'),
  );
  try {
    const runtime = createToolLibraryProjectionPort({
      registry: createBuiltinToolRegistryStore(),
      runtimeRootForState(root) {
        return join(root, '.geulbat', 'tool-library', 'projections');
      },
      sdkVersion: BASE_PROJECTION_ARGS.sdkVersion,
      sourceRegistryVersion: BASE_PROJECTION_ARGS.sourceRegistryVersion,
      runtimeCompatibilityRange: BASE_PROJECTION_ARGS.runtimeCompatibilityRange,
      modelFacingCatalogRef: BASE_PROJECTION_ARGS.modelFacingCatalogRef,
      importSpecifier: BASE_PROJECTION_ARGS.importSpecifier,
    });
    const result = await runtime.resolveProjection({
      stateRoot,
      threadId: 'thread-runtime-test',
      allowedRegistryNames: ['read_file'],
    });
    assert.equal(result.ok, true);
    if (!result.ok) {
      assert.fail('expected projection port to resolve');
    }

    for (const specifier of [
      '@geulbat/other-tools',
      '@geulbat/generated-tools/',
      '@geulbat/generated-tools/../catalog',
      '@geulbat/generated-tools/catalog.js',
      '@geulbat/generated-tools/search-runtime.js',
      '@geulbat/generated-tools/files/readFile.js',
      '@geulbat/generated-tools/signatures/read_file',
      '@geulbat/generated-tools/tools/missing-tool',
    ]) {
      const resolved = resolveToolLibraryProjectionMountedModule({
        mount: result.mount,
        specifier,
      });
      assert.equal(resolved.ok, false);
      if (resolved.ok) {
        assert.fail(`expected ${specifier} to be rejected`);
      }
      assert.equal(resolved.reason, 'module_not_mounted');
      assert.equal(
        resolved.message,
        'Tool library projection module is not mounted',
      );
      assert.equal(resolved.message.includes(stateRoot), false);
    }
  } finally {
    await rm(stateRoot, { recursive: true, force: true });
  }
});

void test('writeToolLibraryProjectionFiles rejects unsafe generated file paths', async () => {
  const parentPath = await mkdtemp(join(tmpdir(), 'geulbat-tool-library-'));
  const rootPath = join(parentPath, 'sdk');
  const outsidePath = join(parentPath, 'escape.ts');
  try {
    await mkdir(rootPath);

    const projection = {
      rootPath,
      files: [
        {
          path: '../escape.ts',
          role: 'wrapper',
          content: 'export {};\n',
        },
      ],
    } satisfies Pick<ToolLibraryProjection, 'rootPath' | 'files'>;

    await assert.rejects(
      () => writeToolLibraryProjectionFiles(projection),
      /Invalid tool library projection file path: \.\.\/escape\.ts/u,
    );
    assert.equal(await pathExists(outsidePath), false);
  } finally {
    await rm(parentPath, { recursive: true, force: true });
  }
});

function buildTestProjection(
  overrides: Pick<
    BuildToolLibraryProjectionArgs,
    'registry' | 'allowedRegistryNames'
  >,
) {
  return buildToolLibraryProjection({
    ...BASE_PROJECTION_ARGS,
    ...overrides,
  });
}

function readRegisteredBuiltinTools(
  registry: ReturnType<typeof createBuiltinToolRegistryStore>,
): AnyTool[] {
  return registry
    .getAllRegisteredToolNames()
    .map((name) => registry.getTool(name))
    .filter((tool): tool is AnyTool => tool !== undefined);
}

function summarizeToolSearchRanking(
  results: ReadonlyArray<{
    publicName?: unknown;
    rank?: unknown;
    score?: unknown;
    signatureRef?: unknown;
  }>,
) {
  return results.map((result) => ({
    publicName: result.publicName,
    rank: result.rank,
    score: result.score,
    signatureRef: result.signatureRef,
  }));
}

function createProjectionTestTool(args: {
  includeExtraParameter: boolean;
}): AnyTool {
  const properties: ToolParameters = {
    type: 'object',
    properties: {
      value: { type: 'string' },
      ...(args.includeExtraParameter ? { mode: { type: 'string' } } : {}),
    },
    required: ['value'],
    additionalProperties: false,
  };
  return {
    name: 'projection_test',
    description: 'Projection test tool.',
    parameters: properties,
    strict: true,
    sideEffectLevel: 'none',
    mayMutateComputerFiles: false,
    requiresApproval: false,
    exposure: {
      directHot: false,
      sdkVisible: true,
      inCellCallable: true,
      directOnly: false,
      approvalRequired: false,
      effectClass: 'readOnly',
    },
    catalogSearchMetadata: {
      family: 'catalog',
      searchHints: ['projection test'],
      tags: ['projection'],
      whenToUse: 'Exercise projection hashing.',
      notFor: 'Production use.',
    },
    parseArgs() {
      return { ok: true, value: {} };
    },
    async executeParsed() {
      return { ok: true, output: '{}' };
    },
  };
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function containsStringValue(value: unknown, needle: string): boolean {
  if (typeof value === 'string') {
    return value.includes(needle);
  }
  if (Array.isArray(value)) {
    return value.some((item) => containsStringValue(item, needle));
  }
  if (value !== null && typeof value === 'object') {
    return Object.values(value).some((item) =>
      containsStringValue(item, needle),
    );
  }
  return false;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}
