import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { assertThreadId } from '@geulbat/protocol/ids';
import {
  TOOL_SDK_RELEASE,
  createToolSdkClient,
  type ToolSdkCompatibility,
  type ToolSdkProjectionIdentity,
} from '@geulbat/tool-sdk';

import { createDaemonContext } from '../context.js';
import {
  buildToolOutputRef,
  buildToolOutputSnapshot,
  readToolOutputSnapshot,
  writeToolOutputSnapshot,
} from '../files/tool-output-store.js';
import { listFilesTool } from './builtin/list-files.js';
import { createDaemonToolSdkTransport } from './external-tool-sdk-transport.js';
import { createToolRegistryStore } from './registry.js';

const PROJECTION: ToolSdkProjectionIdentity = {
  schemaVersion: TOOL_SDK_RELEASE.projectionSchemaVersion,
  sdkProjectionHash: `sha256:${'e'.repeat(64)}`,
  policyId: 'external-read-v1',
};

const COMPATIBILITY: ToolSdkCompatibility = {
  packageVersion: TOOL_SDK_RELEASE.packageVersion,
  apiVersion: TOOL_SDK_RELEASE.apiVersion,
  transportProtocolVersion: TOOL_SDK_RELEASE.transportProtocolVersion,
  runtimeCompatibility: { ...TOOL_SDK_RELEASE.runtimeCompatibility },
  projection: PROJECTION,
};

const THREAD_ID = assertThreadId('11111111-1111-4111-8111-111111111111');
const OTHER_THREAD_ID = assertThreadId('22222222-2222-4222-8222-222222222222');

