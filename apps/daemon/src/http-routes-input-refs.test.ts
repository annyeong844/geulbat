import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';
import {
  isInputRefInventoryResponse,
  isInputRefRecoveryResponse,
} from '@geulbat/protocol/input-refs';

import { DEFAULT_PROJECT_ID } from './daemon/files/project-registry-state.js';
import { writeFileBinaryInputRefFromStream } from './daemon/files/binary-input-ref-store.js';
import { writeArtifactRuntimePersistenceStateInputRefFromStream } from './daemon/artifact-runtime-persistence/input-ref-store.js';
import { writeReactBundleInlineCompileInputRefFromStream } from './daemon/react-bundle-inline/input-ref-store.js';
import {
  deleteRunPromptInputRefPath,
  readRunPromptInputRef,
  writeRunPromptInputRefFromStream,
} from './daemon/sessions/prompt-input-ref-store.js';
import {
  authHeaders,
  createRouteTestDaemonContext,
  getWorkspaceRootFromContext,
  withAuthenticatedDaemonServer,
} from './test-support/http-routes.js';

void test('input ref inventory exposes pending and active claimed states', async () => {
  const daemonContext = createRouteTestDaemonContext();
  const workspaceRoot = getWorkspaceRootFromContext(daemonContext);

  await withAuthenticatedDaemonServer(
    async ({ port }) => {
      const uploadedResponse = await fetch(
        `http://127.0.0.1:${port}/api/run/prompt-inputs?projectId=${DEFAULT_PROJECT_ID}`,
        {
          method: 'POST',
          headers: authHeaders({ 'Content-Type': 'text/plain;charset=UTF-8' }),
          body: 'inventory prompt',
        },
      );
      const uploaded = (await uploadedResponse.json()) as {
        promptRef: string;
      };

      const pendingResponse = await fetch(
        `http://127.0.0.1:${port}/api/input-refs?projectId=${DEFAULT_PROJECT_ID}`,
        { headers: authHeaders() },
      );
      const pending = await pendingResponse.json();
      assert.equal(isInputRefInventoryResponse(pending), true);
      if (!isInputRefInventoryResponse(pending)) {
        assert.fail('expected a valid input ref inventory response');
      }
      assert.equal(pending.entries.length, 1);
      assert.equal(pending.entries[0]?.ref, uploaded.promptRef);
      assert.equal(pending.entries[0]?.state, 'pending');

      const claimed = await readRunPromptInputRef({
        workspaceRoot,
        promptRef: uploaded.promptRef,
      });
      assert.equal(claimed.ok, true);
      if (!claimed.ok) {
        assert.fail('expected prompt ref claim to succeed');
      }
      try {
        const claimedResponse = await fetch(
          `http://127.0.0.1:${port}/api/input-refs?projectId=${DEFAULT_PROJECT_ID}`,
          { headers: authHeaders() },
        );
        const claimedInventory = await claimedResponse.json();
        assert.equal(isInputRefInventoryResponse(claimedInventory), true);
        if (!isInputRefInventoryResponse(claimedInventory)) {
          assert.fail('expected a valid claimed inventory response');
        }
        const entry = claimedInventory.entries[0];
        assert.equal(entry?.state, 'claimed');
        assert.equal(typeof entry?.claimId, 'string');

        const releaseResponse = await fetch(
          `http://127.0.0.1:${port}/api/input-refs/recovery`,
          {
            method: 'POST',
            headers: authHeaders({ 'Content-Type': 'application/json' }),
            body: JSON.stringify({
              projectId: DEFAULT_PROJECT_ID,
              ref: uploaded.promptRef,
              action: 'release',
              claimId: entry?.claimId,
            }),
          },
        );
        assert.equal(releaseResponse.status, 409);
        const releaseError = (await releaseResponse.json()) as {
          code: string;
        };
        assert.equal(releaseError.code, 'conflict');
      } finally {
        await deleteRunPromptInputRefPath(claimed.path);
      }
    },
    { daemonContext },
  );
});

