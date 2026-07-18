import type {
  ToolLibraryProjectionIdentity,
  ToolLibraryProjectionMountedModuleRole,
  ToolLibraryProjectionPin,
} from '@geulbat/tool-library/projection-codec';
import {
  TOOL_LIBRARY_PROJECTION_INDEX_MODULE,
  TOOL_LIBRARY_PROJECTION_MANIFEST_MODULE,
  resolveToolLibraryProjectionFilePath,
} from './tool-library-projection-path.js';

export interface ToolLibraryProjectionMount extends ToolLibraryProjectionIdentity {
  importSpecifier: string;
  modelFacingCatalogRef: string;
  projectionRootPath: string;
  manifestModulePath: string;
  catalogModulePath: string;
  searchModulePath: string;
  searchRuntimeModulePath: string;
  indexModulePath: string;
  indexDeclarationPath: string;
  importableModules: readonly ToolLibraryProjectionMountedModule[];
}

interface ToolLibraryProjectionMountedModule {
  specifier: string;
  filePath: string;
  role: ToolLibraryProjectionMountedModuleRole;
}

type ResolveToolLibraryProjectionMountedModuleResult =
  | {
      ok: true;
      module: ToolLibraryProjectionMountedModule;
    }
  | {
      ok: false;
      reason: 'module_not_mounted';
      message: string;
      specifier: string;
    };

export function getToolLibraryProjectionMount(args: {
  pin: ToolLibraryProjectionPin;
  projectionRootPath: string;
}): ToolLibraryProjectionMount {
  const importableModules = args.pin.importableModules.map((module) => ({
    specifier: module.specifier,
    filePath: resolveToolLibraryProjectionFilePath(
      args.projectionRootPath,
      module.module,
    ),
    role: module.role,
  }));

  return {
    sdkVersion: args.pin.sdkVersion,
    sdkProjectionHash: args.pin.sdkProjectionHash,
    policyId: args.pin.policyId,
    importSpecifier: args.pin.importSpecifier,
    modelFacingCatalogRef: args.pin.modelFacingCatalogRef,
    projectionRootPath: args.projectionRootPath,
    manifestModulePath: resolveToolLibraryProjectionFilePath(
      args.projectionRootPath,
      TOOL_LIBRARY_PROJECTION_MANIFEST_MODULE,
    ),
    catalogModulePath: resolveToolLibraryProjectionFilePath(
      args.projectionRootPath,
      args.pin.catalogModule,
    ),
    searchModulePath: resolveToolLibraryProjectionFilePath(
      args.projectionRootPath,
      args.pin.searchModule,
    ),
    searchRuntimeModulePath: resolveToolLibraryProjectionFilePath(
      args.projectionRootPath,
      args.pin.searchRuntimeModule,
    ),
    indexModulePath: resolveToolLibraryProjectionFilePath(
      args.projectionRootPath,
      TOOL_LIBRARY_PROJECTION_INDEX_MODULE,
    ),
    indexDeclarationPath: resolveToolLibraryProjectionFilePath(
      args.projectionRootPath,
      args.pin.indexDeclarationModule,
    ),
    importableModules,
  };
}

export function resolveToolLibraryProjectionMountedModule(args: {
  mount: ToolLibraryProjectionMount;
  specifier: string;
}): ResolveToolLibraryProjectionMountedModuleResult {
  const mountedModule = resolveOwnedMountedModule(args);
  if (mountedModule === null) {
    return {
      ok: false,
      reason: 'module_not_mounted',
      message: 'Tool library projection module is not mounted',
      specifier: args.specifier,
    };
  }
  return { ok: true, module: mountedModule };
}

function resolveOwnedMountedModule(args: {
  mount: ToolLibraryProjectionMount;
  specifier: string;
}): ToolLibraryProjectionMountedModule | null {
  return (
    args.mount.importableModules.find(
      (module) => module.specifier === args.specifier,
    ) ?? null
  );
}
