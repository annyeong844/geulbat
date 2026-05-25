import test from 'node:test';
import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const WEB_SHELL_ROOT = fileURLToPath(
  new URL('../../../../..', import.meta.url),
);

const ARTIFACT_REACT_BUNDLE_RUNTIME_FILES = [
  'src/features/artifacts/runtime-preview/react-bundle/document.ts',
  'src/features/artifacts/runtime-preview/react-bundle/preview.tsx',
  'src/features/artifacts/runtime-preview/react-bundle/runtime-module-sources.js',
  'src/features/artifacts/runtime-preview/react-bundle/runtime-module-sources.d.ts',
];

const FORMER_ASSISTANT_REACT_BUNDLE_RUNTIME_FILES = [
  'src/features/assistant/artifacts/react-bundle/document.ts',
  'src/features/assistant/artifacts/react-bundle/runtime.tsx',
  'src/features/assistant/artifacts/react-bundle/runtime-module-sources.js',
  'src/features/assistant/artifacts/react-bundle/runtime-module-sources.d.ts',
];

void test('react bundle runtime preview implementation is artifact-owned without assistant imports', async () => {
  for (const relativePath of ARTIFACT_REACT_BUNDLE_RUNTIME_FILES) {
    assert.equal(
      await pathExists(relativePath),
      true,
      `${relativePath} should be artifact-owned`,
    );
  }

  for (const relativePath of FORMER_ASSISTANT_REACT_BUNDLE_RUNTIME_FILES) {
    assert.equal(
      await pathExists(relativePath),
      false,
      `${relativePath} should not keep react bundle runtime ownership in assistant`,
    );
  }

  const artifactRuntimeSource = await Promise.all(
    ARTIFACT_REACT_BUNDLE_RUNTIME_FILES.map((relativePath) =>
      relativePath.endsWith('.d.ts')
        ? ''
        : readFile(resolveAppPath(relativePath), 'utf8'),
    ),
  ).then((sources) => sources.join('\n'));

  assert.doesNotMatch(
    artifactRuntimeSource,
    /features\/assistant|\.\.\/.*assistant/u,
  );
});

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
