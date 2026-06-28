import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  PUBLIC_GENERATED_REACT_BUNDLE_INLINE_PATH_PREFIX,
  isReactBundleInlineCompileResponse,
  type ReactBundleInlineCompileResponse,
} from '@geulbat/protocol/react-bundle-inline-compile';

import {
  authHeaders,
  createRouteTestDaemonContext,
  getWorkspaceRootFromContext,
  withAuthenticatedDaemonServer,
} from './test-support/http-routes.js';
import { GENERATED_ROOT_ENV } from './daemon/react-bundle-inline/generated-assets.js';
import { DEFAULT_PROJECT_ID } from './daemon/files/project-registry-state.js';
import { readReactBundleInlineCompileInputRefPath } from './daemon/react-bundle-inline/input-ref-store.js';

function assertReactBundleInlineCompileResponse(
  body: unknown,
): asserts body is ReactBundleInlineCompileResponse {
  assert.equal(isReactBundleInlineCompileResponse(body), true);
}

void test('react bundle inline compile route returns generated manifest and serves durable entry assets', async () => {
  await withGeneratedRootEnv(async () => {
    await withAuthenticatedDaemonServer(async ({ port }) => {
      const res = await fetch(
        `http://127.0.0.1:${port}/api/react-bundle-inline-compile`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...authHeaders(),
          },
          body: JSON.stringify({
            renderer: 'react_bundle',
            input: {
              files: {
                'src/App.jsx': [
                  "import './styles.css';",
                  "import React, { useState } from 'react';",
                  '',
                  'export default function App() {',
                  '  const [count, setCount] = useState(0);',
                  '  return (',
                  '    <button id="count" className="heart" onClick={() => setCount((value) => value + 1)}>',
                  '      count:{count}',
                  '    </button>',
                  '  );',
                  '}',
                ].join('\n'),
                'src/styles.css':
                  '.heart { border: 0; border-radius: 999px; padding: 12px 18px; background: #ff4f93; color: white; }',
              },
              entry: 'src/App.jsx',
            },
          }),
        },
      );

      assert.equal(res.status, 200);
      const body = (await res.json()) as unknown;
      assertReactBundleInlineCompileResponse(body);
      assert.equal(body.ok, true);
      if (!body.ok) {
        return;
      }

      assert.match(
        body.manifest.entryUrl,
        new RegExp(
          `^http://127\\.0\\.0\\.1:${port}${PUBLIC_GENERATED_REACT_BUNDLE_INLINE_PATH_PREFIX.replace(/\//g, '\\/')}[a-f0-9]+/entry\\.js$`,
        ),
      );

      const entryRes = await fetch(body.manifest.entryUrl);
      assert.equal(entryRes.status, 200);
      assert.equal(
        entryRes.headers.get('content-type'),
        'text/javascript; charset=utf-8',
      );
      const entrySource = await entryRes.text();
      assert.match(
        entrySource,
        /export\s*\{\s*geulbat_inline_entry_wrapper_default as default\s*\};/,
      );
      assert.match(entrySource, /geulbat-inline-style-/);
    });
  });
});

void test('react bundle inline compile route accepts streamed input refs beyond the JSON body cap', async () => {
  const daemonContext = createRouteTestDaemonContext();
  const workspaceRoot = getWorkspaceRootFromContext(daemonContext);
  await withGeneratedRootEnv(async () => {
    await withAuthenticatedDaemonServer(
      async ({ port }) => {
        const filler = 'x'.repeat(300 * 1024);
        const inlineInput = {
          files: {
            'src/App.jsx': [
              `/* ${filler} */`,
              'export default function App() { return <div id="heart">heart</div>; }',
            ].join('\n'),
          },
          entry: 'src/App.jsx',
        };

        const uploadRes = await fetch(
          `http://127.0.0.1:${port}/api/react-bundle-inline-compile/inputs?projectId=${DEFAULT_PROJECT_ID}`,
          {
            method: 'POST',
            headers: authHeaders({
              'Content-Type': 'text/plain;charset=UTF-8',
            }),
            body: JSON.stringify(inlineInput),
          },
        );

        assert.equal(uploadRes.status, 201);
        const uploadBody = (await uploadRes.json()) as {
          ok: boolean;
          inputRef: string;
          byteLength: number;
        };
        assert.equal(uploadBody.ok, true);
        assert.match(
          uploadBody.inputRef,
          /^react-bundle-inline-compile-input:/u,
        );
        assert.ok(uploadBody.byteLength > 256 * 1024);

        const compileRes = await fetch(
          `http://127.0.0.1:${port}/api/react-bundle-inline-compile?projectId=${DEFAULT_PROJECT_ID}`,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              ...authHeaders(),
            },
            body: JSON.stringify({
              renderer: 'react_bundle',
              inputRef: uploadBody.inputRef,
            }),
          },
        );

        assert.equal(compileRes.status, 200);
        const compileBody = (await compileRes.json()) as unknown;
        assertReactBundleInlineCompileResponse(compileBody);
        assert.equal(compileBody.ok, true);

        assert.deepEqual(
          await readReactBundleInlineCompileInputRefPath({
            workspaceRoot,
            inputRef: uploadBody.inputRef,
          }),
          {
            ok: false,
            code: 'not_found',
            message: 'inputRef was not found.',
          },
        );
      },
      { daemonContext },
    );
  });
});

