import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

import { buildToolSignatureRef } from '@geulbat/tool-library/projection-signature';
import { createBuiltinToolRegistryStore } from './builtin/catalog.js';
import {
  buildToolSearchCatalog,
  searchToolCatalog,
  type ToolSearchCatalogCard,
} from './builtin/tool-search.js';
import { resolveToolLibraryProjectionMountedModule } from './tool-library-projection-mount.js';
import type { AnyTool } from './types.js';
import {
  containsStringValue,
  createTestProjectionPort,
} from '../../test-support/tool-library-projection.js';

void test('generated tool library SDK modules can be imported and used at runtime', async () => {
  const stateRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-tool-library-runtime-import-'),
  );
  try {
    const runtime = createTestProjectionPort();
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
    const runtime = createTestProjectionPort();
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

    const runtime = createTestProjectionPort({
      registry,
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
    const runtime = createTestProjectionPort();
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
    const runtime = createTestProjectionPort({
      registry,
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

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}
