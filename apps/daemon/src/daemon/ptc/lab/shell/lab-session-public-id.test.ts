import assert from 'node:assert/strict';
import test from 'node:test';

import { buildPtcLabPublicSessionId } from './lab-session-public-id.js';

void test('PTC lab public session id exposes only the stable 32-char identity hash prefix', () => {
  const visiblePrefix = '0123456789abcdef0123456789abcdef';
  const hiddenSuffix = 'secret-container-and-policy-material';
  const id = buildPtcLabPublicSessionId({
    reuseKey: { identityHash: `${visiblePrefix}${hiddenSuffix}` },
  });

  assert.equal(id, `ptc-lab-${visiblePrefix}`);
  assert.equal(id.length, 'ptc-lab-'.length + visiblePrefix.length);
  assert.doesNotMatch(id, /secret|container|policy/u);
});
