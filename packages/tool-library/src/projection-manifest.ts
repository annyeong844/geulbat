import type {
  ToolLibraryProjectionIdentity,
  ToolLibraryProjectionManifest,
  ToolLibraryProjectionPin,
} from './projection-codec.js';
import {
  TOOL_LIBRARY_PROJECTION_INDEX_MODULE,
  TOOL_LIBRARY_PROJECTION_SEARCH_RUNTIME_MODULE,
} from './projection-modules.js';

export type ToolLibraryProjectionManifestSource = Pick<
  ToolLibraryProjectionManifest,
  | 'allowedCallbackNames'
  | 'allowedPublicNames'
  | 'allowedRegistryNames'
  | 'importSpecifier'
  | 'importableModules'
  | 'modelFacingCatalogRef'
  | 'policyId'
  | 'runtimeCompatibilityRange'
  | 'sdkProjectionHash'
  | 'sdkVersion'
  | 'sourceRegistryVersion'
>;

export function getToolLibraryProjectionManifest(
  projection: ToolLibraryProjectionManifestSource,
): ToolLibraryProjectionManifest {
  return {
    sdkVersion: projection.sdkVersion,
    sdkProjectionHash: projection.sdkProjectionHash,
    sourceRegistryVersion: projection.sourceRegistryVersion,
    policyId: projection.policyId,
    runtimeCompatibilityRange: projection.runtimeCompatibilityRange,
    modelFacingCatalogRef: projection.modelFacingCatalogRef,
    importSpecifier: projection.importSpecifier,
    catalogModule: 'catalog.js',
    searchModule: 'search.js',
    searchRuntimeModule: TOOL_LIBRARY_PROJECTION_SEARCH_RUNTIME_MODULE,
    indexDeclarationModule: `${TOOL_LIBRARY_PROJECTION_INDEX_MODULE.slice(
      0,
      -'.js'.length,
    )}.d.ts`,
    allowedPublicNames: projection.allowedPublicNames,
    allowedRegistryNames: projection.allowedRegistryNames,
    allowedCallbackNames: projection.allowedCallbackNames,
    importableModules: projection.importableModules,
  };
}

export function getToolLibraryProjectionPin(
  projection: ToolLibraryProjectionManifestSource,
): ToolLibraryProjectionPin {
  return {
    ...getToolLibraryProjectionManifest(projection),
    projectionDirectory: projectionDirectoryNameForHash(
      projection.sdkProjectionHash,
    ),
  };
}

export function getToolLibraryProjectionIdentity(
  projection: ToolLibraryProjectionIdentity,
): ToolLibraryProjectionIdentity {
  return {
    sdkVersion: projection.sdkVersion,
    sdkProjectionHash: projection.sdkProjectionHash,
    policyId: projection.policyId,
  };
}

export function projectionDirectoryNameForHash(
  hash: `sha256:${string}`,
): string {
  return hash.replace(':', '-');
}