void test('daemon SDK offloads a real large list result and recovers its public DTO with fresh authority', async (t) => {
  const temporaryRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-external-tool-sdk-recovery-'),
  );
  t.after(() => rm(temporaryRoot, { recursive: true, force: true }));
  const stateRoot = join(temporaryRoot, 'state');
  const computerFileRoot = join(temporaryRoot, 'computer');
  await mkdir(stateRoot, { recursive: true });
  await mkdir(computerFileRoot, { recursive: true });

  const fileNames: string[] = [];
  for (let index = 0; index < 160; index += 1) {
    const fileName = `${String(index).padStart(3, '0')}-${'x'.repeat(170)}.txt`;
    fileNames.push(fileName);
    await writeFile(join(computerFileRoot, fileName), '', 'utf8');
  }

  const runId = 'external-sdk-run';
  const callId = 'external-sdk-list-call';
  const authenticatedCredentials: string[] = [];
  let credentialCount = 0;
  let invocationAuthorizationCount = 0;
  let recoveryAuthorizationCount = 0;
  let recoveredOutputRef = '';
  const daemonContext = createDaemonContext({ homeStateRoot: stateRoot });
  const transport = daemonContext.createExternalToolSdkTransport({
    getProjectionIdentity: () => PROJECTION,
    authority: {
      async authenticate(credential) {
        authenticatedCredentials.push(credential.value);
        return { ok: true as const, principal: { subject: 'consumer-1' } };
      },
      async authorizeInvocation(options) {
        invocationAuthorizationCount += 1;
        assert.equal(options.principal.subject, 'consumer-1');
        assert.equal(options.publicTool, 'files.list');
        return {
          ok: true as const,
          context: {
            callId,
            computerFileRoot,
            runId,
            stateRoot,
            threadId: THREAD_ID,
          },
        };
      },
      async authorizeOutputRecovery(options) {
        recoveryAuthorizationCount += 1;
        recoveredOutputRef = options.outputRef;
        assert.equal(options.principal.subject, 'consumer-1');
        assert.deepEqual(options.projection, PROJECTION);
        return {
          ok: true as const,
          context: {
            callId: 'external-sdk-recovery-call',
            stateRoot,
            threadId: THREAD_ID,
          },
        };
      },
    },
  });
  const client = createToolSdkClient({
    transport,
    projection: PROJECTION,
    requestedPublicTools: ['files.list'],
    credentialProvider: {
      async getCredential() {
        credentialCount += 1;
        return { scheme: 'Bearer', value: `credential-${credentialCount}` };
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

  const result = await client.listFiles({ path: '.' });

  assert.equal(result.ok, true);
  if (!result.ok) {
    return;
  }
  assert.equal(result.value.path, '.');
  assert.equal(result.value.total, fileNames.length);
  assert.equal(result.value.entries.length, fileNames.length);
  assert.deepEqual(
    result.value.entries.map((entry) => entry.name),
    fileNames,
  );
  assert.deepEqual(authenticatedCredentials, [
    'credential-1',
    'credential-2',
    'credential-3',
  ]);
  assert.equal(invocationAuthorizationCount, 1);
  assert.equal(recoveryAuthorizationCount, 1);

  const outputRef = buildToolOutputRef({
    threadId: THREAD_ID,
    runId,
    callId,
  });
  assert.equal(recoveredOutputRef, outputRef);
  const snapshot = await readToolOutputSnapshot({
    stateRoot,
    threadId: THREAD_ID,
    outputRef,
  });
  assert.equal(snapshot.ok, true);
  if (!snapshot.ok) {
    return;
  }
  assert.equal(snapshot.value.toolName, 'list_files');
  assert.deepEqual(JSON.parse(snapshot.value.output), result.value);
  assert.doesNotMatch(
    JSON.stringify({ result, snapshot: snapshot.value.output }),
    /computerFileRoot|tool_library_projection|"root"/u,
  );
});

void test('daemon SDK recovery does not reveal whether an output ref belongs to another thread', async (t) => {
  const stateRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-external-tool-sdk-scope-'),
  );
  t.after(() => rm(stateRoot, { recursive: true, force: true }));
  const foreignOutputRef = buildToolOutputRef({
    threadId: OTHER_THREAD_ID,
    runId: 'foreign-run',
    callId: 'foreign-call',
  });
  await writeToolOutputSnapshot({
    stateRoot,
    snapshot: buildToolOutputSnapshot({
      outputRef: foreignOutputRef,
      threadId: OTHER_THREAD_ID,
      runId: 'foreign-run',
      callId: 'foreign-call',
      toolName: 'list_files',
      output: JSON.stringify({
        path: '.',
        total: 1,
        entries: [{ name: 'secret.txt', path: 'secret.txt', type: 'file' }],
      }),
    }),
  });
  const missingOutputRef = buildToolOutputRef({
    threadId: THREAD_ID,
    runId: 'missing-run',
    callId: 'missing-call',
  });
  let recoveryAuthorizationCount = 0;
  const transport = createDaemonToolSdkTransport({
    registry: createToolRegistryStore({ builtins: [listFilesTool] }),
    getProjectionIdentity: () => PROJECTION,
    authority: {
      async authenticate() {
        return { ok: true as const, principal: 'consumer-1' };
      },
      async authorizeInvocation() {
        assert.fail('invocation authorization must not run');
      },
      async authorizeOutputRecovery() {
        recoveryAuthorizationCount += 1;
        return {
          ok: true as const,
          context: {
            callId: `recovery-${recoveryAuthorizationCount}`,
            stateRoot,
            threadId: THREAD_ID,
          },
        };
      },
    },
  });
  const recoverOutput = transport.recoverOutput;
  assert.notEqual(recoverOutput, undefined);
  if (recoverOutput === undefined) {
    return;
  }

  const foreignResult = await recoverOutput(
    { compatibility: COMPATIBILITY, outputRef: foreignOutputRef },
    { credential: validCredential() },
  );
  const missingResult = await recoverOutput(
    { compatibility: COMPATIBILITY, outputRef: missingOutputRef },
    { credential: validCredential() },
  );

  assert.equal(foreignResult.ok, false);
  assert.equal(missingResult.ok, false);
  if (!foreignResult.ok && !missingResult.ok) {
    assert.deepEqual(foreignResult.error, missingResult.error);
    assert.equal(foreignResult.error.code, 'tool_failed');
    assert.doesNotMatch(JSON.stringify(foreignResult), /secret\.txt/u);
  }
  assert.equal(recoveryAuthorizationCount, 2);
});

void test('daemon SDK rejects projection drift before output recovery authorization', async () => {
  let currentProjection = PROJECTION;
  let recoveryAuthorizationCount = 0;
  const transport = createDaemonToolSdkTransport({
    registry: createToolRegistryStore({ builtins: [listFilesTool] }),
    getProjectionIdentity: () => currentProjection,
    authority: {
      async authenticate() {
        return { ok: true as const, principal: 'consumer-1' };
      },
      async authorizeInvocation() {
        assert.fail('invocation authorization must not run');
      },
      async authorizeOutputRecovery() {
        recoveryAuthorizationCount += 1;
        return { ok: false as const, code: 'tool_not_admitted' as const };
      },
    },
  });
  const recoverOutput = transport.recoverOutput;
  assert.notEqual(recoverOutput, undefined);
  if (recoverOutput === undefined) {
    return;
  }
  currentProjection = {
    ...PROJECTION,
    sdkProjectionHash: `sha256:${'f'.repeat(64)}`,
  };

  const result = await recoverOutput(
    {
      compatibility: COMPATIBILITY,
      outputRef: buildToolOutputRef({
        threadId: THREAD_ID,
        runId: 'stale-run',
        callId: 'stale-call',
      }),
    },
    { credential: validCredential() },
  );

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.code, 'projection_mismatch');
  }
  assert.equal(recoveryAuthorizationCount, 0);
});

function validCredential() {
  return { scheme: 'Bearer' as const, value: 'valid-credential' };
}
