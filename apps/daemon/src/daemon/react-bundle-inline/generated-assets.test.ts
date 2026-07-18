import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { OutputFile } from 'esbuild';

import {
  GENERATED_ROOT_ENV,
  buildGeneratedReactBundleInlineManifest,
  readGeneratedReactBundleInlineAsset,
  readGeneratedReactBundleInlineManifest,
  writeGeneratedReactBundleInlineOutput,
} from './generated-assets.js';

void test('generated react bundle manifest is present only after entry output exists', async () => {
  await withGeneratedRootEnv(async (tempRoot) => {
    await writeGeneratedReactBundleInlineOutput({
      cacheKey: 'cache-without-entry',
      outputFiles: [
        createOutputFile('/out/chunks/chunk-ONLY.js', 'export default 0;'),
      ],
    });
    assert.equal(
      await readGeneratedReactBundleInlineManifest({
        cacheKey: 'cache-without-entry',
        requestOrigin: 'http://127.0.0.1:5173',
      }),
      null,
    );

    const cacheKey = 'cache-entry-marker';
    await writeGeneratedReactBundleInlineOutput({
      cacheKey,
      outputFiles: [
        createOutputFile('/out/entry.js', 'export default 1;'),
        createOutputFile('/out/chunks/chunk-ABC.js', 'export default 2;'),
      ],
    });

    assert.equal(
      await readFile(
        path.join(tempRoot, cacheKey, 'chunks', 'chunk-ABC.js'),
        'utf8',
      ),
      'export default 2;',
    );
    assert.deepEqual(
      await readGeneratedReactBundleInlineManifest({
        cacheKey,
        requestOrigin: 'http://127.0.0.1:5173',
      }),
      buildGeneratedReactBundleInlineManifest({
        cacheKey,
        requestOrigin: 'http://127.0.0.1:5173',
      }),
    );
  });
});

void test('generated react bundle asset reads written bytes and treats a missing file as absent', async () => {
  await withGeneratedRootEnv(async () => {
    const cacheKey = 'cache-asset-read';
    const entrySource = 'export default 3;';
    await writeGeneratedReactBundleInlineOutput({
      cacheKey,
      outputFiles: [createOutputFile('/out/entry.js', entrySource)],
    });

    const manifest = buildGeneratedReactBundleInlineManifest({
      cacheKey,
      requestOrigin: 'http://127.0.0.1:5173',
    });
    const entryPathname = new URL(manifest.entryUrl).pathname;
    const asset = await readGeneratedReactBundleInlineAsset(entryPathname);
    assert.equal(asset?.contentType, 'application/javascript; charset=utf-8');
    assert.equal(asset?.body.toString('utf8'), entrySource);
    assert.equal(
      await readGeneratedReactBundleInlineAsset(
        entryPathname.replace('/entry.js', '/missing.js'),
      ),
      null,
    );
  });
});

void test('generated react bundle output rejects paths outside the esbuild outdir', async () => {
  await withGeneratedRootEnv(async (tempRoot) => {
    await assert.rejects(
      () =>
        writeGeneratedReactBundleInlineOutput({
          cacheKey: 'cache-output-escape',
          outputFiles: [
            createOutputFile('/outside.js', 'should not be written'),
          ],
        }),
      /outside generated cache/,
    );

    await assert.rejects(
      () => readFile(path.join(tempRoot, 'outside.js'), 'utf8'),
      (error: unknown) =>
        (error as NodeJS.ErrnoException | null)?.code === 'ENOENT',
    );
  });
});

function createOutputFile(filePath: string, contents: string): OutputFile {
  const encodedContents = new TextEncoder().encode(contents);
  return {
    path: filePath,
    contents: encodedContents,
    hash: '',
    get text() {
      return new TextDecoder().decode(encodedContents);
    },
  };
}

async function withGeneratedRootEnv(
  run: (tempRoot: string) => Promise<void>,
): Promise<void> {
  const tempRoot = await mkdtemp(
    path.join(os.tmpdir(), 'geulbat-react-bundle-inline-generated-'),
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
