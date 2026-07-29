import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import { createDaemonToolSdkEmbeddingHost } from '@geulbat/daemon/tool-sdk-host';
import { TOOL_SDK_RELEASE, createToolSdkClient } from '@geulbat/tool-sdk';

const temporaryRoot = await mkdtemp(
  path.join(tmpdir(), 'geulbat-external-tool-sdk-consumer-'),
);
const stateRoot = path.join(temporaryRoot, 'state');
const computerFileRoot = path.join(temporaryRoot, 'computer');
await mkdir(stateRoot, { recursive: true });
await mkdir(computerFileRoot, { recursive: true });
await writeFile(
  path.join(computerFileRoot, 'consumer.txt'),
  'external daemon consumer\n',
  'utf8',
);
await Promise.all(
  Array.from({ length: 48 }, (_, index) =>
    writeFile(
      path.join(
        computerFileRoot,
        `${String(index).padStart(3, '0')}-${'x'.repeat(170)}.txt`,
      ),
      '',
      'utf8',
    ),
  ),
);

const projection = {
  schemaVersion: TOOL_SDK_RELEASE.projectionSchemaVersion,
  sdkProjectionHash: `sha256:${'a'.repeat(64)}`,
  policyId: 'external-daemon-consumer-v1',
};
const credentialPrefix = randomUUID();
const authenticatedCredentials = [];
let credentialCount = 0;
let invocationAuthorizationCount = 0;
let recoveryAuthorizationCount = 0;
let callCount = 0;
let denyRecovery = false;
let markCancellationStarted = () => undefined;
const cancellationStarted = new Promise((resolve) => {
  markCancellationStarted = resolve;
});
const host = createDaemonToolSdkEmbeddingHost({
  stateRoot,
  computerFileRoot,
  computerSessionId: randomUUID(),
  getProjectionIdentity: () => projection,
  authority: {
    async authenticate(credential) {
      authenticatedCredentials.push(credential.value);
      return credential.value.startsWith(`${credentialPrefix}:`)
        ? { ok: true, principal: { subject: 'release-consumer' } }
        : { ok: false, code: 'authentication_invalid' };
    },
    async authorizeInvocation(options) {
      assert.equal(options.principal.subject, 'release-consumer');
      invocationAuthorizationCount += 1;
      if (options.input.path === 'denied.txt') {
        return { ok: false, code: 'tool_not_admitted' };
      }
      if (options.input.path === 'cancel.txt') {
        assert.ok(options.signal);
        markCancellationStarted();
        if (!options.signal.aborted) {
          await new Promise((resolve) => {
            options.signal.addEventListener('abort', resolve, { once: true });
          });
        }
      }
      callCount += 1;
      return {
        ok: true,
        scope: {
          callId: `external-consumer-call-${callCount}`,
          runId: 'external-consumer-run',
          threadId: '11111111-1111-4111-8111-111111111111',
          workingDirectory: '',
        },
      };
    },
    async authorizeOutputRecovery(options) {
      assert.equal(options.principal.subject, 'release-consumer');
      assert.equal(options.projection.policyId, projection.policyId);
      assert.match(options.outputRef, /^tool-output:/u);
      recoveryAuthorizationCount += 1;
      if (denyRecovery) {
        return { ok: false, code: 'tool_not_admitted' };
      }
      return {
        ok: true,
        scope: {
          callId: 'external-consumer-recovery',
          runId: 'external-consumer-run',
          threadId: '11111111-1111-4111-8111-111111111111',
          workingDirectory: '',
        },
      };
    },
  },
});

