import assert from 'node:assert/strict';
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import test from 'node:test';

import { createToolCapabilityPolicy } from '@geulbat/tool-library/tool-capability-policy';
import { createBuiltinToolRegistryStore } from './builtin/catalog.js';
import { createToolRegistryStore } from './registry.js';
import { buildToolLibraryProjection } from './tool-library-projection.js';
import { buildToolSignatureRef } from '@geulbat/tool-library/projection-signature';
import type { BuildToolLibraryProjectionArgs } from './tool-library-projection-port.js';
import {
  getToolLibraryProjectionManifest,
  getToolLibraryProjectionIdentity,
  getToolLibraryProjectionPin,
  projectionDirectoryNameForHash,
} from '@geulbat/tool-library/projection-manifest';
import { getToolLibraryProjectionMount } from './tool-library-projection-mount.js';
import { readVerifiedToolLibraryProjectionMount } from './tool-library-projection-store.js';
import { threadProjectionDirectoryName } from './tool-library-projection-path.js';
import {
  isToolObjectParameters,
  type AnyTool,
  type ToolParameters,
} from './types.js';
import {
  BASE_PROJECTION_ARGS,
  containsStringValue,
  createTestProjectionPort,
  pathExists,
} from '../../test-support/tool-library-projection.js';

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
  assert.deepEqual(tool.resultDelivery, {
    exactDurableRecovery: true,
    modelVisibleForms: ['inline', 'summary_ref', 'duplicate_ref'],
  });
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

