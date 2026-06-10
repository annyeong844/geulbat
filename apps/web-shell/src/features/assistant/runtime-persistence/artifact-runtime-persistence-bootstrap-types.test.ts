import test from 'node:test';
import assert from 'node:assert/strict';

import { isPersistenceBootstrapSuccessResponseMessage } from './artifact-runtime-persistence-bootstrap-types.js';

const BASE_SUCCESS_RESPONSE = {
  kind: 'geulbat:persistence-response',
  version: 1,
  requestId: 'request-1',
  scopeHandle: 'scope-1',
  verb: 'load_state',
  ok: true,
} as const;

void test('persistence bootstrap success response guard accepts valid revision states without constraining payload state', () => {
  const validResponses: unknown[] = [
    BASE_SUCCESS_RESPONSE,
    { ...BASE_SUCCESS_RESPONSE, version: '1' },
    { ...BASE_SUCCESS_RESPONSE, revision: null },
    { ...BASE_SUCCESS_RESPONSE, revision: 'rev-1' },
    { ...BASE_SUCCESS_RESPONSE, state: { count: 1 } },
    { ...BASE_SUCCESS_RESPONSE, state: ['runtime', 'state'] },
  ];

  for (const response of validResponses) {
    assert.equal(isPersistenceBootstrapSuccessResponseMessage(response), true);
  }
});

void test('persistence bootstrap success response guard rejects malformed success envelopes before bridge settlement', () => {
  const invalidResponses: unknown[] = [
    null,
    [],
    { ...BASE_SUCCESS_RESPONSE, ok: false },
    { ...BASE_SUCCESS_RESPONSE, kind: 1 },
    { ...BASE_SUCCESS_RESPONSE, version: null },
    { ...BASE_SUCCESS_RESPONSE, requestId: 1 },
    { ...BASE_SUCCESS_RESPONSE, scopeHandle: 1 },
    { ...BASE_SUCCESS_RESPONSE, verb: 1 },
    { ...BASE_SUCCESS_RESPONSE, revision: 1 },
  ];

  for (const response of invalidResponses) {
    assert.equal(isPersistenceBootstrapSuccessResponseMessage(response), false);
  }
});
