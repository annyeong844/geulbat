import test from 'node:test';
import assert from 'node:assert/strict';

import { DEFAULT_PROJECT_ID } from './daemon/files/project-registry-state.js';
import {
  authHeaders,
  createRouteTestDaemonContext,
  getWorkspaceRootFromContext,
  withAuthenticatedDaemonServer,
} from './test-support/http-routes.js';
import { readRunPromptInputRef } from './daemon/sessions/prompt-input-ref-store.js';

void test('authenticated run prompt input route stores streamed prompt refs', async () => {
  const daemonContext = createRouteTestDaemonContext();
  await withAuthenticatedDaemonServer(
    async ({ port }) => {
      const res = await fetch(
        `http://127.0.0.1:${port}/api/run/prompt-inputs?projectId=${DEFAULT_PROJECT_ID}`,
        {
          method: 'POST',
          headers: authHeaders({
            'Content-Type': 'text/plain;charset=UTF-8',
          }),
          body: 'stored prompt',
        },
      );

      assert.equal(res.status, 201);
      const body = (await res.json()) as {
        ok: true;
        promptRef: string;
        byteLength: number;
      };
      assert.equal(body.ok, true);
      assert.match(body.promptRef, /^run-prompt-input:/u);
      assert.ok(body.byteLength > 0);

      const resolved = await readRunPromptInputRef({
        workspaceRoot: getWorkspaceRootFromContext(daemonContext),
        promptRef: body.promptRef,
      });
      assert.equal(resolved.ok, true);
      if (!resolved.ok) {
        return;
      }
      assert.equal(resolved.prompt, 'stored prompt');
    },
    { daemonContext },
  );
});

void test('authenticated run prompt input route deletes uploaded prompt refs', async () => {
  const daemonContext = createRouteTestDaemonContext();
  const workspaceRoot = getWorkspaceRootFromContext(daemonContext);

  await withAuthenticatedDaemonServer(
    async ({ port }) => {
      const uploadRes = await fetch(
        `http://127.0.0.1:${port}/api/run/prompt-inputs?projectId=${DEFAULT_PROJECT_ID}`,
        {
          method: 'POST',
          headers: authHeaders({
            'Content-Type': 'text/plain;charset=UTF-8',
          }),
          body: 'delete me',
        },
      );
      assert.equal(uploadRes.status, 201);
      const uploadBody = (await uploadRes.json()) as { promptRef: string };

      const deleteRes = await fetch(
        `http://127.0.0.1:${port}/api/run/prompt-inputs?projectId=${DEFAULT_PROJECT_ID}&promptRef=${encodeURIComponent(
          uploadBody.promptRef,
        )}`,
        {
          method: 'DELETE',
          headers: authHeaders(),
        },
      );

      assert.equal(deleteRes.status, 200);
      assert.deepEqual(await deleteRes.json(), { ok: true });
      assert.deepEqual(
        await readRunPromptInputRef({
          workspaceRoot,
          promptRef: uploadBody.promptRef,
        }),
        {
          ok: false,
          code: 'not_found',
          message: 'promptRef was not found.',
        },
      );
    },
    { daemonContext },
  );
});

void test('authenticated run prompt input route rejects JSON uploads', async () => {
  await withAuthenticatedDaemonServer(async ({ port }) => {
    const res = await fetch(
      `http://127.0.0.1:${port}/api/run/prompt-inputs?projectId=${DEFAULT_PROJECT_ID}`,
      {
        method: 'POST',
        headers: authHeaders({
          'Content-Type': 'application/json',
        }),
        body: JSON.stringify({ prompt: 'inline json body' }),
      },
    );

    assert.equal(res.status, 400);
    assert.deepEqual(await res.json(), {
      code: 'bad_request',
      message: 'run prompt input upload must use a streaming content type',
    });
  });
});
