import assert from 'node:assert/strict';
import test from 'node:test';

import {
  decodeReactBundleInlineCompileRequest,
  decodeReactBundleInlineSourceInput,
  isReactBundleInlineCompileInputRefResponse,
  isReactBundleInlineCompileResponse,
  isReactBundleRuntimeManifest,
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

void test('decodeReactBundleInlineCompileRequest accepts streamed inline source refs', () => {
  assert.deepEqual(
    decodeReactBundleInlineCompileRequest({
      renderer: 'react_bundle',
      inputRef:
        'react-bundle-inline-compile-input:00000000-0000-4000-8000-000000000001',
    }),
    {
      ok: true,
      value: {
        renderer: 'react_bundle',
        inputRef:
          'react-bundle-inline-compile-input:00000000-0000-4000-8000-000000000001',
      },
    },
  );
});

void test('decodeReactBundleInlineCompileRequest rejects ambiguous inline source transports', () => {
  assert.deepEqual(
    decodeReactBundleInlineCompileRequest({
      renderer: 'react_bundle',
      input: {
        files: {
          'src/App.jsx': 'export default function App() { return null; }',
        },
        entry: 'src/App.jsx',
      },
      inputRef:
        'react-bundle-inline-compile-input:00000000-0000-4000-8000-000000000001',
    }),
    {
      ok: false,
      code: 'sanitize_rejected',
      detail:
        'react bundle inline compile request must contain exactly one of input or inputRef',
    },
  );
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

void test('decodeReactBundleInlineSourceInput accepts larger inline source graphs after path validation', () => {
  const files = Object.fromEntries(
    Array.from({ length: 40 }, (_, index) => [
      `src/file-${index + 1}.jsx`,
      'export default null;',
    ]),
  );
  files['src/App.jsx'] = '가'.repeat(90_000);

  const result = decodeReactBundleInlineSourceInput({
    files,
    entry: 'src/App.jsx',
  });

  assert.equal(result.ok, true);
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

void test('isReactBundleInlineCompileInputRefResponse accepts streamed upload refs', () => {
  assert.equal(
    isReactBundleInlineCompileInputRefResponse({
      ok: true,
      inputRef:
        'react-bundle-inline-compile-input:00000000-0000-4000-8000-000000000001',
      byteLength: 42,
    }),
    true,
  );

  assert.equal(
    isReactBundleInlineCompileInputRefResponse({
      ok: true,
      inputRef:
        'react-bundle-inline-compile-input:00000000-0000-4000-8000-000000000001',
      byteLength: '42',
    }),
    false,
  );
});

void test('isReactBundleRuntimeManifest accepts explicit runtime dependencies', () => {
  assert.equal(
    isReactBundleRuntimeManifest({
      entryUrl: 'https://cdn.example.com/app.js',
      runtimeDependencies: {
        importMap: {
          imports: {
            'canvas-confetti': 'https://esm.sh/canvas-confetti@1.9.3',
          },
        },
        stylesheets: ['https://cdn.example.com/app.css'],
      },
    }),
    true,
  );
});

void test('isReactBundleRuntimeManifest rejects unsupported runtime dependency keys', () => {
  assert.equal(
    isReactBundleRuntimeManifest({
      entryUrl: 'https://cdn.example.com/app.js',
      runtimeDependencies: {
        scripts: ['https://cdn.example.com/legacy.js'],
      },
    }),
    false,
  );

  assert.equal(
    isReactBundleRuntimeManifest({
      entryUrl: 'https://cdn.example.com/app.js',
      runtimeDependencies: {
        importMap: {
          imports: {},
          scopes: {
            '/': {},
          },
        },
      },
    }),
    false,
  );
});

void test('isReactBundleRuntimeManifest rejects malformed runtime dependencies', () => {
  assert.equal(
    isReactBundleRuntimeManifest({
      entryUrl: 'https://cdn.example.com/app.js',
      runtimeDependencies: {
        importMap: {
          imports: {
            'canvas-confetti': 42,
          },
        },
      },
    }),
    false,
  );

  assert.equal(
    isReactBundleRuntimeManifest({
      entryUrl: 'https://cdn.example.com/app.js',
      runtimeDependencies: {
        stylesheets: ['https://cdn.example.com/app.css', 42],
      },
    }),
    false,
  );
});
