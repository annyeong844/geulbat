import assert from 'node:assert/strict';
import test from 'node:test';

import { PUBLIC_GENERATED_REACT_BUNDLE_INLINE_PATH_PREFIX } from '@geulbat/protocol/react-bundle-inline-compile';
import {
  PUBLIC_WEB_REACT_BUNDLE_COUNTER_ENTRY_PATH,
  PUBLIC_WEB_REACT_BUNDLE_RUNTIME_DEPENDENCIES_ENTRY_PATH,
} from '@geulbat/protocol/public-web-fixtures';
import {
  isReactBundleShellOwnedPrivilegedUrl,
  validateReactBundleRuntimeUrlPolicy,
} from './react-bundle-url.js';

void test('validateReactBundleRuntimeUrlPolicy accepts personal web-shell entry URL families', () => {
  for (const entryUrl of [
    'https://cdn.example.com/react-entry.js',
    `https://fixtures.geulbat.local${PUBLIC_WEB_REACT_BUNDLE_RUNTIME_DEPENDENCIES_ENTRY_PATH}`,
    `http://127.0.0.1:3456${PUBLIC_WEB_REACT_BUNDLE_COUNTER_ENTRY_PATH}`,
    `http://[::ffff:7f00:1]:3456${PUBLIC_WEB_REACT_BUNDLE_COUNTER_ENTRY_PATH}`,
    `http://127.0.0.1:3456${PUBLIC_GENERATED_REACT_BUNDLE_INLINE_PATH_PREFIX}hash/entry.js`,
    'https://192.168.0.1/public-web/react-bundle-counter/entry.js',
  ]) {
    assert.deepEqual(
      validateReactBundleRuntimeUrlPolicy(entryUrl),
      { ok: true, url: new URL(entryUrl).toString() },
      entryUrl,
    );
  }
});

void test('validateReactBundleRuntimeUrlPolicy rejects non-http executable entry schemes', () => {
  for (const entryUrl of [
    'file:///tmp/react-entry.js',
    'data:text/javascript,export default {}',
    'javascript:globalThis.__geulbatTest__=1',
    'blob:https://fixtures.geulbat.local/react-bundle-entry',
  ]) {
    assert.deepEqual(
      validateReactBundleRuntimeUrlPolicy(entryUrl),
      { ok: false, reasonCode: 'unsupported_scheme' },
      entryUrl,
    );
  }
});

void test('validateReactBundleRuntimeUrlPolicy rejects malformed entry URLs', () => {
  assert.deepEqual(validateReactBundleRuntimeUrlPolicy(''), {
    ok: false,
    reasonCode: 'empty',
  });
  assert.deepEqual(validateReactBundleRuntimeUrlPolicy('./entry.js'), {
    ok: false,
    reasonCode: 'malformed',
  });
});

void test('validateReactBundleRuntimeUrlPolicy rejects shell-owned privileged entry URLs', () => {
  for (const entryUrl of [
    'http://127.0.0.1:3456/artifact-runtime/host',
    'http://localhost:3456/artifact-runtime/host',
    'http://[::1]:3456/artifact-runtime/host',
    'http://[::ffff:7f00:1]:3456/artifact-runtime/host',
  ]) {
    assert.deepEqual(
      validateReactBundleRuntimeUrlPolicy(entryUrl),
      {
        ok: false,
        reasonCode: 'shell_owned_privileged',
      },
      entryUrl,
    );
  }
});

void test('isReactBundleShellOwnedPrivilegedUrl identifies only shell-owned privileged paths', () => {
  assert.equal(
    isReactBundleShellOwnedPrivilegedUrl(
      new URL('http://127.0.0.1:3456/artifact-runtime/host'),
    ),
    true,
  );
  assert.equal(
    isReactBundleShellOwnedPrivilegedUrl(
      new URL(
        `http://127.0.0.1:3456${PUBLIC_WEB_REACT_BUNDLE_COUNTER_ENTRY_PATH}`,
      ),
    ),
    false,
  );
  assert.equal(
    isReactBundleShellOwnedPrivilegedUrl(
      new URL(
        `http://127.0.0.1:3456${PUBLIC_GENERATED_REACT_BUNDLE_INLINE_PATH_PREFIX}hash/entry.js`,
      ),
    ),
    false,
  );
  assert.equal(
    isReactBundleShellOwnedPrivilegedUrl(
      new URL('data:text/javascript,export default {}'),
    ),
    false,
  );
});
