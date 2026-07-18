import assert from 'node:assert/strict';
import test from 'node:test';

import {
  authHeaders,
  withAuthenticatedDaemonServer,
} from './test-support/http-routes.js';

void test('authenticated project CRUD routes are retired', async () => {
  await withAuthenticatedDaemonServer(async ({ port }) => {
    const requests = [
      { method: 'GET', path: '/api/projects' },
      { method: 'POST', path: '/api/projects' },
      { method: 'PATCH', path: '/api/projects/retired-project' },
      { method: 'DELETE', path: '/api/projects/retired-project' },
    ] as const;

    for (const request of requests) {
      const response = await fetch(`http://127.0.0.1:${port}${request.path}`, {
        method: request.method,
        headers: authHeaders(),
      });
      assert.equal(
        response.status,
        404,
        `${request.method} ${request.path} must remain unmounted`,
      );
    }
  });
});
