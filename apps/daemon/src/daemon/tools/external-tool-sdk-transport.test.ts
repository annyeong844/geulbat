import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  TOOL_SDK_RELEASE,
  createToolSdkClient,
  type ToolSdkJsonValue,
  type ToolSdkProjectionIdentity,
} from '@geulbat/tool-sdk';

import { createDaemonContext } from '../context.js';
import { readFileTool } from './builtin/read-file.js';
import { searchFilesTool } from './builtin/search-files.js';
import { DAEMON_TOOL_SDK_PUBLIC_BINDINGS } from './external-tool-sdk-public-tools.js';
import { createDaemonToolSdkTransport } from './external-tool-sdk-transport.js';
import { createToolRegistryStore } from './registry.js';

const PROJECTION: ToolSdkProjectionIdentity = {
  schemaVersion: TOOL_SDK_RELEASE.projectionSchemaVersion,
  sdkProjectionHash: `sha256:${'c'.repeat(64)}`,
  policyId: 'external-read-v1',
};

void test('daemon transport maps files.read to the real registry and re-authenticates invocation', async (t) => {
  const computerFileRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-external-tool-sdk-'),
  );
  t.after(() => rm(computerFileRoot, { recursive: true, force: true }));
  await writeFile(
    join(computerFileRoot, 'notes.txt'),
    'first\nsecond\nthird\n',
    'utf8',
  );
  const daemonContext = createDaemonContext({
    homeStateRoot: computerFileRoot,
  });
  let authenticationCount = 0;
  let authorizationCount = 0;
  const transport = daemonContext.createExternalToolSdkTransport({
    getProjectionIdentity: () => PROJECTION,
    authority: {
      async authenticate(credential) {
        authenticationCount += 1;
        return credential.value === 'valid-credential'
          ? { ok: true as const, principal: { subject: 'consumer-1' } }
          : { ok: false as const, code: 'authentication_invalid' as const };
      },
      async authorizeInvocation(options) {
        authorizationCount += 1;
        assert.equal(options.principal.subject, 'consumer-1');
        assert.equal(options.publicTool, 'files.read');
        assert.equal(Reflect.set(options.input, 'path', 'tampered.txt'), false);
        return {
          ok: true as const,
          context: {
            callId: `external-read-${authorizationCount}`,
            computerFileRoot,
          },
        };
      },
    },
  });
  const client = createToolSdkClient({
    transport,
    projection: PROJECTION,
    credentialProvider: validCredentialProvider(),
    requestedPublicTools: ['files.read'],
  });

  assert.equal((await client.connect()).ok, true);
  const result = await client.readFile({
    path: 'notes.txt',
    offset: 1,
    limit: 1,
  });

  assert.deepEqual(result, {
    ok: true,
    value: {
      path: 'notes.txt',
      content: 'second\n',
      versionToken: result.ok ? result.value.versionToken : '',
      totalLines: 3,
      pageLimit: 1,
      startLine: 2,
      endLine: 2,
      hasMore: true,
      nextOffset: 2,
    },
  });
  assert.equal(authenticationCount, 2);
  assert.equal(authorizationCount, 1);
  assert.doesNotMatch(JSON.stringify(result), /read_file|computerFileRoot/);
});

void test('daemon transport keeps __proto__ as data instead of inherited tool arguments', async (t) => {
  const computerFileRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-external-tool-sdk-prototype-'),
  );
  t.after(() => rm(computerFileRoot, { recursive: true, force: true }));
  await writeFile(join(computerFileRoot, 'notes.txt'), 'private\n', 'utf8');
  let observedInput:
    | {
        frozen: boolean;
        hasOwnPath: boolean;
        hasOwnProto: boolean;
        inheritedPath: unknown;
        prototypeIsNull: boolean;
      }
    | undefined;
  const transport = createDaemonToolSdkTransport({
    registry: createToolRegistryStore({ builtins: [readFileTool] }),
    getProjectionIdentity: () => PROJECTION,
    authority: {
      async authenticate() {
        return { ok: true as const, principal: 'consumer-1' };
      },
      async authorizeInvocation(options) {
        observedInput = {
          frozen: Object.isFrozen(options.input),
          hasOwnPath: Object.hasOwn(options.input, 'path'),
          hasOwnProto: Object.hasOwn(options.input, '__proto__'),
          inheritedPath: options.input['path'],
          prototypeIsNull: Object.getPrototypeOf(options.input) === null,
        };
        return {
          ok: true as const,
          context: {
            callId: 'external-prototype-input',
            computerFileRoot,
          },
        };
      },
    },
  });
  const input = JSON.parse(
    '{"__proto__":{"path":"notes.txt","limit":1}}',
  ) as Record<string, ToolSdkJsonValue>;

  const result = await transport.invoke(
    {
      compatibility: {
        packageVersion: TOOL_SDK_RELEASE.packageVersion,
        apiVersion: TOOL_SDK_RELEASE.apiVersion,
        transportProtocolVersion: TOOL_SDK_RELEASE.transportProtocolVersion,
        runtimeCompatibility: TOOL_SDK_RELEASE.runtimeCompatibility,
        projection: PROJECTION,
      },
      publicTool: 'files.read',
      input,
    },
    { credential: { scheme: 'Bearer', value: 'valid-credential' } },
  );

  assert.deepEqual(observedInput, {
    frozen: true,
    hasOwnPath: false,
    hasOwnProto: true,
    inheritedPath: undefined,
    prototypeIsNull: true,
  });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.code, 'invalid_arguments');
  }
});

