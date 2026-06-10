import test from 'node:test';
import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const WEB_SHELL_ROOT = fileURLToPath(new URL('../../../..', import.meta.url));

const ARTIFACT_RUNTIME_PREVIEW_FILES = [
  'src/features/artifacts/runtime-preview/types.ts',
  'src/features/artifacts/runtime-preview/preview-surface-result.ts',
  'src/features/artifacts/runtime-preview/renderer-dispatch.ts',
  'src/features/artifacts/runtime-preview/html/document.ts',
  'src/features/artifacts/runtime-preview/html/preview.tsx',
  'src/features/artifacts/runtime-preview/js/document-source.ts',
  'src/features/artifacts/runtime-preview/js/document.ts',
  'src/features/artifacts/runtime-preview/js/document.asset.html',
  'src/features/artifacts/runtime-preview/js/preview.tsx',
  'src/features/artifacts/runtime-preview/js/root.ts',
  'src/features/artifacts/runtime-preview/react-bundle/document.ts',
  'src/features/artifacts/runtime-preview/react-bundle/inline-compile-preview-model.ts',
  'src/features/artifacts/runtime-preview/react-bundle/preview.tsx',
  'src/features/artifacts/runtime-preview/react-bundle/use-inline-compile-preview-surface.ts',
  'src/features/artifacts/runtime-preview/react-bundle/runtime-module-sources.js',
  'src/features/artifacts/runtime-preview/react-bundle/runtime-module-sources.d.ts',
];

const ARTIFACT_RUNTIME_PREVIEW_SOURCE_FILES =
  ARTIFACT_RUNTIME_PREVIEW_FILES.filter(
    (relativePath) => !relativePath.endsWith('.d.ts'),
  );

const FORMER_ASSISTANT_RUNTIME_PREVIEW_FILES = [
  'src/features/assistant/artifacts/html/document.ts',
  'src/features/assistant/artifacts/html/preview.tsx',
  'src/features/assistant/artifacts/js/document-source.ts',
  'src/features/assistant/artifacts/js/document.ts',
  'src/features/assistant/artifacts/js/runtime.tsx',
  'src/features/assistant/artifacts/react-bundle/document.ts',
  'src/features/assistant/artifacts/react-bundle/runtime.tsx',
  'src/features/assistant/artifacts/react-bundle/runtime-module-sources.js',
  'src/features/assistant/artifacts/react-bundle/runtime-module-sources.d.ts',
  'src/features/assistant/runtime-frame/artifact-react-bundle-inline-compile-preview-surface.ts',
];

const RUNTIME_PREVIEW_SMOKE_SCRIPT_FILES = [
  'scripts/public-web-conformance-smoke.mjs',
  'scripts/react-bundle-smoke.mjs',
];

void test('runtime preview implementation is artifact-owned without assistant imports', async () => {
  for (const relativePath of ARTIFACT_RUNTIME_PREVIEW_FILES) {
    assert.equal(
      await pathExists(relativePath),
      true,
      `${relativePath} should be artifact-owned`,
    );
  }

  for (const relativePath of FORMER_ASSISTANT_RUNTIME_PREVIEW_FILES) {
    assert.equal(
      await pathExists(relativePath),
      false,
      `${relativePath} should not keep runtime preview ownership in assistant`,
    );
  }

  const artifactRuntimeSource = await readSourceFiles(
    ARTIFACT_RUNTIME_PREVIEW_SOURCE_FILES,
  );

  assert.doesNotMatch(
    artifactRuntimeSource,
    /features\/assistant|\.\.\/.*assistant/u,
  );
});

void test('runtime preview smoke scripts do not import former assistant artifact owners', async () => {
  const smokeScriptSource = await readSourceFiles(
    RUNTIME_PREVIEW_SMOKE_SCRIPT_FILES,
  );

  assert.doesNotMatch(smokeScriptSource, /features\/assistant\/artifacts\//u);
});

async function readSourceFiles(
  relativePaths: readonly string[],
): Promise<string> {
  const sources = await Promise.all(
    relativePaths.map((relativePath) =>
      readFile(resolveAppPath(relativePath), 'utf8'),
    ),
  );

  return sources.join('\n');
}

async function pathExists(relativePath: string): Promise<boolean> {
  try {
    await access(resolveAppPath(relativePath));
    return true;
  } catch {
    return false;
  }
}

function resolveAppPath(relativePath: string): string {
  return path.join(WEB_SHELL_ROOT, relativePath);
}