void test('input ref recovery retries and releases a persisted interrupted claim', async (t) => {
  const daemonContext = createRouteTestDaemonContext();
  const workspaceRoot = getWorkspaceRootFromContext(daemonContext);
  const directory = join(workspaceRoot, '.geulbat', 'run-prompt-inputs');
  t.after(() => rm(directory, { recursive: true, force: true }));
  const id = randomUUID();
  const claimId = randomUUID();
  const promptRef = `run-prompt-input:${id}`;
  await mkdir(directory, { recursive: true });
  await writeFile(
    join(directory, `${id}.${claimId}.claimed.txt`),
    'interrupted prompt',
    'utf8',
  );

  await withAuthenticatedDaemonServer(
    async ({ port }) => {
      const inventoryResponse = await fetch(
        `http://127.0.0.1:${port}/api/input-refs?projectId=${DEFAULT_PROJECT_ID}`,
        { headers: authHeaders() },
      );
      const inventory = await inventoryResponse.json();
      assert.equal(isInputRefInventoryResponse(inventory), true);
      if (!isInputRefInventoryResponse(inventory)) {
        assert.fail('expected a valid interrupted inventory response');
      }
      assert.equal(inventory.entries[0]?.state, 'interrupted');
      assert.equal(inventory.entries[0]?.claimId, claimId);

      const invalidClaimResponse = await fetch(
        `http://127.0.0.1:${port}/api/input-refs/recovery`,
        {
          method: 'POST',
          headers: authHeaders({ 'Content-Type': 'application/json' }),
          body: JSON.stringify({
            projectId: DEFAULT_PROJECT_ID,
            ref: promptRef,
            action: 'retry',
            claimId: 'not-a-claim-id',
          }),
        },
      );
      assert.equal(invalidClaimResponse.status, 400);
      const invalidClaim = (await invalidClaimResponse.json()) as {
        code: string;
      };
      assert.equal(invalidClaim.code, 'bad_request');

      const retryResponse = await fetch(
        `http://127.0.0.1:${port}/api/input-refs/recovery`,
        {
          method: 'POST',
          headers: authHeaders({ 'Content-Type': 'application/json' }),
          body: JSON.stringify({
            projectId: DEFAULT_PROJECT_ID,
            ref: promptRef,
            action: 'retry',
            claimId,
          }),
        },
      );
      const retry = await retryResponse.json();
      assert.equal(isInputRefRecoveryResponse(retry), true);
      assert.deepEqual(retry, { ok: true, disposition: 'pending' });

      const releaseResponse = await fetch(
        `http://127.0.0.1:${port}/api/input-refs/recovery`,
        {
          method: 'POST',
          headers: authHeaders({ 'Content-Type': 'application/json' }),
          body: JSON.stringify({
            projectId: DEFAULT_PROJECT_ID,
            ref: promptRef,
            action: 'release',
          }),
        },
      );
      const released = await releaseResponse.json();
      assert.equal(isInputRefRecoveryResponse(released), true);
      assert.deepEqual(released, { ok: true, disposition: 'released' });

      const emptyResponse = await fetch(
        `http://127.0.0.1:${port}/api/input-refs?projectId=${DEFAULT_PROJECT_ID}`,
        { headers: authHeaders() },
      );
      const empty = await emptyResponse.json();
      assert.equal(isInputRefInventoryResponse(empty), true);
      if (!isInputRefInventoryResponse(empty)) {
        assert.fail('expected a valid empty inventory response');
      }
      assert.deepEqual(empty.entries, []);
      assert.equal(empty.totalByteLength, 0);
    },
    { daemonContext },
  );
});

void test('input ref inventory aggregates every current streamed input family', async () => {
  const daemonContext = createRouteTestDaemonContext();
  const workspaceRoot = getWorkspaceRootFromContext(daemonContext);
  const [prompt, binary, state, inlineCompile] = await Promise.all([
    writeRunPromptInputRefFromStream({
      workspaceRoot,
      input: Readable.from(['prompt']),
    }),
    writeFileBinaryInputRefFromStream({
      workspaceRoot,
      input: Readable.from([Buffer.from([0, 1, 2])]),
    }),
    writeArtifactRuntimePersistenceStateInputRefFromStream({
      workspaceRoot,
      input: Readable.from(['{"saved":true}']),
    }),
    writeReactBundleInlineCompileInputRefFromStream({
      workspaceRoot,
      input: Readable.from(['{"files":[]}']),
    }),
  ]);
  const refs = [
    prompt.promptRef,
    binary.contentRef,
    state.stateRef,
    inlineCompile.inputRef,
  ];

  await withAuthenticatedDaemonServer(
    async ({ port }) => {
      const response = await fetch(
        `http://127.0.0.1:${port}/api/input-refs?projectId=${DEFAULT_PROJECT_ID}`,
        { headers: authHeaders() },
      );
      const inventory = await response.json();
      assert.equal(isInputRefInventoryResponse(inventory), true);
      if (!isInputRefInventoryResponse(inventory)) {
        assert.fail('expected a valid aggregated inventory response');
      }
      assert.deepEqual(
        new Set(inventory.entries.map((entry) => entry.kind)),
        new Set([
          'run_prompt',
          'file_binary',
          'artifact_runtime_state',
          'react_bundle_inline_compile',
        ]),
      );
      assert.deepEqual(
        new Set(inventory.entries.map((entry) => entry.ref)),
        new Set(refs),
      );

      for (const ref of refs) {
        const releaseResponse = await fetch(
          `http://127.0.0.1:${port}/api/input-refs/recovery`,
          {
            method: 'POST',
            headers: authHeaders({ 'Content-Type': 'application/json' }),
            body: JSON.stringify({
              projectId: DEFAULT_PROJECT_ID,
              ref,
              action: 'release',
            }),
          },
        );
        assert.equal(releaseResponse.status, 200);
      }
    },
    { daemonContext },
  );
});