void test('daemon transport maps files.list through the real registry and sanitizes provenance', async (t) => {
  const computerFileRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-external-tool-sdk-list-'),
  );
  t.after(() => rm(computerFileRoot, { recursive: true, force: true }));
  await mkdir(join(computerFileRoot, 'src'));
  await writeFile(join(computerFileRoot, 'notes.txt'), 'notes\n', 'utf8');
  await writeFile(join(computerFileRoot, 'src', 'index.ts'), 'export {};\n');
  const daemonContext = createDaemonContext({
    homeStateRoot: computerFileRoot,
  });
  let authenticationCount = 0;
  let authorizationCount = 0;
  const transport = daemonContext.createExternalToolSdkTransport({
    getProjectionIdentity: () => PROJECTION,
    authority: {
      async authenticate() {
        authenticationCount += 1;
        return { ok: true as const, principal: 'consumer-1' };
      },
      async authorizeInvocation(options) {
        authorizationCount += 1;
        assert.equal(options.publicTool, 'files.list');
        return {
          ok: true as const,
          context: {
            callId: `external-list-${authorizationCount}`,
            computerFileRoot,
          },
        };
      },
    },
  });
  const client = createToolSdkClient({
    transport,
    projection: PROJECTION,
    credentialProvider: validCredentialProvider(),
  });

  const connection = await client.connect();
  assert.equal(connection.ok, true);
  if (connection.ok) {
    assert.deepEqual(connection.value.publicTools, [
      'files.read',
      'files.list',
      'files.search',
    ]);
  }
  const result = await client.listFiles({ path: '.', recursive: true });

  assert.deepEqual(result, {
    ok: true,
    value: {
      path: '.',
      total: 3,
      entries: [
        { name: 'notes.txt', path: 'notes.txt', type: 'file' },
        { name: 'src', path: 'src', type: 'directory' },
        { name: 'index.ts', path: 'src/index.ts', type: 'file' },
      ],
    },
  });
  assert.equal(authenticationCount, 2);
  assert.equal(authorizationCount, 1);
  assert.doesNotMatch(
    JSON.stringify(result),
    /list_files|computerFileRoot|"root"|tool_library_projection/u,
  );
});

void test('daemon transport maps files.search through the real registry and publishes a stable DTO', async (t) => {
  const computerFileRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-external-tool-sdk-search-'),
  );
  t.after(() => rm(computerFileRoot, { recursive: true, force: true }));
  await writeFile(
    join(computerFileRoot, 'notes.txt'),
    'first line\nneedle line\n',
    'utf8',
  );
  const daemonContext = createDaemonContext({
    homeStateRoot: computerFileRoot,
  });
  t.after(async () => {
    await daemonContext.hostCommands.closeAll();
  });
  let authenticationCount = 0;
  let authorizationCount = 0;
  const transport = createDaemonToolSdkTransport({
    registry: createToolRegistryStore({ builtins: [searchFilesTool] }),
    getProjectionIdentity: () => PROJECTION,
    authority: {
      async authenticate() {
        authenticationCount += 1;
        return { ok: true as const, principal: 'consumer-1' };
      },
      async authorizeInvocation(options) {
        authorizationCount += 1;
        assert.equal(options.publicTool, 'files.search');
        return {
          ok: true as const,
          context: {
            callId: `external-search-${authorizationCount}`,
            computerFileRoot,
            stateRoot: computerFileRoot,
            runtimeServices: daemonContext,
          },
        };
      },
    },
  });
  const client = createToolSdkClient({
    transport,
    projection: PROJECTION,
    credentialProvider: validCredentialProvider(),
    requestedPublicTools: ['files.search'],
  });

  assert.equal((await client.connect()).ok, true);
  const result = await client.searchFiles({
    pattern: 'needle',
    path: '.',
    type: 'content',
    include: '*.txt',
    maxResults: 2,
  });

  assert.equal(result.ok, true);
  if (!result.ok) {
    return;
  }
  assert.equal(result.value.path, '.');
  assert.equal(result.value.type, 'content');
  assert.equal(result.value.consistency, 'filesystem_snapshot');
  assert.equal(result.value.total, 1);
  assert.equal(result.value.totalRelation, 'exact');
  assert.equal(result.value.truncated, false);
  assert.equal(result.value.results.length, 1);
  assert.equal(result.value.results[0]?.path, 'notes.txt');
  assert.equal(result.value.results[0]?.line, 2);
  assert.equal(authenticationCount, 2);
  assert.equal(authorizationCount, 1);
  assert.doesNotMatch(
    JSON.stringify(result),
    /backend|acceleration|search_files|computerFileRoot|"root"|"query"/u,
  );
});