void test('react bundle inline compile input upload rejects JSON content type', async () => {
  await withAuthenticatedDaemonServer(async ({ port }) => {
    const res = await fetch(
      `http://127.0.0.1:${port}/api/react-bundle-inline-compile/inputs?projectId=${DEFAULT_PROJECT_ID}`,
      {
        method: 'POST',
        headers: authHeaders({
          'Content-Type': 'application/json',
        }),
        body: JSON.stringify({
          files: {
            'src/App.jsx': 'export default function App() { return null; }',
          },
          entry: 'src/App.jsx',
        }),
      },
    );

    assert.equal(res.status, 400);
    assert.deepEqual(await res.json(), {
      code: 'bad_request',
      message:
        'react bundle inline compile input upload must use a streaming content type',
    });
  });
});

void test('react bundle inline compile route reuses the same generated entryUrl for identical input', async () => {
  await withGeneratedRootEnv(async () => {
    await withAuthenticatedDaemonServer(async ({ port }) => {
      const requestBody = {
        renderer: 'react_bundle',
        input: {
          files: {
            'src/App.jsx':
              'export default function App() { return <div>heart</div>; }',
          },
          entry: 'src/App.jsx',
        },
      };

      const firstRes = await fetch(
        `http://127.0.0.1:${port}/api/react-bundle-inline-compile`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...authHeaders(),
          },
          body: JSON.stringify(requestBody),
        },
      );
      const secondRes = await fetch(
        `http://127.0.0.1:${port}/api/react-bundle-inline-compile`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...authHeaders(),
          },
          body: JSON.stringify(requestBody),
        },
      );

      const firstBody = (await firstRes.json()) as unknown;
      const secondBody = (await secondRes.json()) as unknown;
      assert.equal(isReactBundleInlineCompileResponse(firstBody), true);
      assert.equal(isReactBundleInlineCompileResponse(secondBody), true);
      assert.deepEqual(secondBody, firstBody);
    });
  });
});

void test('react bundle inline compile route accepts common src/main.jsx bootstrap entries', async () => {
  await withGeneratedRootEnv(async () => {
    await withAuthenticatedDaemonServer(async ({ port }) => {
      const res = await fetch(
        `http://127.0.0.1:${port}/api/react-bundle-inline-compile`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...authHeaders(),
          },
          body: JSON.stringify({
            renderer: 'react_bundle',
            input: {
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
            },
          }),
        },
      );

      assert.equal(res.status, 200);
      const body = (await res.json()) as unknown;
      assertReactBundleInlineCompileResponse(body);
      assert.equal(body.ok, true);
      if (!body.ok) {
        return;
      }

      const entryRes = await fetch(body.manifest.entryUrl);
      assert.equal(entryRes.status, 200);
      const entrySource = await entryRes.text();
      assert.match(entrySource, /geulbat_inline_entry_wrapper_default/);
    });
  });
});

void test('react bundle inline compile route returns sanitize_rejected for invalid inline source input', async () => {
  await withGeneratedRootEnv(async () => {
    await withAuthenticatedDaemonServer(async ({ port }) => {
      const res = await fetch(
        `http://127.0.0.1:${port}/api/react-bundle-inline-compile`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...authHeaders(),
          },
          body: JSON.stringify({
            renderer: 'react_bundle',
            input: {
              files: {
                '../App.jsx': 'export default function App() { return null; }',
              },
              entry: '../App.jsx',
            },
          }),
        },
      );

      assert.equal(res.status, 200);
      const body = (await res.json()) as unknown;
      assertReactBundleInlineCompileResponse(body);
      assert.deepEqual(body, {
        ok: false,
        code: 'sanitize_rejected',
        detail:
          'react bundle inline source path ../App.jsx must not escape its root',
      });
    });
  });
});

