import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  TOOL_SDK_RELEASE,
  createToolSdkClient,
  type ToolSdkProjectionIdentity,
} from '@geulbat/tool-sdk';

import { createDaemonContext } from '../context.js';
import { readFileTool } from './builtin/read-file.js';
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
