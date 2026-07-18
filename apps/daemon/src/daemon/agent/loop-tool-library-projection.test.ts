import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createAgentLoopToolLibraryProjectionPort,
  formatToolLibraryProjectionFailureMessage,
} from './loop-tool-library-projection.js';

void test('createAgentLoopToolLibraryProjectionPort delegates to the daemon projection port', async () => {
  const port = createAgentLoopToolLibraryProjectionPort({
    async resolveProjection(args) {
      assert.deepEqual(args, {
        stateRoot: '/home-state',
        threadId: 'thread-1',
        allowedRegistryNames: ['fetch_url'],
      });
      return {
        ok: true,
        mount: {
          sdkVersion: 'sdk-v1',
          sdkProjectionHash:
            'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
          policyId: 'registry_allow_list',
          importSpecifier: '@geulbat/generated-tools',
          modelFacingCatalogRef: 'geulbat-sdk://catalog',
          projectionRootPath: '/projection',
          manifestModulePath: '/projection/manifest.js',
          catalogModulePath: '/projection/catalog.js',
          searchModulePath: '/projection/search.js',
          searchRuntimeModulePath: '/projection/search-runtime.js',
          indexModulePath: '/projection/index.js',
          indexDeclarationPath: '/projection/index.d.ts',
          importableModules: [],
        },
        pin: {
          sdkVersion: 'sdk-v1',
          sdkProjectionHash:
            'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
          policyId: 'registry_allow_list',
          sourceRegistryVersion: 'registry-v1',
          runtimeCompatibilityRange: 'runtime-v1',
          modelFacingCatalogRef: 'geulbat-sdk://catalog',
          importSpecifier: '@geulbat/generated-tools',
          catalogModule: 'catalog.js',
          searchModule: 'search.js',
          searchRuntimeModule: 'search-runtime.js',
          indexDeclarationModule: 'index.d.ts',
          allowedPublicNames: ['fetch_url'],
          allowedRegistryNames: ['fetch_url'],
          allowedCallbackNames: [],
          importableModules: [],
          projectionDirectory:
            'sha256-0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
        },
        prunedProjectionDirectories: [],
        projectionPruneFailedDirectories: [],
        projection: {
          sdkVersion: 'sdk-v1',
          sdkProjectionHash:
            'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
          sourceRegistryVersion: 'registry-v1',
          policyId: 'registry_allow_list',
          runtimeCompatibilityRange: 'runtime-v1',
          rootPath: '/projection',
          catalogPath: '/projection/catalog.js',
          modelFacingCatalogRef: 'geulbat-sdk://catalog',
          importSpecifier: '@geulbat/generated-tools',
          allowedPublicNames: ['fetch_url'],
          allowedRegistryNames: ['fetch_url'],
          allowedCallbackNames: [],
          importableModules: [],
          tools: [],
          files: [],
        },
        writtenFiles: [],
      };
    },
  });

  const result = await port.resolveProjection({
    stateRoot: '/home-state',
    threadId: 'thread-1',
    allowedRegistryNames: ['fetch_url'],
  });

  assert.deepEqual(result, {
    ok: true,
    identity: {
      sdkVersion: 'sdk-v1',
      sdkProjectionHash:
        'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
      policyId: 'registry_allow_list',
    },
  });
});

void test('createAgentLoopToolLibraryProjectionPort preserves sanitized failure diagnostics', async () => {
  const port = createAgentLoopToolLibraryProjectionPort({
    async resolveProjection() {
      return {
        ok: false,
        reason: 'projection_failed',
        message: 'Tool library projection failed',
        diagnostics: { errorName: 'Error', errorCode: 'EACCES' },
      };
    },
  });

  const result = await port.resolveProjection({
    stateRoot: '/home-state',
    threadId: 'thread-1',
  });

  assert.deepEqual(result, {
    ok: false,
    message: 'Tool library projection failed',
    diagnostics: { errorName: 'Error', errorCode: 'EACCES' },
  });
  assert.equal(
    formatToolLibraryProjectionFailureMessage(result),
    'Tool library projection failed (Error EACCES)',
  );
});