void test('react bundle inline compile route rejects unsupported bare imports with sanitize_rejected', async () => {
  await withGeneratedRootEnv(async () => {
    await withAuthenticatedDaemonServer(async ({ port }) => {
      const res = await fetch(
        `http://127.0.0.1:${port}/api/react-bundle-inline-compile`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...authHeaders(),
          },
          body: JSON.stringify({
            renderer: 'react_bundle',
            input: {
              files: {
                'src/App.jsx': [
                  "import thing from 'left-pad';",
                  'export default function App() {',
                  '  return <div>{thing}</div>;',
                  '}',
                ].join('\n'),
              },
              entry: 'src/App.jsx',
            },
          }),
        },
      );

      const body = (await res.json()) as unknown;
      assertReactBundleInlineCompileResponse(body);
      assert.deepEqual(body, {
        ok: false,
        code: 'sanitize_rejected',
        detail:
          'react bundle inline source import "left-pad" is unsupported; only relative imports and pinned react runtime shims are allowed',
      });
    });
  });
});

void test('react bundle inline compile route rejects remote absolute imports with sanitize_rejected', async () => {
  await withGeneratedRootEnv(async () => {
    await withAuthenticatedDaemonServer(async ({ port }) => {
      const res = await fetch(
        `http://127.0.0.1:${port}/api/react-bundle-inline-compile`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...authHeaders(),
          },
          body: JSON.stringify({
            renderer: 'react_bundle',
            input: {
              files: {
                'src/App.jsx': [
                  "import remote from 'https://cdn.example.com/widget.js';",
                  'export default function App() {',
                  '  return <div>{remote}</div>;',
                  '}',
                ].join('\n'),
              },
              entry: 'src/App.jsx',
            },
          }),
        },
      );

      const body = (await res.json()) as unknown;
      assertReactBundleInlineCompileResponse(body);
      assert.deepEqual(body, {
        ok: false,
        code: 'sanitize_rejected',
        detail:
          'react bundle inline source import "https://cdn.example.com/widget.js" is unsupported; only relative imports and pinned react runtime shims are allowed',
      });
    });
  });
});

void test('react bundle inline generated asset route rejects encoded traversal paths before filesystem lookup', async () => {
  await withGeneratedRootEnv(async (tempRoot) => {
    await writeFile(
      path.join(tempRoot, 'cache%5C..%5C..%5Csecret.js'),
      'backslash traversal should not be served',
    );
    await writeFile(
      path.join(tempRoot, 'cache%2F..%2Fsecret.js'),
      'slash traversal should not be served',
    );

    await withAuthenticatedDaemonServer(async ({ port }) => {
      const backslashRes = await fetch(
        `http://127.0.0.1:${port}/public-generated/react-bundle-inline/cache%5C..%5C..%5Csecret.js`,
      );
      const slashRes = await fetch(
        `http://127.0.0.1:${port}/public-generated/react-bundle-inline/cache%2F..%2Fsecret.js`,
      );
      const nulRes = await fetch(
        `http://127.0.0.1:${port}/public-generated/react-bundle-inline/cache%00secret.js`,
      );

      assert.equal(backslashRes.status, 404);
      assert.equal(slashRes.status, 404);
      assert.equal(nulRes.status, 404);
    });
  });
});

async function withGeneratedRootEnv(
  run: (tempRoot: string) => Promise<void>,
): Promise<void> {
  const tempRoot = await mkdtemp(
    path.join(os.tmpdir(), 'geulbat-react-bundle-inline-'),
  );
  const previous = process.env[GENERATED_ROOT_ENV];
  process.env[GENERATED_ROOT_ENV] = tempRoot;
  try {
    await run(tempRoot);
  } finally {
    if (previous === undefined) {
      delete process.env[GENERATED_ROOT_ENV];
    } else {
      process.env[GENERATED_ROOT_ENV] = previous;
    }
    await rm(tempRoot, { recursive: true, force: true });
  }
}
