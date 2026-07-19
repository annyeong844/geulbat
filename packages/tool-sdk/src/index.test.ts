import assert from 'node:assert/strict';
import test from 'node:test';

import {
  TOOL_SDK_RELEASE,
  createToolSdkClient,
  type ToolSdkHandshakeRequest,
  type ToolSdkProjectionIdentity,
  type ToolSdkTransport,
} from './index.js';

const PROJECTION: ToolSdkProjectionIdentity = {
  schemaVersion: TOOL_SDK_RELEASE.projectionSchemaVersion,
  sdkProjectionHash: `sha256:${'a'.repeat(64)}`,
  policyId: 'external-read-v1',
};

void test('typed readFile uses an explicit transport and omits host-private fields', async () => {
  const credentials: string[] = [];
  const transport: ToolSdkTransport = {
    async handshake(request, context) {
      credentials.push(context.credential.value);
      assert.deepEqual(request.requestedCapabilities, ['tool.invoke']);
      assert.deepEqual(request.requestedPublicTools, [
        'files.read',
        'files.list',
      ]);
      return acceptHandshake(request, ['tool.invoke']);
    },
    async invoke(request, context) {
      credentials.push(context.credential.value);
      assert.equal(request.publicTool, 'files.read');
      assert.deepEqual(request.input, {
        path: 'notes.txt',
        offset: 2,
        limit: 4,
      });
      return {
        ok: true,
        value: {
          kind: 'inline',
          value: {
            path: 'notes.txt',
            content: 'hello\n',
            versionToken: 'version-1',
            totalLines: 3,
            pageLimit: 4,
            startLine: 3,
            endLine: 3,
            hasMore: false,
            nextOffset: null,
            internalBinding: 'read_file',
            root: 'computer',
          },
        },
      };
    },
  };
  let credentialCount = 0;
  const client = createToolSdkClient({
    transport,
    projection: PROJECTION,
    credentialProvider: {
      async getCredential() {
        credentialCount += 1;
        return { scheme: 'Bearer', value: `credential-${credentialCount}` };
      },
    },
  });

  const connection = await client.connect();
  assert.equal(connection.ok, true);
  const result = await client.readFile({
    path: 'notes.txt',
    offset: 2,
    limit: 4,
  });

  assert.deepEqual(result, {
    ok: true,
    value: {
      path: 'notes.txt',
      content: 'hello\n',
      versionToken: 'version-1',
      totalLines: 3,
      pageLimit: 4,
      startLine: 3,
      endLine: 3,
      hasMore: false,
      nextOffset: null,
    },
  });
  assert.deepEqual(credentials, ['credential-1', 'credential-2']);
});

void test('typed listFiles shares the explicit transport and strips private result fields', async () => {
  const transport: ToolSdkTransport = {
    async handshake(request) {
      return acceptHandshake(request, ['tool.invoke']);
    },
    async invoke(request) {
      assert.equal(request.publicTool, 'files.list');
      assert.deepEqual(request.input, { path: '.', recursive: true });
      return {
        ok: true,
        value: {
          kind: 'inline',
          value: {
            path: '.',
            total: 2,
            entries: [
              { name: 'notes.txt', path: 'notes.txt', type: 'file' },
              { name: 'src', path: 'src', type: 'directory' },
            ],
            root: 'computer',
            internalBinding: 'list_files',
          },
        },
      };
    },
  };
  const client = createToolSdkClient({
    transport,
    projection: PROJECTION,
    credentialProvider: staticCredentialProvider(),
  });

  assert.equal((await client.connect()).ok, true);
  const result = await client.listFiles({ recursive: true });

  assert.deepEqual(result, {
    ok: true,
    value: {
      path: '.',
      total: 2,
      entries: [
        { name: 'notes.txt', path: 'notes.txt', type: 'file' },
        { name: 'src', path: 'src', type: 'directory' },
      ],
    },
  });
  assert.doesNotMatch(JSON.stringify(result), /root|list_files/u);
});

void test('listFiles rejects a malformed transport result instead of replaying a partial listing', async () => {
  const transport: ToolSdkTransport = {
    async handshake(request) {
      return acceptHandshake(request, ['tool.invoke']);
    },
    async invoke() {
      return {
        ok: true,
        value: {
          kind: 'inline',
          value: {
            path: '.',
            total: 2,
            entries: [{ name: 'notes.txt', path: 'notes.txt', type: 'file' }],
          },
        },
      };
    },
  };
  const client = createToolSdkClient({
    transport,
    projection: PROJECTION,
    credentialProvider: staticCredentialProvider(),
  });

  assert.equal((await client.connect()).ok, true);
  const result = await client.listFiles({});

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.code, 'invalid_transport_response');
  }
});

void test('offloaded output is recovered only through a negotiated transport capability', async () => {
  const credentials: string[] = [];
  const transport: ToolSdkTransport = {
    async handshake(request, context) {
      credentials.push(context.credential.value);
      return acceptHandshake(request, ['tool.invoke', 'tool-output.recover']);
    },
    async invoke(_request, context) {
      credentials.push(context.credential.value);
      return {
        ok: true,
        value: { kind: 'offloaded', outputRef: 'output:opaque-1' },
      };
    },
    async recoverOutput(request, context) {
      credentials.push(context.credential.value);
      assert.equal(request.outputRef, 'output:opaque-1');
      return {
        ok: true,
        value: {
          kind: 'inline',
          value: {
            path: 'large.txt',
            content: 'complete output\n',
            versionToken: 'version-2',
            totalLines: 1,
            pageLimit: 20,
            startLine: 1,
            endLine: 1,
            hasMore: false,
            nextOffset: null,
          },
        },
      };
    },
  };
  let credentialCount = 0;
  const client = createToolSdkClient({
    transport,
    projection: PROJECTION,
    credentialProvider: {
      async getCredential() {
        credentialCount += 1;
        return { scheme: 'Bearer', value: `credential-${credentialCount}` };
      },
    },
  });

  assert.equal((await client.connect()).ok, true);
  const result = await client.readFile({ path: 'large.txt', limit: 20 });

  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.value.content, 'complete output\n');
  }
  assert.deepEqual(credentials, [
    'credential-1',
    'credential-2',
    'credential-3',
  ]);
});

