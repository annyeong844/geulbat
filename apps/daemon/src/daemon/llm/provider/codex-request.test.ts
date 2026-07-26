import test from 'node:test';
import assert from 'node:assert/strict';

import { buildResponsesRequestHeaders } from './codex-request.js';

void test('buildResponsesRequestHeaders uses the current Codex direct originator', () => {
  const headers = buildResponsesRequestHeaders({
    accessToken: 'token',
    accountId: 'account',
    providerSessionId: 'provider-session',
  });

  assert.equal(headers.get('originator'), 'codex_cli_rs');
});
