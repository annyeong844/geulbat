import { createHash } from 'node:crypto';

import {
  PTC_SESSION_DOCKER_SDK_CONTAINER_ROOT,
  PTC_SESSION_DOCKER_SDK_PROJECTION_MOUNT_POLICY_ID,
  resolvePtcExecuteCodeWriteCallbackConfigFromEnv,
  type PtcExecuteCodeRuntimeSdkHelp,
  type PtcExecuteCodeRuntimeSdkProjection,
  type PtcExecuteCodeRuntimeToolCallbackHandler,
} from '../../ptc/runtime/execute-code/execute-code-runtime-contract.js';
import { getErrorMessage } from '@geulbat/shared-utils/error';
import { resolveToolLibraryProjectionMountedModule } from '../tool-library-projection-mount.js';
import { resolveRuntimeSideEffectLevel } from '../approval-runtime-policy.js';
import type { ToolExecutionContext } from '../types.js';
import {
  resolvePtcExecuteCodeCallbackToolSurface,
  type PtcExecuteCodeCallbackToolSurface,
} from './ptc-callback-tool-surface.js';

export interface PtcExecuteCodeCallbackBreakdown {
  readCalls: number;
  writeCalls: number;
  // Approval outcomes: granted covers both full_access auto-approval and W2
  // interactive grants; denied counts explicit user denials. Aborted waits
  // count only as writeCalls.
  writeGranted: number;
  writeDenied: number;
}

export function createPtcExecuteCodeCallbackBreakdown(): PtcExecuteCodeCallbackBreakdown {
  return {
    readCalls: 0,
    writeCalls: 0,
    writeGranted: 0,
    writeDenied: 0,
  };
}

export function createPtcExecuteCodeToolCallbackSurface(
  ctx: ToolExecutionContext,
): PtcExecuteCodeCallbackToolSurface | undefined {
  const registry = ctx.agentSpawnRuntime?.toolRegistry;
  if (registry === undefined) {
    return undefined;
  }

  return resolvePtcExecuteCodeCallbackToolSurface({
    registry,
    ...(ctx.allowedRegistryNames !== undefined
      ? { allowedRegistryNames: ctx.allowedRegistryNames }
      : {}),
    writeCallbackEnabled:
      resolvePtcExecuteCodeWriteCallbackConfigFromEnv().enabled,
  });
}

export function createPtcExecuteCodeToolCallbackHandler(
  ctx: ToolExecutionContext,
  surface:
    | PtcExecuteCodeCallbackToolSurface
    | undefined = createPtcExecuteCodeToolCallbackSurface(ctx),
  breakdown?: PtcExecuteCodeCallbackBreakdown,
): PtcExecuteCodeRuntimeToolCallbackHandler | undefined {
  const registry = ctx.agentSpawnRuntime?.toolRegistry;
  if (registry === undefined || surface === undefined) {
    return undefined;
  }
  const dispatcher = ctx.callbackToolDispatcher;

  return async (invocation) => {
    const meta = registry.getToolMeta(invocation.toolName);
    if (meta === null) {
      return {
        ok: false,
        errorCode: 'ptc_tool_unknown',
        message: 'PTC execute_code callback requested an unknown tool',
      };
    }
    if (!surface.allows(invocation.toolName)) {
      return {
        ok: false,
        errorCode: 'ptc_tool_not_callable',
        message: surface.writeTierEnabled
          ? 'PTC execute_code callback can only call tools admitted by the callback tool surface'
          : 'PTC execute_code callback can only call read-only no-approval non-orchestration tools',
      };
    }
    const isWriteCallback = surface.allowsWrite(invocation.toolName);
    if (isWriteCallback) {
      // Tool-name admission and operation-level rejection are separate rules:
      // manage_files stays discoverable while a delete operation escalates to
      // destructive at runtime and is refused before preflight/execution.
      const runtimeSideEffectLevel = resolveRuntimeSideEffectLevel(
        invocation.toolName,
        invocation.args,
        { toolRegistry: registry },
      );
      if (runtimeSideEffectLevel !== 'write') {
        return {
          ok: false,
          errorCode: 'ptc_tool_not_callable',
          message:
            'PTC execute_code callback cannot run destructive operations',
        };
      }
    }
    if (dispatcher === undefined) {
      return {
        ok: false,
        errorCode: 'ptc_tool_dispatch_unavailable',
        message: 'PTC execute_code callback dispatcher is unavailable',
      };
    }
    if (invocation.enterLongWait?.() === false) {
      return {
        ok: false,
        errorCode: 'ptc_tool_callback_watchdog_elapsed',
        message: 'PTC execute_code callback admission watchdog already elapsed',
      };
    }

    if (breakdown !== undefined) {
      if (isWriteCallback) {
        breakdown.writeCalls += 1;
      } else {
        breakdown.readCalls += 1;
      }
    }
    try {
      const result = await dispatcher.dispatch({
        toolName: invocation.toolName,
        args: invocation.args,
        runtimeToolCallId: invocation.requestId,
        ...(invocation.cellId !== undefined
          ? { cellId: invocation.cellId }
          : {}),
        signal: invocation.signal,
      });
      if (breakdown !== undefined && isWriteCallback) {
        if (result.ok) {
          breakdown.writeGranted += 1;
        } else if (result.errorCode === 'approval_denied') {
          breakdown.writeDenied += 1;
        }
      }
      return { ok: true, result };
    } catch (error) {
      return {
        ok: false,
        errorCode: 'ptc_tool_dispatch_failed',
        message: getErrorMessage(error),
      };
    }
  };
}