void test('createToolLibraryProjectionPort writes a pinned projection under the runtime root', async () => {
  const stateRoot = await mkdtemp(join(tmpdir(), 'geulbat-tool-library-'));
  try {
    const runtime = createTestProjectionPort();

    const result = await runtime.resolveProjection({
      stateRoot,
      threadId: 'thread-runtime-test',
      allowedRegistryNames: ['read_file'],
    });

    assert.equal(result.ok, true);
    if (!result.ok) {
      assert.fail('expected projection port to resolve');
    }
    // 콘텐츠는 digest로 주소가 정해진 공유 위치에, pin만 thread 위치에 남는다.
    assert.match(
      result.projection.rootPath,
      /\.geulbat[\\/]+tool-library[\\/]+projections[\\/]+content[\\/]+sha256-[0-9a-f]{64}$/u,
    );
    assert.equal(
      result.projection.rootPath.includes('thread-runtime-test'),
      false,
    );
    assert.equal(result.projection.rootPath.includes('thread-'), false);
    const projectionsRootPath = dirname(dirname(result.projection.rootPath));
    assert.equal(
      await pathExists(
        join(
          projectionsRootPath,
          threadProjectionDirectoryName('thread-runtime-test'),
          'projection-pin.json',
        ),
      ),
      true,
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

    const contentRootPath = dirname(result.projection.rootPath);
    const expectedPin = getToolLibraryProjectionPin(result.projection);
    const mountResult = await readVerifiedToolLibraryProjectionMount({
      contentRootPath,
      threadProjectionRootPath: join(
        dirname(contentRootPath),
        threadProjectionDirectoryName('thread-runtime-test'),
      ),
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

void test('createToolLibraryProjectionPort binds an explicit callback surface to its policy identity', async () => {
  const stateRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-tool-library-capability-policy-'),
  );
  const firstPolicy = createToolCapabilityPolicy({
    directRegistryNames: [],
    allowedRegistryNames: ['list_files', 'read_file'],
    callbackRegistryNames: ['read_file'],
    writeCallbackEnabled: false,
  });
  const changedPolicy = createToolCapabilityPolicy({
    directRegistryNames: [],
    allowedRegistryNames: ['list_files', 'read_file'],
    callbackRegistryNames: ['list_files'],
    writeCallbackEnabled: false,
  });
  try {
    const runtime = createTestProjectionPort();
    const first = await runtime.resolveProjection({
      stateRoot,
      threadId: 'thread-capability-policy',
      toolCapabilityPolicy: firstPolicy,
    });
    assert.equal(first.ok, true);
    if (!first.ok) {
      assert.fail('expected explicit capability policy projection to resolve');
    }
    assert.equal(first.pin.policyId, firstPolicy.toolCapabilityPolicyId);
    assert.deepEqual(first.pin.allowedRegistryNames, ['read_file']);

    const changed = await runtime.resolveProjection({
      stateRoot,
      threadId: 'thread-capability-policy',
      toolCapabilityPolicy: changedPolicy,
    });
    assert.deepEqual(changed, {
      ok: false,
      reason: 'projection_failed',
      message:
        'Pinned tool library projection does not match the requested tool capability policy',
    });

    const outsideCallbackSurface = await runtime.resolveProjection({
      stateRoot,
      threadId: 'thread-invalid-capability-policy',
      toolCapabilityPolicy: createToolCapabilityPolicy({
        directRegistryNames: [],
        allowedRegistryNames: ['exec_command'],
        callbackRegistryNames: ['exec_command'],
        writeCallbackEnabled: true,
      }),
    });
    assert.equal(outsideCallbackSurface.ok, false);
  } finally {
    await rm(stateRoot, { recursive: true, force: true });
  }
});

void test('createToolLibraryProjectionPort accepts delegated approval callbacks without enabling the built-in write tier', async () => {
  const stateRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-tool-library-delegated-approval-callback-'),
  );
  const tool = createDelegatedApprovalProjectionTestTool();
  const registry = createToolRegistryStore({ builtins: [tool] });
  const policy = createToolCapabilityPolicy({
    directRegistryNames: [],
    allowedRegistryNames: [tool.name],
    callbackRegistryNames: [tool.name],
    writeCallbackEnabled: false,
  });
  try {
    const result = await createTestProjectionPort({
      registry,
    }).resolveProjection({
      stateRoot,
      threadId: 'thread-delegated-approval-callback',
      toolCapabilityPolicy: policy,
    });

    assert.equal(result.ok, true);
    if (!result.ok) {
      assert.fail('expected delegated approval callback projection to resolve');
    }
    assert.equal(result.pin.policyId, policy.toolCapabilityPolicyId);
    assert.deepEqual(result.pin.allowedRegistryNames, [tool.name]);
  } finally {
    await rm(stateRoot, { recursive: true, force: true });
  }
});

void test('createToolLibraryProjectionPort transitions one matching legacy thread pin to an explicit policy', async () => {
  const stateRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-tool-library-policy-transition-'),
  );
  const projectionPolicy = { policyId: 'legacy-read-callback-policy' };
  const explicitPolicy = createToolCapabilityPolicy({
    directRegistryNames: ['list_files'],
    allowedRegistryNames: ['list_files', 'read_file'],
    callbackRegistryNames: ['read_file'],
    writeCallbackEnabled: false,
  });
  try {
    const runtime = createTestProjectionPort({ projectionPolicy });
    const legacy = await runtime.resolveProjection({
      stateRoot,
      threadId: 'thread-legacy-policy-transition',
      allowedRegistryNames: ['read_file'],
    });
    assert.equal(legacy.ok, true);
    if (!legacy.ok) {
      assert.fail('expected legacy projection to resolve');
    }
    assert.equal(legacy.pin.policyId, projectionPolicy.policyId);

    const transitioned = await runtime.resolveProjection({
      stateRoot,
      threadId: 'thread-legacy-policy-transition',
      toolCapabilityPolicy: explicitPolicy,
    });
    assert.equal(transitioned.ok, true);
    if (!transitioned.ok) {
      assert.fail('expected matching legacy projection to transition');
    }
    assert.equal(
      transitioned.pin.policyId,
      explicitPolicy.toolCapabilityPolicyId,
    );
    assert.deepEqual(transitioned.pin.allowedRegistryNames, ['read_file']);

    const mismatchedLegacy = await runtime.resolveProjection({
      stateRoot,
      threadId: 'thread-legacy-policy-mismatch',
      allowedRegistryNames: ['read_file'],
    });
    assert.equal(mismatchedLegacy.ok, true);
    const mismatched = await runtime.resolveProjection({
      stateRoot,
      threadId: 'thread-legacy-policy-mismatch',
      toolCapabilityPolicy: createToolCapabilityPolicy({
        directRegistryNames: ['list_files'],
        allowedRegistryNames: ['list_files'],
        callbackRegistryNames: ['list_files'],
        writeCallbackEnabled: false,
      }),
    });
    assert.equal(mismatched.ok, false);
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
    const runtime = createTestProjectionPort({
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
  const runtime = createTestProjectionPort({
    runtimeRootForState() {
      throw projectionError;
    },
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
  const runtime = createTestProjectionPort({
    runtimeRootForState() {
      throw {
        code: tokenShapedCode,
        name: tokenShapedName,
      };
    },
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
    const runtime = createTestProjectionPort({
      registry,
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
    const contentRootPath = dirname(first.projection.rootPath);
    const invalidProjectionDirectory = `sha256-${'0'.repeat(64)}`;
    const invalidProjectionRootPath = join(
      contentRootPath,
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
      contentRootPath,
      threadProjectionRootPath: join(
        dirname(contentRootPath),
        threadProjectionDirectoryName('thread-pinned-reuse-test'),
      ),
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
    const runtime = createTestProjectionPort({
      registry,
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

void test('createToolLibraryProjectionPort rehydrates pinned projection through daemon-owned port', async () => {
  const stateRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-tool-library-runtime-rehydrate-'),
  );
  try {
    const runtime = createTestProjectionPort();
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
    const runtime = createTestProjectionPort();
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

void test('projection bundle import reuses exact shared content for another thread in one Home', async () => {
  const stateRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-tool-library-bundle-shared-content-'),
  );
  try {
    const port = createTestProjectionPort();
    const resolved = await port.resolveProjection({
      stateRoot,
      threadId: 'source-shared-content-task',
      allowedRegistryNames: ['read_file'],
    });
    assert.equal(resolved.ok, true);
    if (!resolved.ok) {
      assert.fail('expected source projection to resolve');
    }
    const identity = getToolLibraryProjectionIdentity(resolved.pin);
    const exported = await port.exportProjectionBundle({
      stateRoot,
      threadId: 'source-shared-content-task',
      expectedIdentity: identity,
    });
    assert.equal(exported.ok, true);
    if (!exported.ok) {
      assert.fail('expected exact projection bundle export');
    }

    const imported = await port.importProjectionBundle({
      stateRoot,
      threadId: 'target-shared-content-task',
      serializedBundle: exported.serializedBundle,
    });
    assert.equal(imported.ok, true);
    if (!imported.ok) {
      assert.fail('expected shared projection content to be reused');
    }
    assert.deepEqual(getToolLibraryProjectionIdentity(imported.pin), identity);
    assert.equal(
      imported.mount.projectionRootPath,
      resolved.mount.projectionRootPath,
    );
  } finally {
    await rm(stateRoot, { recursive: true, force: true });
  }
});

void test('projection bundle moves one exact projection between Home roots without authority state', async () => {
  const sourceStateRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-tool-library-bundle-source-'),
  );
  const targetStateRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-tool-library-bundle-target-'),
  );
  try {
    const sourcePort = createTestProjectionPort();
    const sourceThreadId = 'source-task-record';
    const targetThreadId = 'target-task-record';
    const resolved = await sourcePort.resolveProjection({
      stateRoot: sourceStateRoot,
      threadId: sourceThreadId,
      allowedRegistryNames: ['read_file'],
    });
    assert.equal(resolved.ok, true);
    if (!resolved.ok) {
      assert.fail('expected source projection to resolve');
    }
    const identity = getToolLibraryProjectionIdentity(resolved.pin);
    const exported = await sourcePort.exportProjectionBundle({
      stateRoot: sourceStateRoot,
      threadId: sourceThreadId,
      expectedIdentity: identity,
    });
    assert.equal(exported.ok, true);
    if (!exported.ok) {
      assert.fail('expected exact projection bundle export');
    }
    assert.deepEqual(exported.identity, identity);
    assert.match(exported.bundleId, /^sha256:[0-9a-f]{64}$/u);
    assert.equal(exported.serializedBundle.includes(sourceStateRoot), false);
    assert.equal(exported.serializedBundle.includes(sourceThreadId), false);
    assert.equal(
      exported.serializedBundle.includes('computerSessionId'),
      false,
    );
    assert.equal(exported.serializedBundle.includes('approvalGrant'), false);
    assert.equal(exported.serializedBundle.includes('approvalDecision'), false);

    const targetPort = createTestProjectionPort();
    const imported = await targetPort.importProjectionBundle({
      stateRoot: targetStateRoot,
      threadId: targetThreadId,
      serializedBundle: exported.serializedBundle,
    });
    assert.equal(imported.ok, true);
    if (!imported.ok) {
      assert.fail('expected destination projection bundle import');
    }
    assert.deepEqual(getToolLibraryProjectionIdentity(imported.pin), identity);
    assert.equal(
      imported.mount.projectionRootPath.startsWith(targetStateRoot),
      true,
    );
    assert.equal(
      imported.mount.projectionRootPath.includes(sourceStateRoot),
      false,
    );

    const importedAgain = await targetPort.importProjectionBundle({
      stateRoot: targetStateRoot,
      threadId: targetThreadId,
      serializedBundle: exported.serializedBundle,
    });
    assert.equal(importedAgain.ok, true);
  } finally {
    await rm(sourceStateRoot, { recursive: true, force: true });
    await rm(targetStateRoot, { recursive: true, force: true });
  }
});

void test('projection bundle import rejects a destination without the executable registry surface', async () => {
  const sourceStateRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-tool-library-bundle-registry-source-'),
  );
  const targetStateRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-tool-library-bundle-registry-target-'),
  );
  try {
    const sourcePort = createTestProjectionPort();
    const resolved = await sourcePort.resolveProjection({
      stateRoot: sourceStateRoot,
      threadId: 'source-registry-task',
      allowedRegistryNames: ['read_file'],
    });
    assert.equal(resolved.ok, true);
    if (!resolved.ok) {
      assert.fail('expected source projection to resolve');
    }
    const exported = await sourcePort.exportProjectionBundle({
      stateRoot: sourceStateRoot,
      threadId: 'source-registry-task',
      expectedIdentity: getToolLibraryProjectionIdentity(resolved.pin),
    });
    assert.equal(exported.ok, true);
    if (!exported.ok) {
      assert.fail('expected exact projection bundle export');
    }

    const targetPort = createTestProjectionPort({
      registry: createToolRegistryStore(),
    });
    const imported = await targetPort.importProjectionBundle({
      stateRoot: targetStateRoot,
      threadId: 'target-registry-task',
      serializedBundle: exported.serializedBundle,
    });
    assert.equal(imported.ok, false);
    assert.equal(
      await pathExists(join(targetStateRoot, '.geulbat', 'tool-library')),
      false,
    );
  } finally {
    await rm(sourceStateRoot, { recursive: true, force: true });
    await rm(targetStateRoot, { recursive: true, force: true });
  }
});

void test('projection bundle import rejects a symlinked hash destination before writing', async () => {
  const sourceStateRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-tool-library-bundle-link-source-'),
  );
  const targetStateRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-tool-library-bundle-link-target-'),
  );
  const outsideRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-tool-library-bundle-link-outside-'),
  );
  try {
    const sourcePort = createTestProjectionPort();
    const resolved = await sourcePort.resolveProjection({
      stateRoot: sourceStateRoot,
      threadId: 'source-link-task',
      allowedRegistryNames: ['read_file'],
    });
    assert.equal(resolved.ok, true);
    if (!resolved.ok) {
      assert.fail('expected source projection to resolve');
    }
    const identity = getToolLibraryProjectionIdentity(resolved.pin);
    const exported = await sourcePort.exportProjectionBundle({
      stateRoot: sourceStateRoot,
      threadId: 'source-link-task',
      expectedIdentity: identity,
    });
    assert.equal(exported.ok, true);
    if (!exported.ok) {
      assert.fail('expected exact projection bundle export');
    }

    const targetThreadId = 'target-link-task';
    const targetThreadRoot = join(
      targetStateRoot,
      '.geulbat',
      'tool-library',
      'projections',
      threadProjectionDirectoryName(targetThreadId),
    );
    await mkdir(targetThreadRoot, { recursive: true });
    const targetContentRoot = join(
      targetStateRoot,
      '.geulbat',
      'tool-library',
      'projections',
      'content',
    );
    await mkdir(targetContentRoot, { recursive: true });
    await symlink(
      outsideRoot,
      join(
        targetContentRoot,
        projectionDirectoryNameForHash(identity.sdkProjectionHash),
      ),
      'dir',
    );

    const imported = await createTestProjectionPort().importProjectionBundle({
      stateRoot: targetStateRoot,
      threadId: targetThreadId,
      serializedBundle: exported.serializedBundle,
    });
    assert.deepEqual(imported, {
      ok: false,
      reason: 'projection_failed',
      message: 'Tool library projection bundle destination is already occupied',
    });
    assert.equal(await pathExists(join(outsideRoot, 'manifest.js')), false);
  } finally {
    await rm(sourceStateRoot, { recursive: true, force: true });
    await rm(targetStateRoot, { recursive: true, force: true });
    await rm(outsideRoot, { recursive: true, force: true });
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

function createDelegatedApprovalProjectionTestTool(): AnyTool {
  return {
    ...createProjectionTestTool({ includeExtraParameter: false }),
    name: 'delegated_approval_projection_test',
    sideEffectLevel: 'write',
    mayMutateComputerFiles: true,
    requiresApproval: true,
    exposure: {
      directHot: false,
      sdkVisible: true,
      inCellCallable: true,
      directOnly: false,
      effectClass: 'hostStateMutation',
    },
  };
}
