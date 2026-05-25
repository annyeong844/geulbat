import assert from 'node:assert/strict';
import test from 'node:test';

import { DEV_TOKEN_HEADER_NAME } from './shell-auth.js';

void test('dev-token header name is a shared shell auth protocol constant', () => {
  assert.equal(DEV_TOKEN_HEADER_NAME, 'X-Geulbat-Dev-Token');
});
