import test from 'node:test';
import assert from 'node:assert/strict';

import {
  PUBLIC_WEB_CONFORMANCE_FIXTURES_ENV_NAME,
  readPublicWebConformanceFixturesEnabled,
} from './public-web-conformance.js';

void test('public web conformance fixtures stay disabled when activation is absent', () => {
  assert.equal(readPublicWebConformanceFixturesEnabled({}), false);
});

void test('public web conformance fixtures accept the explicit activation value', () => {
  assert.equal(
    readPublicWebConformanceFixturesEnabled({
      [PUBLIC_WEB_CONFORMANCE_FIXTURES_ENV_NAME]: '1',
    }),
    true,
  );
});

void test('public web conformance fixture activation rejects ambiguous values', () => {
  for (const configured of ['', '0', 'true']) {
    assert.throws(
      () =>
        readPublicWebConformanceFixturesEnabled({
          [PUBLIC_WEB_CONFORMANCE_FIXTURES_ENV_NAME]: configured,
        }),
      new RegExp(PUBLIC_WEB_CONFORMANCE_FIXTURES_ENV_NAME, 'u'),
    );
  }
});