try {
  const issueCredential = () => {
    credentialCount += 1;
    return {
      scheme: 'Bearer',
      value: `${credentialPrefix}:${credentialCount}`,
    };
  };
  const client = createToolSdkClient({
    transport: host.transport,
    projection,
    requestedPublicTools: ['files.read', 'files.list', 'files.search'],
    credentialProvider: {
      async getCredential() {
        return issueCredential();
      },
    },
  });
  const connection = await client.connect();
  assert.equal(connection.ok, true);
  if (connection.ok) {
    assert.deepEqual(connection.value.capabilities, [
      'tool.invoke',
      'tool-output.recover',
    ]);
  }

  const readResult = await client.readFile({
    path: 'consumer.txt',
    limit: 1,
  });
  assert.equal(readResult.ok, true);
  if (readResult.ok) {
    assert.equal(readResult.value.content, 'external daemon consumer\n');
  }

  const searchResult = await client.searchFiles({
    path: '.',
    pattern: 'external daemon consumer',
    type: 'content',
    maxResults: 5,
  });
  assert.equal(searchResult.ok, true);
  if (searchResult.ok) {
    assert.equal(searchResult.value.results[0]?.path, 'consumer.txt');
  }

  const deniedInvocation = await client.readFile({
    path: 'denied.txt',
    limit: 1,
  });
  assert.equal(deniedInvocation.ok, false);
  if (!deniedInvocation.ok) {
    assert.equal(deniedInvocation.error.code, 'tool_not_admitted');
  }

  denyRecovery = true;
  const deniedRecovery = await client.listFiles({
    path: '.',
    recursive: false,
  });
  assert.equal(deniedRecovery.ok, false);
  if (!deniedRecovery.ok) {
    assert.equal(deniedRecovery.error.code, 'tool_not_admitted');
  }
  denyRecovery = false;

  const listResult = await client.listFiles({
    path: '.',
    recursive: false,
  });
  assert.equal(listResult.ok, true);
  if (listResult.ok) {
    assert.equal(listResult.value.total, 49);
    assert.equal(listResult.value.entries.length, 49);
  }
  assert.equal(recoveryAuthorizationCount, 2);

  const reconnected = await client.connect();
  assert.equal(reconnected.ok, true);

  const cancellation = new AbortController();
  const pendingCancellation = client.readFile(
    { path: 'cancel.txt', limit: 1 },
    { signal: cancellation.signal },
  );
  await cancellationStarted;
  cancellation.abort();
  const cancelledResult = await pendingCancellation;
  assert.equal(cancelledResult.ok, false);
  if (!cancelledResult.ok) {
    assert.equal(cancelledResult.error.code, 'cancelled');
  }

  const compatibility = {
    packageVersion: TOOL_SDK_RELEASE.packageVersion,
    apiVersion: TOOL_SDK_RELEASE.apiVersion,
    transportProtocolVersion: TOOL_SDK_RELEASE.transportProtocolVersion,
    runtimeCompatibility: { ...TOOL_SDK_RELEASE.runtimeCompatibility },
    projection,
  };
  const handshakeRequest = {
    compatibility,
    requestedCapabilities: ['tool.invoke', 'tool-output.recover'],
    requestedPublicTools: ['files.read', 'files.list', 'files.search'],
  };
  const invalidAuthentication = await host.transport.handshake(
    handshakeRequest,
    {
      credential: { scheme: 'Bearer', value: `invalid:${randomUUID()}` },
    },
  );
  assert.equal(invalidAuthentication.ok, false);
  if (!invalidAuthentication.ok) {
    assert.equal(invalidAuthentication.error.code, 'authentication_invalid');
  }
  const incompatibleTransport = await host.transport.handshake(
    {
      ...handshakeRequest,
      compatibility: {
        ...compatibility,
        transportProtocolVersion: '999.0.0',
      },
    },
    { credential: issueCredential() },
  );
  assert.equal(incompatibleTransport.ok, false);
  if (!incompatibleTransport.ok) {
    assert.equal(incompatibleTransport.error.code, 'incompatible_transport');
  }
  const projectionMismatch = await host.transport.handshake(
    {
      ...handshakeRequest,
      compatibility: {
        ...compatibility,
        projection: {
          ...projection,
          sdkProjectionHash: `sha256:${'b'.repeat(64)}`,
        },
      },
    },
    { credential: issueCredential() },
  );
  assert.equal(projectionMismatch.ok, false);
  if (!projectionMismatch.ok) {
    assert.equal(projectionMismatch.error.code, 'projection_mismatch');
  }

  const serializedFailures = JSON.stringify([
    invalidAuthentication,
    incompatibleTransport,
    projectionMismatch,
    deniedInvocation,
    deniedRecovery,
  ]);
  assert.equal(serializedFailures.includes(credentialPrefix), false);
  assert.equal(serializedFailures.includes(computerFileRoot), false);
  assert.equal(serializedFailures.includes(stateRoot), false);

  assert.equal(invocationAuthorizationCount, 6);
  assert.equal(credentialCount, 12);
  assert.equal(authenticatedCredentials.length, 13);
  assert.equal(new Set(authenticatedCredentials).size, 13);
} finally {
  await host.close();
  await rm(temporaryRoot, { recursive: true, force: true });
}
