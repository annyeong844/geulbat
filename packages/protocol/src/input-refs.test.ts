import assert from 'node:assert/strict';
import test from 'node:test';

import {
  type InputRefRecoveryRequest,
  isInputRefInventoryResponse,
  isInputRefRecoveryResponse,
} from './input-refs.js';

void test('input ref recovery request is scoped by ref without project identity', () => {
  const request = {
    ref: 'run-prompt-input:11111111-1111-4111-8111-111111111111',
    action: 'retry',
  } satisfies InputRefRecoveryRequest;

  assert.deepEqual(request, {
    ref: 'run-prompt-input:11111111-1111-4111-8111-111111111111',
    action: 'retry',
  });
});

void test('input ref inventory requires claim identity for non-pending entries', () => {
  assert.equal(
    isInputRefInventoryResponse({
      ok: true,
      entries: [
        {
          ref: 'run-prompt-input:11111111-1111-4111-8111-111111111111',
          kind: 'run_prompt',
          state: 'interrupted',
          byteLength: 12,
          createdAt: '2026-06-22T00:00:00.000Z',
          claimId: '22222222-2222-4222-8222-222222222222',
        },
      ],
      totalByteLength: 12,
    }),
    true,
  );
  assert.equal(
    isInputRefInventoryResponse({
      ok: true,
      entries: [
        {
          ref: 'run-prompt-input:11111111-1111-4111-8111-111111111111',
          kind: 'run_prompt',
          state: 'interrupted',
          byteLength: 12,
          createdAt: '2026-06-22T00:00:00.000Z',
        },
      ],
      totalByteLength: 12,
    }),
    false,
  );
});

void test('input ref recovery response admits only explicit dispositions', () => {
  assert.equal(
    isInputRefRecoveryResponse({ ok: true, disposition: 'pending' }),
    true,
  );
  assert.equal(
    isInputRefRecoveryResponse({ ok: true, disposition: 'expired' }),
    false,
  );
});
