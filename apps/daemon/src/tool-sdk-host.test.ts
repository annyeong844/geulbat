import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { TOOL_SDK_RELEASE, createToolSdkClient } from '@geulbat/tool-sdk';

import { createDaemonToolSdkEmbeddingHost } from './daemon/tools/external-tool-sdk-host.js';
import { createSymlinkOrSkip } from './test-support/symlink-test.js';

const PROJECTION = {
  schemaVersion: TOOL_SDK_RELEASE.projectionSchemaVersion,
  sdkProjectionHash: `sha256:${'f'.repeat(64)}`,
  policyId: 'external-consumer-test-v1',
} as const;

void test('external embedding host rejects a missing computer file root', () => {
  assert.throws(
    () =>
      createDaemonToolSdkEmbeddingHost({
        stateRoot: '/state',
        computerFileRoot: ' ',
        computerSessionId: 'external-consumer-invalid-root-test',
        getProjectionIdentity: () => PROJECTION,
        authority: {
          async authenticate() {
            return { ok: true as const, principal: { subject: 'consumer' } };
          },
          async authorizeInvocation() {
            throw new Error('invalid roots must fail before authorization');
          },
        },
      }),
    /requires an explicit computer file root/,
  );
});

void test('external embedding host binds the real daemon file root and cancels after admission', async (t) => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), 'geulbat-tool-sdk-host-'));
  t.after(() => rm(temporaryRoot, { recursive: true, force: true }));
  const stateRoot = join(temporaryRoot, 'state');
  const computerFileRoot = join(temporaryRoot, 'computer');
  await mkdir(stateRoot, { recursive: true });
  await mkdir(computerFileRoot, { recursive: true });
  await writeFile(
    join(computerFileRoot, 'consumer.txt'),
    'external consumer\n',
    'utf8',
  );

  let markCancellationStarted: () => void = () => undefined;
  const cancellationStarted = new Promise<void>((resolve) => {
    markCancellationStarted = resolve;
  });
  const host = createDaemonToolSdkEmbeddingHost({
    stateRoot,
    computerFileRoot,
    computerSessionId: 'external-consumer-test',
    getProjectionIdentity: () => PROJECTION,
    authority: {
      async authenticate(credential) {
        return credential.value === 'consumer-credential'
          ? { ok: true as const, principal: { subject: 'consumer' } }
          : {
              ok: false as const,
              code: 'authentication_invalid' as const,
            };
      },
      async authorizeInvocation(options) {
        assert.equal(options.principal.subject, 'consumer');
        if (options.input['path'] === 'cancel.txt') {
          if (options.signal === undefined) {
            throw new Error('cancellation call did not carry an AbortSignal');
          }
          markCancellationStarted();
          if (!options.signal.aborted) {
            await new Promise<void>((resolve) => {
              options.signal?.addEventListener('abort', () => resolve(), {
                once: true,
              });
            });
          }
        }
        return {
          ok: true as const,
          scope: {
            callId: `external-${options.publicTool}`,
            runId: 'external-consumer-run',
            threadId: '11111111-1111-4111-8111-111111111111',
            workingDirectory: '',
          },
        };
      },
    },
  });
  t.after(() => host.close());
  const client = createToolSdkClient({
    transport: host.transport,
    projection: PROJECTION,
    requestedPublicTools: ['files.read'],
    credentialProvider: {
      async getCredential() {
        return { scheme: 'Bearer', value: 'consumer-credential' };
      },
    },
  });

  assert.equal((await client.connect()).ok, true);
  const readResult = await client.readFile({
    path: 'consumer.txt',
    limit: 1,
  });
  assert.equal(readResult.ok, true);
  if (readResult.ok) {
    assert.equal(readResult.value.content, 'external consumer\n');
  }

  const cancellation = new AbortController();
  const pendingCancellation = client.readFile(
    { path: 'cancel.txt', limit: 1 },
    { signal: cancellation.signal },
  );
  await cancellationStarted;
  cancellation.abort();
  const cancelled = await pendingCancellation;
  assert.equal(cancelled.ok, false);
  if (!cancelled.ok) {
    assert.equal(cancelled.error.code, 'cancelled');
  }
});

void test('external embedding host keeps search results relative to a canonical aliased root', async (t) => {
  const temporaryRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-tool-sdk-host-alias-'),
  );
  t.after(() => rm(temporaryRoot, { recursive: true, force: true }));
  const stateRoot = join(temporaryRoot, 'state');
  const canonicalComputerRoot = join(temporaryRoot, 'computer-canonical');
  const aliasedComputerRoot = join(temporaryRoot, 'computer-alias');
  await mkdir(stateRoot, { recursive: true });
  await mkdir(canonicalComputerRoot, { recursive: true });
  await writeFile(
    join(canonicalComputerRoot, 'consumer.txt'),
    'canonical alias consumer\n',
    'utf8',
  );
  if (
    !(await createSymlinkOrSkip(t, canonicalComputerRoot, aliasedComputerRoot))
  ) {
    return;
  }

  const host = createDaemonToolSdkEmbeddingHost({
    stateRoot,
    computerFileRoot: aliasedComputerRoot,
    computerSessionId: 'external-consumer-alias-test',
    getProjectionIdentity: () => PROJECTION,
    authority: {
      async authenticate() {
        return { ok: true as const, principal: { subject: 'consumer' } };
      },
      async authorizeInvocation() {
        return {
          ok: true as const,
          scope: {
            callId: 'external-files.search',
            runId: 'external-consumer-run',
            threadId: '11111111-1111-4111-8111-111111111111',
            workingDirectory: '',
          },
        };
      },
    },
  });
  t.after(() => host.close());
  const client = createToolSdkClient({
    transport: host.transport,
    projection: PROJECTION,
    requestedPublicTools: ['files.search'],
    credentialProvider: {
      async getCredential() {
        return { scheme: 'Bearer', value: 'consumer-credential' };
      },
    },
  });

  assert.equal((await client.connect()).ok, true);
  const searchResult = await client.searchFiles({
    path: '.',
    pattern: 'canonical alias consumer',
    type: 'content',
    maxResults: 5,
  });
  assert.equal(searchResult.ok, true);
  if (searchResult.ok) {
    assert.equal(searchResult.value.results[0]?.path, 'consumer.txt');
  }

  const filenameResult = await client.searchFiles({
    path: '.',
    pattern: 'consumer.txt',
    type: 'filename',
    maxResults: 5,
  });
  assert.equal(filenameResult.ok, true);
  if (filenameResult.ok) {
    assert.equal(filenameResult.value.results[0]?.path, 'consumer.txt');
  }
});
