import { access } from 'node:fs/promises';
import { join } from 'node:path';

import { createBuiltinToolRegistryStore } from '../daemon/tools/builtin/catalog.js';
import { createToolLibraryProjectionPort } from '../daemon/tools/tool-library-projection.js';

export const BASE_PROJECTION_ARGS = {
  sdkVersion: 'sdk-test-v1',
  sourceRegistryVersion: 'registry-test-v1',
  policyId: 'test-readonly-policy',
  runtimeCompatibilityRange: 'daemon-test-runtime',
  rootPath: '/private/geulbat/generated-tools',
  catalogPath: '/private/geulbat/generated-tools/catalog.js',
  modelFacingCatalogRef: 'geulbat-sdk://catalog',
  importSpecifier: '@geulbat/generated-tools',
} as const;

export function createTestProjectionPort(
  overrides: Partial<
    Pick<
      Parameters<typeof createToolLibraryProjectionPort>[0],
      'registry' | 'runtimeRootForState' | 'projectionPolicy'
    >
  > = {},
) {
  return createToolLibraryProjectionPort({
    registry: createBuiltinToolRegistryStore(),
    runtimeRootForState(root) {
      return join(root, '.geulbat', 'tool-library', 'projections');
    },
    sdkVersion: BASE_PROJECTION_ARGS.sdkVersion,
    sourceRegistryVersion: BASE_PROJECTION_ARGS.sourceRegistryVersion,
    runtimeCompatibilityRange: BASE_PROJECTION_ARGS.runtimeCompatibilityRange,
    modelFacingCatalogRef: BASE_PROJECTION_ARGS.modelFacingCatalogRef,
    importSpecifier: BASE_PROJECTION_ARGS.importSpecifier,
    ...overrides,
  });
}

export async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