void test('files.search public consistency follows the request rather than index acceleration metadata', () => {
  const result = DAEMON_TOOL_SDK_PUBLIC_BINDINGS[
    'files.search'
  ].normalizeResult(
    JSON.stringify({
      path: '.',
      backend: 'windows-search-index+ripgrep-files',
      consistency: 'eventual_index',
      query: 'filename',
      total: 1,
      truncated: false,
      results: [{ path: 'geulbat.txt', line: 0, text: '' }],
    }),
    {
      pattern: '*geulbat*',
      path: '.',
      type: 'filename',
      consistency: 'filesystem_snapshot',
    },
  );

  assert.deepEqual(result, {
    ok: true,
    value: {
      kind: 'inline',
      value: {
        path: '.',
        type: 'filename',
        consistency: 'filesystem_snapshot',
        total: 1,
        totalRelation: 'exact',
        truncated: false,
        results: [{ path: 'geulbat.txt', line: 0, text: '' }],
      },
    },
  });
});

void test('registry admission is checked again after a successful handshake', async () => {
  const registry = createToolRegistryStore({ builtins: [readFileTool] });
  let authenticationCount = 0;
  let authorizationCount = 0;
  const transport = createDaemonToolSdkTransport({
    registry,
    getProjectionIdentity: () => PROJECTION,
    authority: {
      async authenticate() {
        authenticationCount += 1;
        return { ok: true as const, principal: 'consumer-1' };
      },
      async authorizeInvocation() {
        authorizationCount += 1;
        return {
          ok: true as const,
          context: { callId: 'must-not-execute' },
        };
      },
    },
  });
  const client = createToolSdkClient({
    transport,
    projection: PROJECTION,
    credentialProvider: validCredentialProvider(),
    requestedPublicTools: ['files.read'],
  });

  assert.equal((await client.connect()).ok, true);
  assert.equal(registry.unregisterTool('read_file'), true);
  const result = await client.readFile({ path: 'notes.txt', limit: 1 });

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.code, 'tool_not_admitted');
  }
  assert.equal(authenticationCount, 2);
  assert.equal(authorizationCount, 0);
});

void test('projection drift is rejected before invocation authorization', async () => {
  const registry = createToolRegistryStore({ builtins: [readFileTool] });
  let currentProjection = PROJECTION;
  let authorizationCount = 0;
  const transport = createDaemonToolSdkTransport({
    registry,
    getProjectionIdentity: () => currentProjection,
    authority: {
      async authenticate() {
        return { ok: true as const, principal: 'consumer-1' };
      },
      async authorizeInvocation() {
        authorizationCount += 1;
        return {
          ok: true as const,
          context: { callId: 'must-not-execute' },
        };
      },
    },
  });
  const client = createToolSdkClient({
    transport,
    projection: PROJECTION,
    credentialProvider: validCredentialProvider(),
    requestedPublicTools: ['files.read'],
  });

  assert.equal((await client.connect()).ok, true);
  currentProjection = {
    ...PROJECTION,
    sdkProjectionHash: `sha256:${'d'.repeat(64)}`,
  };
  const result = await client.readFile({ path: 'notes.txt', limit: 1 });

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.code, 'projection_mismatch');
  }
  assert.equal(authorizationCount, 0);
});

void test('authority denial fails closed before the internal tool executes', async () => {
  const registry = createToolRegistryStore({ builtins: [readFileTool] });
  const transport = createDaemonToolSdkTransport({
    registry,
    getProjectionIdentity: () => PROJECTION,
    authority: {
      async authenticate() {
        return { ok: true as const, principal: 'consumer-1' };
      },
      async authorizeInvocation() {
        return { ok: false as const, code: 'approval_denied' as const };
      },
    },
  });
  const client = createToolSdkClient({
    transport,
    projection: PROJECTION,
    credentialProvider: validCredentialProvider(),
    requestedPublicTools: ['files.read'],
  });

  assert.equal((await client.connect()).ok, true);
  const result = await client.readFile({ path: 'notes.txt', limit: 1 });

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.code, 'approval_denied');
  }
});

void test('invalid authentication rejects the handshake without revealing admission', async () => {
  const registry = createToolRegistryStore({ builtins: [readFileTool] });
  const transport = createDaemonToolSdkTransport({
    registry,
    getProjectionIdentity: () => PROJECTION,
    authority: {
      async authenticate() {
        return { ok: false as const, code: 'authentication_invalid' as const };
      },
      async authorizeInvocation() {
        assert.fail('authorization must not run');
      },
    },
  });
  const client = createToolSdkClient({
    transport,
    projection: PROJECTION,
    credentialProvider: validCredentialProvider(),
    requestedPublicTools: ['files.read'],
  });

  const result = await client.connect();

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.code, 'authentication_invalid');
  }
});

function validCredentialProvider() {
  return {
    async getCredential() {
      return { scheme: 'Bearer', value: 'valid-credential' };
    },
  };
}
