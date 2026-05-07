import assert from 'node:assert/strict';
import test from 'node:test';

import {
  REACT_BUNDLE_INLINE_MAX_FILE_COUNT,
  REACT_BUNDLE_INLINE_MAX_TOTAL_SOURCE_BYTES,
  decodeReactBundleInlineCompileRequest,
  decodeReactBundleInlineSourceInput,
  isReactBundleInlineCompileResponse,
} from './react-bundle-inline-compile.js';

void test('decodeReactBundleInlineCompileRequest normalizes valid inline source requests', () => {
  const result = decodeReactBundleInlineCompileRequest({
    renderer: 'react_bundle',
    input: {
      files: {
        'src/App.jsx': 'export default function App() { return null; }',
        'src/styles.css': 'body { margin: 0; }',
      },
      entry: 'src/App.jsx',
    },
  });

  assert.deepEqual(result, {
    ok: true,
    value: {
      renderer: 'react_bundle',
      input: {
        files: {
          'src/App.jsx': 'export default function App() { return null; }',
          'src/styles.css': 'body { margin: 0; }',
        },
        entry: 'src/App.jsx',
      },
    },
  });
});

void test('decodeReactBundleInlineSourceInput rejects forbidden path forms', () => {
  assert.deepEqual(
    decodeReactBundleInlineSourceInput({
      files: {
        '../App.jsx': 'export default function App() { return null; }',
      },
      entry: '../App.jsx',
    }),
    {
      ok: false,
      code: 'sanitize_rejected',
      detail:
        'react bundle inline source path ../App.jsx must not escape its root',
    },
  );

  assert.deepEqual(
    decodeReactBundleInlineSourceInput({
      files: {
        'C:/App.jsx': 'export default function App() { return null; }',
      },
      entry: 'C:/App.jsx',
    }),
    {
      ok: false,
      code: 'sanitize_rejected',
      detail:
        'react bundle inline source path C:/App.jsx must not use a drive letter',
    },
  );
});

void test('decodeReactBundleInlineSourceInput rejects duplicate normalized paths and missing entries', () => {
  assert.deepEqual(
    decodeReactBundleInlineSourceInput({
      files: {
        'src/App.jsx': 'export default function App() { return null; }',
        'src//App.jsx': 'export default function App() { return null; }',
      },
      entry: 'src/App.jsx',
    }),
    {
      ok: false,
      code: 'sanitize_rejected',
      detail:
        'react bundle inline source path src//App.jsx must not contain empty segments',
    },
  );

  assert.deepEqual(
    decodeReactBundleInlineSourceInput({
      files: {
        'src/App.jsx': 'export default function App() { return null; }',
      },
      entry: 'src/Missing.jsx',
    }),
    {
      ok: false,
      code: 'sanitize_rejected',
      detail:
        'react bundle inline source entry src/Missing.jsx must match a provided file',
    },
  );
});

void test('decodeReactBundleInlineSourceInput enforces file-count and byte quotas', () => {
  const tooManyFiles = Object.fromEntries(
    Array.from(
      { length: REACT_BUNDLE_INLINE_MAX_FILE_COUNT + 1 },
      (_, index) => [`src/file-${index + 1}.jsx`, 'export default null;'],
    ),
  );

  assert.deepEqual(
    decodeReactBundleInlineSourceInput({
      files: tooManyFiles,
      entry: 'src/file-1.jsx',
    }),
    {
      ok: false,
      code: 'sanitize_rejected',
      detail: `react bundle inline source exceeds max file count ${REACT_BUNDLE_INLINE_MAX_FILE_COUNT}`,
    },
  );

  assert.deepEqual(
    decodeReactBundleInlineSourceInput({
      files: {
        'src/App.jsx': 'x'.repeat(
          REACT_BUNDLE_INLINE_MAX_TOTAL_SOURCE_BYTES + 1,
        ),
      },
      entry: 'src/App.jsx',
    }),
    {
      ok: false,
      code: 'sanitize_rejected',
      detail: `react bundle inline source exceeds max total source bytes ${REACT_BUNDLE_INLINE_MAX_TOTAL_SOURCE_BYTES}`,
    },
  );
});

void test('decodeReactBundleInlineSourceInput measures UTF-8 byte quotas without ambient TextEncoder globals', () => {
  const multibyte = '가'.repeat(
    Math.floor(REACT_BUNDLE_INLINE_MAX_TOTAL_SOURCE_BYTES / 3),
  );

  assert.deepEqual(
    decodeReactBundleInlineSourceInput({
      files: {
        'src/App.jsx': `${multibyte}AB`,
      },
      entry: 'src/App.jsx',
    }),
    {
      ok: false,
      code: 'sanitize_rejected',
      detail: `react bundle inline source exceeds max total source bytes ${REACT_BUNDLE_INLINE_MAX_TOTAL_SOURCE_BYTES}`,
    },
  );
});

void test('isReactBundleInlineCompileResponse accepts normalized success and failure responses', () => {
  assert.equal(
    isReactBundleInlineCompileResponse({
      ok: true,
      manifest: {
        entryUrl:
          'http://127.0.0.1:3456/public-generated/react-inline/entry.js',
      },
    }),
    true,
  );

  assert.equal(
    isReactBundleInlineCompileResponse({
      ok: false,
      code: 'boot_failed',
      detail:
        'react bundle inline source compile service is not implemented yet',
    }),
    true,
  );
});