export function createPtcExecuteCodeToolCallbackHelp(
  ctx: ToolExecutionContext,
  surface:
    | PtcExecuteCodeCallbackToolSurface
    | undefined = createPtcExecuteCodeToolCallbackSurface(ctx),
): PtcExecuteCodeRuntimeSdkHelp | undefined {
  if (surface === undefined || ctx.callbackToolDispatcher === undefined) {
    return undefined;
  }

  return { callbackTools: surface.callbackTools };
}

export async function resolvePtcExecuteCodeToolSdkProjection(
  ctx: ToolExecutionContext,
  surface:
    | PtcExecuteCodeCallbackToolSurface
    | undefined = createPtcExecuteCodeToolCallbackSurface(ctx),
): Promise<
  | { ok: true; projection?: PtcExecuteCodeRuntimeSdkProjection }
  | { ok: false; message: string }
> {
  const identity = ctx.toolLibraryProjectionIdentity;
  if (identity === undefined) {
    return { ok: true };
  }
  const projectionPort = ctx.agentSpawnRuntime?.toolLibraryProjection;
  const threadId = ctx.threadId;
  const stateRoot = ctx.stateRoot;
  if (
    projectionPort === undefined ||
    surface === undefined ||
    threadId === undefined ||
    stateRoot === undefined ||
    ctx.callbackToolDispatcher === undefined
  ) {
    return {
      ok: false,
      message: 'The pinned PTC SDK projection runtime is unavailable',
    };
  }

  try {
    const result = await projectionPort.rehydrateProjectionMount({
      stateRoot,
      threadId,
      expectedIdentity: identity,
    });
    if (!result.ok) {
      return {
        ok: false,
        message: 'The pinned PTC SDK projection could not be rehydrated',
      };
    }
    // A live policy change may revoke a pinned wrapper without mutating the
    // thread's SDK bytes. Loading the module grants no authority: the callback
    // handler above rechecks the current surface on every invocation.
    const modules: PtcExecuteCodeRuntimeSdkProjection['modules'][number][] = [];
    const manifestFile = result.projection.files.find(
      (file) => file.role === 'manifest',
    );
    if (manifestFile === undefined) {
      return {
        ok: false,
        message: 'The pinned PTC SDK manifest is unavailable',
      };
    }
    for (const tool of result.projection.tools) {
      const mountedModule = resolveToolLibraryProjectionMountedModule({
        mount: result.mount,
        specifier: tool.wrapperImportSpecifier,
      });
      const generatedFile = result.projection.files.find(
        (file) => file.path === tool.wrapperModule && file.role === 'wrapper',
      );
      if (
        !mountedModule.ok ||
        mountedModule.module.role !== 'wrapper' ||
        generatedFile === undefined
      ) {
        return {
          ok: false,
          message: 'A pinned PTC SDK wrapper is unavailable',
        };
      }
      modules.push({
        specifier: mountedModule.module.specifier,
        exportName: tool.wrapperExportName,
        modulePath: generatedFile.path,
        sourceHash: `sha256:${createHash('sha256')
          .update(generatedFile.content, 'utf8')
          .digest('hex')}`,
      });
    }
    return {
      ok: true,
      projection: {
        sdkVersion: result.pin.sdkVersion,
        sdkProjectionHash: result.pin.sdkProjectionHash,
        policyId: result.pin.policyId,
        runtimeCompatibilityRange: result.pin.runtimeCompatibilityRange,
        importSpecifier: result.pin.importSpecifier,
        manifestModule: manifestFile.path,
        manifestSourceHash: `sha256:${createHash('sha256')
          .update(manifestFile.content, 'utf8')
          .digest('hex')}`,
        mount: {
          hostRootPath: result.mount.projectionRootPath,
          containerRootPath: PTC_SESSION_DOCKER_SDK_CONTAINER_ROOT,
          mountPolicyId: PTC_SESSION_DOCKER_SDK_PROJECTION_MOUNT_POLICY_ID,
          sdkVersion: result.pin.sdkVersion,
          sdkProjectionHash: result.pin.sdkProjectionHash,
          policyId: result.pin.policyId,
          importSpecifier: result.pin.importSpecifier,
        },
        modules,
      },
    };
  } catch {
    return {
      ok: false,
      message: 'The pinned PTC SDK projection could not be rehydrated',
    };
  }
}
