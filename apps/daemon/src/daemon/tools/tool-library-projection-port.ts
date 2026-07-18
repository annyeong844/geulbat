import type {
  ToolLibraryProjectionIdentity,
  ToolLibraryProjectionImportableModule,
  ToolLibraryProjectionPin,
} from '@geulbat/tool-library/projection-codec';
import type {
  ToolLibraryProjectionFile,
  ToolLibraryProjectionGeneratedTool,
} from '@geulbat/tool-library/projection-descriptor';
import type { ToolLibraryProjectionMount } from './tool-library-projection-mount.js';
import type { ReadVerifiedToolLibraryProjectionMountResult } from './tool-library-projection-store.js';
import type { ToolRegistryStore } from './tool-registry-model.js';

export interface BuildToolLibraryProjectionArgs {
  registry: Pick<ToolRegistryStore, 'getAllRegisteredToolNames' | 'getTool'>;
  allowedRegistryNames: readonly string[];
  sdkVersion: string;
  sourceRegistryVersion: string;
  policyId: string;
  runtimeCompatibilityRange: string;
  rootPath: string;
  catalogPath: string;
  modelFacingCatalogRef: string;
  importSpecifier: string;
}

interface ResolveToolLibraryProjectionArgs {
  stateRoot: string;
  threadId: string;
  allowedRegistryNames?: readonly string[];
}

type ResolveToolLibraryProjectionPortResult =
  | {
      ok: true;
      mount: ToolLibraryProjectionMount;
      pin: ToolLibraryProjectionPin;
      prunedProjectionDirectories: readonly string[];
      projectionPruneFailedDirectories: readonly string[];
      projection: ToolLibraryProjection;
      writtenFiles: readonly string[];
    }
  | ToolLibraryProjectionFailureResult;

type RehydrateToolLibraryProjectionMountResult =
  | (Extract<ReadVerifiedToolLibraryProjectionMountResult, { ok: true }> & {
      projection: ToolLibraryProjection;
    })
  | Exclude<ReadVerifiedToolLibraryProjectionMountResult, { ok: true }>
  | ToolLibraryProjectionFailureResult;

export interface ToolLibraryProjectionFailureDiagnostics {
  errorCode?: string;
  errorName?: string;
}

export interface ToolLibraryProjectionFailureResult {
  ok: false;
  reason: 'projection_failed';
  message: string;
  diagnostics?: ToolLibraryProjectionFailureDiagnostics;
}

export interface ToolLibraryProjectionPort {
  resolveProjection(
    args: ResolveToolLibraryProjectionArgs,
  ): Promise<ResolveToolLibraryProjectionPortResult>;
  rehydrateProjectionMount(args: {
    stateRoot: string;
    threadId: string;
    expectedIdentity: ToolLibraryProjectionIdentity;
  }): Promise<RehydrateToolLibraryProjectionMountResult>;
}

export interface ToolLibraryProjection {
  sdkVersion: string;
  sdkProjectionHash: `sha256:${string}`;
  sourceRegistryVersion: string;
  policyId: string;
  runtimeCompatibilityRange: string;
  rootPath: string;
  catalogPath: string;
  modelFacingCatalogRef: string;
  importSpecifier: string;
  allowedPublicNames: readonly string[];
  allowedRegistryNames: readonly string[];
  allowedCallbackNames: readonly string[];
  importableModules: readonly ToolLibraryProjectionImportableModule[];
  tools: readonly ToolLibraryProjectionGeneratedTool[];
  files: readonly ToolLibraryProjectionFile[];
}
