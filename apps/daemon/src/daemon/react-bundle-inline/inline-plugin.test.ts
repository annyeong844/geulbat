import assert from 'node:assert/strict';
import test from 'node:test';
import { build, type BuildFailure } from 'esbuild';
import { createReactBundleInlinePlugin } from './inline-plugin.js';

const ENTRY_WRAPPER_SPECIFIER = '__geulbat_inline_entry_wrapper__';

async function bundleInlineSource(args: {
  files: Record<string, string>;
  entry: string;
}): Promise<string> {
  const result = await build({
    bundle: true,
    entryPoints: [ENTRY_WRAPPER_SPECIFIER],
    format: 'esm',
    platform: 'browser',
    target: ['es2022'],
    write: false,
    logLevel: 'silent',
    plugins: [createReactBundleInlinePlugin(args)],
  });

  const output = result.outputFiles?.[0]?.text;
  assert.ok(output !== undefined);
  return output;
}

function assertEsbuildFailure(
  error: unknown,
  expectedCode: 'sanitize_rejected' | 'policy_blocked',
  expectedDetailFragment: string,
): void {
  assert.ok(error);
  assert.equal(typeof error, 'object');
  const failure = error as BuildFailure;
  assert.ok(Array.isArray(failure.errors));
  assert.match(
    failure.errors[0]?.text ?? '',
    new RegExp(`\\[${expectedCode}\\].*${expectedDetailFragment}`),
  );
}

void test('inline plugin bundles default component entries with CSS injection', async () => {
  const output = await bundleInlineSource({
    files: {
      'src/App.jsx': [
        "import './styles.css';",
        'export default function App() {',
        '  return <div className="heart">heart</div>;',
        '}',
      ].join('\n'),
      'src/styles.css': '.heart { color: hotpink; }',
    },
    entry: 'src/App.jsx',
  });

  assert.match(output, /geulbat-inline-style-/);
  assert.match(output, /createElement\(candidate\)/);
  assert.match(output, /geulbat_inline_entry_wrapper_default as default/);
});

void test('inline plugin accepts self-bootstrapping src\\/main.jsx entries', async () => {
  const output = await bundleInlineSource({
    files: {
      'src/main.jsx': [
        "import React from 'react';",
        "import { createRoot } from 'react-dom/client';",
        "import App from './App.jsx';",
        '',
        "createRoot(document.getElementById('root')).render(<App />);",
      ].join('\n'),
      'src/App.jsx':
        'export default function App() { return <div id="heart">heart</div>; }',
    },
    entry: 'src/main.jsx',
  });

  assert.match(output, /__GEULBAT_INLINE_REACT_ROOT_REGISTRY__/);
  assert.match(output, /function createSelfBootstrappedCleanupRegistration/);
});

void test('inline plugin rejects unsupported bare imports with sanitize_rejected', async () => {
  await assert.rejects(
    () =>
      bundleInlineSource({
        files: {
          'src/App.jsx': [
            "import thing from 'left-pad';",
            'export default function App() {',
            '  return <div>{thing}</div>;',
            '}',
          ].join('\n'),
        },
        entry: 'src/App.jsx',
      }),
    (error: unknown) => {
      assertEsbuildFailure(error, 'sanitize_rejected', 'left-pad');
      return true;
    },
  );
});

void test('inline plugin rejects remote absolute imports with sanitize_rejected', async () => {
  await assert.rejects(
    () =>
      bundleInlineSource({
        files: {
          'src/App.jsx': [
            "import remote from 'https://cdn.example.com/widget.js';",
            'export default function App() {',
            '  return <div>{remote}</div>;',
            '}',
          ].join('\n'),
        },
        entry: 'src/App.jsx',
      }),
    (error: unknown) => {
      assertEsbuildFailure(
        error,
        'sanitize_rejected',
        'https://cdn.example.com/widget.js',
      );
      return true;
    },
  );
});

void test('inline plugin rejects relative imports that escape the inline root', async () => {
  await assert.rejects(
    () =>
      bundleInlineSource({
        files: {
          'src/App.jsx': [
            "import Outside from '../../Outside.jsx';",
            'export default function App() {',
            '  return <Outside />;',
            '}',
          ].join('\n'),
        },
        entry: 'src/App.jsx',
      }),
    (error: unknown) => {
      assertEsbuildFailure(
        error,
        'sanitize_rejected',
        'must not escape its root',
      );
      return true;
    },
  );
});
