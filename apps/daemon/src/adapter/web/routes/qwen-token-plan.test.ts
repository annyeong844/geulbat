import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  QWEN_TOKEN_PLAN_CHINA_BASE_URL,
  readQwenTokenPlanCredential,
} from '../../../daemon/llm/provider/qwen/index.js';
import {
  authHeaders,
  createRouteTestDaemonContext,
  withAuthenticatedDaemonServer,
  withDaemonServer,
} from '../../../test-support/http-routes.js';

void test('Qwen Token Plan routes authenticate and persist only the submitted user credential', async () => {
  const root = await mkdtemp(join(tmpdir(), 'geulbat-qwen-routes-'));
  const filePath = join(root, 'qwen-token-plan.json');
  const previousPath = process.env['GEULBAT_QWEN_CREDENTIAL_FILE_PATH'];
  const previousApiKey = process.env['BAILIAN_TOKEN_PLAN_API_KEY'];
  const previousBaseUrl = process.env['GEULBAT_QWEN_BASE_URL'];
  process.env['GEULBAT_QWEN_CREDENTIAL_FILE_PATH'] = filePath;
  delete process.env['BAILIAN_TOKEN_PLAN_API_KEY'];
  delete process.env['GEULBAT_QWEN_BASE_URL'];

  try {
    await withDaemonServer(
      async ({ port }) => {
        const response = await fetch(
          `http://127.0.0.1:${port}/api/qwen-token-plan/status`,
        );
        assert.equal(response.status, 401);
      },
      { daemonContext: createRouteTestDaemonContext() },
    );

    await withAuthenticatedDaemonServer(
      async ({ port }) => {
        const initial = await fetch(
          `http://127.0.0.1:${port}/api/qwen-token-plan/status`,
          { headers: authHeaders() },
        );
        assert.equal(initial.status, 200);
        assert.deepEqual(await initial.json(), {
          state: 'missing',
          region: 'global',
          baseUrl:
            'https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1',
        });

        const apiKey = 'x'.repeat(32);
        const connected = await fetch(
          `http://127.0.0.1:${port}/api/qwen-token-plan/connect`,
          {
            method: 'POST',
            headers: authHeaders({ 'Content-Type': 'application/json' }),
            body: JSON.stringify({ apiKey, region: 'china' }),
          },
        );
        assert.equal(connected.status, 200);
        const connectedBody = await connected.json();
        assert.deepEqual(connectedBody, {
          state: 'ready',
          source: 'stored',
          region: 'china',
          baseUrl: QWEN_TOKEN_PLAN_CHINA_BASE_URL,
        });
        assert.equal(JSON.stringify(connectedBody).includes(apiKey), false);
        assert.deepEqual(await readQwenTokenPlanCredential({ filePath }), {
          apiKey,
          region: 'china',
        });

        const disconnected = await fetch(
          `http://127.0.0.1:${port}/api/qwen-token-plan/disconnect`,
          { method: 'POST', headers: authHeaders() },
        );
        assert.equal(disconnected.status, 200);
        assert.deepEqual(await disconnected.json(), { ok: true });
        assert.equal(await readQwenTokenPlanCredential({ filePath }), null);
      },
      { daemonContext: createRouteTestDaemonContext() },
    );
  } finally {
    restoreEnvironment('GEULBAT_QWEN_CREDENTIAL_FILE_PATH', previousPath);
    restoreEnvironment('BAILIAN_TOKEN_PLAN_API_KEY', previousApiKey);
    restoreEnvironment('GEULBAT_QWEN_BASE_URL', previousBaseUrl);
    await rm(root, { recursive: true, force: true });
  }
});

void test('Qwen Token Plan routes report environment precedence and refuse to mutate it', async () => {
  const previousApiKey = process.env['BAILIAN_TOKEN_PLAN_API_KEY'];
  process.env['BAILIAN_TOKEN_PLAN_API_KEY'] = 'x'.repeat(32);

  try {
    await withAuthenticatedDaemonServer(
      async ({ port }) => {
        const status = await fetch(
          `http://127.0.0.1:${port}/api/qwen-token-plan/status`,
          { headers: authHeaders() },
        );
        assert.equal(status.status, 200);
        assert.deepEqual(await status.json(), {
          state: 'ready',
          source: 'environment',
          region: 'global',
          baseUrl:
            'https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1',
        });

        for (const [path, body] of [
          [
            'connect',
            JSON.stringify({ apiKey: 'y'.repeat(32), region: 'global' }),
          ],
          ['disconnect', undefined],
        ] as const) {
          const response = await fetch(
            `http://127.0.0.1:${port}/api/qwen-token-plan/${path}`,
            {
              method: 'POST',
              headers: authHeaders({ 'Content-Type': 'application/json' }),
              ...(body === undefined ? {} : { body }),
            },
          );
          assert.equal(response.status, 409);
          const error = (await response.json()) as { code: string };
          assert.equal(error.code, 'conflict');
        }
      },
      { daemonContext: createRouteTestDaemonContext() },
    );
  } finally {
    restoreEnvironment('BAILIAN_TOKEN_PLAN_API_KEY', previousApiKey);
  }
});

function restoreEnvironment(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}
