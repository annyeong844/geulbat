import test from 'node:test';
import assert from 'node:assert/strict';
import { createToolCapabilityPolicy } from '@geulbat/tool-library/tool-capability-policy';
import { createBuiltinToolRegistryStore } from '../tools/builtin/catalog.js';

import {
  createAgentLoopToolLibraryProjectionPort,
  createAgentToolCapabilityPolicy,
  formatToolLibraryProjectionFailureMessage,
} from './loop-tool-library-projection.js';

void test('createAgentToolCapabilityPolicy canonicalizes the current direct and callback surfaces', () => {
  const registry = createBuiltinToolRegistryStore();
  const policy = createAgentToolCapabilityPolicy({
    registry,
    toolSurface: {
      directRegistryNames: ['write_file', 'read_file'],
      allowedRegistryNames: ['write_file', 'read_file'],
    },
  });

  assert.deepEqual(policy.directRegistryNames, ['read_file', 'write_file']);
  assert.deepEqual(policy.allowedRegistryNames, ['read_file', 'write_file']);
  assert.deepEqual(policy.callbackRegistryNames, ['read_file']);
  assert.equal(policy.writeCallbackEnabled, false);

  const rootPolicy = createAgentToolCapabilityPolicy({ registry });
  assert.deepEqual(
    rootPolicy.directRegistryNames,
    [...registry.getAllRegisteredToolNames()].sort(),
  );
  assert.deepEqual(
    rootPolicy.allowedRegistryNames,
    rootPolicy.directRegistryNames,
  );
  assert.equal(
    rootPolicy.callbackRegistryNames.every((name) =>
      rootPolicy.allowedRegistryNames.includes(name),
    ),
    true,
  );
});

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

void test('createAgentLoopToolLibraryProjectionPort forwards one full capability policy', async () => {
  const toolCapabilityPolicy = createToolCapabilityPolicy({
    directRegistryNames: ['execute_code'],
    allowedRegistryNames: ['execute_code', 'read_file'],
    callbackRegistryNames: ['read_file'],
    writeCallbackEnabled: false,
  });
  const port = createAgentLoopToolLibraryProjectionPort({
    async resolveProjection(args) {
      assert.deepEqual(args, {
        stateRoot: '/home-state',
        threadId: 'thread-policy',
        toolCapabilityPolicy,
      });
      return {
        ok: false,
        reason: 'projection_failed',
        message: 'expected test stop',
      };
    },
  });

  assert.deepEqual(
    await port.resolveProjection({
      stateRoot: '/home-state',
      threadId: 'thread-policy',
      toolCapabilityPolicy,
    }),
    { ok: false, message: 'expected test stop' },
  );
});
