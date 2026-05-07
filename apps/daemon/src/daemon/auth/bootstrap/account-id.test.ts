import test from 'node:test';
import assert from 'node:assert/strict';

import {
  deriveProviderAccountId,
  extractAccountIdFromJwt,
} from './account-id.js';

function makeJwt(payload: object): string {
  const header = base64Url(JSON.stringify({ alg: 'none', typ: 'JWT' }));
  const body = base64Url(JSON.stringify(payload));
  return `${header}.${body}.sig`;
}

void test('deriveProviderAccountId prefers explicit accountId', () => {
  const accessToken = makeJwt({
    'https://api.openai.com/auth': { chatgpt_account_id: 'acct_from_access' },
  });

  const accountId = deriveProviderAccountId({
    accountId: 'acct_explicit',
    accessToken,
  });

  assert.equal(accountId, 'acct_explicit');
});

void test('extractAccountIdFromJwt reads OpenAI namespaced claim', () => {
  const token = makeJwt({
    'https://api.openai.com/auth': { chatgpt_account_id: 'acct_123' },
  });

  assert.equal(extractAccountIdFromJwt(token), 'acct_123');
});

void test('extractAccountIdFromJwt treats malformed jwt payloads as probe misses', () => {
  assert.equal(extractAccountIdFromJwt('header.invalid-json.sig'), null);
});

function base64Url(text: string): string {
  return Buffer.from(text, 'utf8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}