void test('missing authentication fails before the transport is called', async () => {
  let transportCalled = false;
  const transport: ToolSdkTransport = {
    async handshake() {
      transportCalled = true;
      throw new Error('must not run');
    },
    async invoke() {
      transportCalled = true;
      throw new Error('must not run');
    },
  };
  const client = createToolSdkClient({
    transport,
    projection: PROJECTION,
    credentialProvider: {
      async getCredential() {
        return undefined;
      },
    },
  });

  const result = await client.connect();

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.code, 'authentication_required');
  }
  assert.equal(transportCalled, false);
});

void test('a projection mismatch fails the handshake and leaves wrappers disconnected', async () => {
  const transport: ToolSdkTransport = {
    async handshake(request) {
      return {
        ok: true,
        value: {
          compatibility: {
            ...request.compatibility,
            projection: {
              ...request.compatibility.projection,
              sdkProjectionHash: `sha256:${'b'.repeat(64)}`,
            },
          },
          capabilities: ['tool.invoke'],
          publicTools: ['files.read'],
        },
      };
    },
    async invoke() {
      throw new Error('must not run');
    },
  };
  const client = createToolSdkClient({
    transport,
    projection: PROJECTION,
    credentialProvider: staticCredentialProvider(),
  });

  const connection = await client.connect();
  assert.equal(connection.ok, false);
  if (!connection.ok) {
    assert.equal(connection.error.code, 'projection_mismatch');
  }
  const invocation = await client.readFile({ path: 'notes.txt', limit: 10 });
  assert.equal(invocation.ok, false);
  if (!invocation.ok) {
    assert.equal(invocation.error.code, 'handshake_required');
  }
});

void test('a caller can negotiate one public wrapper without widening the connection', async () => {
  let invocationCount = 0;
  const transport: ToolSdkTransport = {
    async handshake(request) {
      assert.deepEqual(request.requestedPublicTools, ['files.read']);
      return acceptHandshake(request, ['tool.invoke']);
    },
    async invoke() {
      invocationCount += 1;
      throw new Error('must not run');
    },
  };
  const client = createToolSdkClient({
    transport,
    projection: PROJECTION,
    credentialProvider: staticCredentialProvider(),
    requestedPublicTools: ['files.read'],
  });

  assert.equal((await client.connect()).ok, true);
  const result = await client.listFiles({});

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.code, 'tool_not_admitted');
  }
  assert.equal(invocationCount, 0);
});

void test('duplicate requested public tools fail before credentials or transport are used', async () => {
  let boundaryCalled = false;
  const client = createToolSdkClient({
    projection: PROJECTION,
    requestedPublicTools: ['files.read', 'files.read'],
    transport: {
      async handshake() {
        boundaryCalled = true;
        throw new Error('must not run');
      },
      async invoke() {
        boundaryCalled = true;
        throw new Error('must not run');
      },
    },
    credentialProvider: {
      async getCredential() {
        boundaryCalled = true;
        return { scheme: 'Bearer', value: 'must-not-run' };
      },
    },
  });

  const result = await client.connect();

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.code, 'invalid_arguments');
  }
  assert.equal(boundaryCalled, false);
});

void test('a runtime compatibility range mismatch fails as an incompatible transport', async () => {
  const transport: ToolSdkTransport = {
    async handshake(request) {
      return {
        ok: true,
        value: {
          compatibility: {
            ...request.compatibility,
            runtimeCompatibility: {
              versionAxis: 'transportProtocolVersion',
              range: '2.x',
            },
          },
          capabilities: ['tool.invoke'],
          publicTools: ['files.read'],
        },
      };
    },
    async invoke() {
      throw new Error('must not run');
    },
  };
  const client = createToolSdkClient({
    transport,
    projection: PROJECTION,
    credentialProvider: staticCredentialProvider(),
  });

  const connection = await client.connect();

  assert.equal(connection.ok, false);
  if (!connection.ok) {
    assert.equal(connection.error.code, 'incompatible_transport');
  }
});

void test('an aborted call fails as cancelled without acquiring a credential', async () => {
  let credentialCalled = false;
  const controller = new AbortController();
  controller.abort();
  const client = createToolSdkClient({
    projection: PROJECTION,
    transport: {
      async handshake() {
        throw new Error('must not run');
      },
      async invoke() {
        throw new Error('must not run');
      },
    },
    credentialProvider: {
      async getCredential() {
        credentialCalled = true;
        return { scheme: 'Bearer', value: 'secret' };
      },
    },
  });

  const result = await client.connect({ signal: controller.signal });

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.code, 'cancelled');
  }
  assert.equal(credentialCalled, false);
});

function acceptHandshake(
  request: ToolSdkHandshakeRequest,
  capabilities: ('tool.invoke' | 'tool-output.recover')[],
) {
  return {
    ok: true as const,
    value: {
      compatibility: request.compatibility,
      capabilities,
      publicTools: [...request.requestedPublicTools],
    },
  };
}

function staticCredentialProvider() {
  return {
    async getCredential() {
      return { scheme: 'Bearer', value: 'credential' };
    },
  };
}
