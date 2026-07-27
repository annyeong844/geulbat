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

  registry.registerTool({
    name: 'external_deferred_probe',
    description:
      'A run-authorized external tool that stays out of hot schemas.',
    parameters: {
      type: 'object',
      properties: {},
      required: [],
      additionalProperties: false,
    },
    strict: true,
    sideEffectLevel: 'read',
    mayMutateComputerFiles: false,
    requiresApproval: false,
    exposure: {
      directHot: false,
      sdkVisible: true,
      inCellCallable: true,
      directOnly: false,
      effectClass: 'readOnly',
    },
    parseArgs() {
      return { ok: true, value: {} };
    },
    async executeParsed() {
      return { ok: true, output: '{}' };
    },
  });
  const rootPolicy = createAgentToolCapabilityPolicy({ registry });
  const allRegistryNames = [...registry.getAllRegisteredToolNames()].sort();
  assert.deepEqual(rootPolicy.directRegistryNames, [
    'agent_retry',
    'agent_send_input',
    'agent_set_priority',
    'agent_spawn',
    'agent_stop',
    'agent_wait',
    'apply_patch',
    'ask_user',
    'exec',
    'exec_command',
    'inspect_git',
    'list_files',
    'manage_files',
    'propose_plan',
    'read_file',
    'read_tool_output',
    'search_files',
    'search_memory_index',
    'tool_search',
    'update_goal',
    'update_plan',
    'wait',
    'write_file',
    'write_stdin',
  ]);
  assert.deepEqual(rootPolicy.allowedRegistryNames, allRegistryNames);
  assert.deepEqual(
    rootPolicy.allowedRegistryNames.filter(
      (name) => !rootPolicy.directRegistryNames.includes(name),
    ),
    [
      'browser_navigate',
      'browser_page_load_evidence',
      'browser_text_evidence',
      'cite_memory',
      'external_deferred_probe',
      'fetch_url',
      'generate_image',
      'generate_video',
      'list_commands',
      'refresh_memory_index',
      'set_thread_title',
      'skill_search',
      'submit_result_report',
      'suggest_followup',
      'visualize',
      'web_search',
      'write_memory_note',
    ],
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
    async rehydrateProjectionMount() {
      assert.fail('fresh projection test must not rehydrate');
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
    async rehydrateProjectionMount() {
      assert.fail('fresh projection failure test must not rehydrate');
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
    async rehydrateProjectionMount() {
      assert.fail('fresh capability-policy test must not rehydrate');
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

void test('createAgentLoopToolLibraryProjectionPort rehydrates an exact recorded identity without fresh resolution', async () => {
  const expectedIdentity = {
    sdkVersion: 'sdk-replay-v1',
    sdkProjectionHash:
      'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    policyId: 'policy-replay-v1',
  } as const;
  let freshResolutionCount = 0;
  const port = createAgentLoopToolLibraryProjectionPort({
    async resolveProjection() {
      freshResolutionCount += 1;
      assert.fail('recorded projection replay must not resolve a fresh pin');
    },
    async rehydrateProjectionMount(args) {
      assert.deepEqual(args, {
        stateRoot: '/home-state',
        threadId: 'thread-replay',
        expectedIdentity,
      });
      return {
        ok: false,
        reason: 'projection_failed',
        message: 'expected replay stop',
      };
    },
  });

  assert.deepEqual(
    await port.resolveProjection({
      stateRoot: '/home-state',
      threadId: 'thread-replay',
      expectedIdentity,
    }),
    { ok: false, message: 'expected replay stop' },
  );
  assert.equal(freshResolutionCount, 0);
});

void test('createAgentLoopToolLibraryProjectionPort rejects recorded identity policy drift before projection access', async () => {
  const toolCapabilityPolicy = createToolCapabilityPolicy({
    directRegistryNames: ['list_files'],
    allowedRegistryNames: ['list_files'],
    callbackRegistryNames: [],
    writeCallbackEnabled: false,
  });
  let projectionAccessCount = 0;
  const port = createAgentLoopToolLibraryProjectionPort({
    async resolveProjection() {
      projectionAccessCount += 1;
      assert.fail('policy drift must stop before fresh resolution');
    },
    async rehydrateProjectionMount() {
      projectionAccessCount += 1;
      assert.fail('policy drift must stop before rehydration');
    },
  });

  assert.deepEqual(
    await port.resolveProjection({
      stateRoot: '/home-state',
      threadId: 'thread-policy-drift',
      toolCapabilityPolicy,
      expectedIdentity: {
        sdkVersion: 'sdk-replay-v1',
        sdkProjectionHash:
          'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
        policyId: 'stale-policy',
      },
    }),
    {
      ok: false,
      message:
        'Recorded tool library projection identity does not match the run capability policy',
    },
  );
  assert.equal(projectionAccessCount, 0);
});
