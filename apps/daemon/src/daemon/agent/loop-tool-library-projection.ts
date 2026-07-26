import { getToolLibraryProjectionIdentity } from '../tools/tool-library-projection-manifest.js';
import {
  createToolCapabilityPolicy,
  type ToolCapabilityPolicy,
} from '@geulbat/tool-library/tool-capability-policy';
import { resolvePtcExecuteCodeCallbackToolSurface } from '../tools/builtin/ptc-callback-tool-surface.js';
import type {
  ToolLibraryProjectionFailureDiagnostics,
  ToolLibraryProjectionPort,
} from '../tools/tool-library-projection-port.js';
import type { ToolRuntimeRegistry } from '../tools/tool-registry-model.js';
import type { AgentToolSurface } from './loop-types.js';

interface ResolveAgentLoopToolLibraryProjectionArgs {
  stateRoot: string;
  threadId: string;
  allowedRegistryNames?: readonly string[];
  toolCapabilityPolicy?: ToolCapabilityPolicy;
}

type ResolveAgentLoopToolLibraryProjectionResult =
  | {
      ok: true;
      identity: ReturnType<typeof getToolLibraryProjectionIdentity>;
    }
  | {
      ok: false;
      message: string;
      diagnostics?: ToolLibraryProjectionFailureDiagnostics;
    };

export interface AgentLoopToolLibraryProjectionPort {
  resolveProjection(
    args: ResolveAgentLoopToolLibraryProjectionArgs,
  ): Promise<ResolveAgentLoopToolLibraryProjectionResult>;
}

export function createAgentToolCapabilityPolicy(args: {
  registry: ToolRuntimeRegistry;
  toolSurface?: AgentToolSurface;
}): ToolCapabilityPolicy {
  const allowedRegistryNames =
    args.toolSurface?.allowedRegistryNames ??
    args.registry.buildToolDefinitions().map((tool) => tool.name);
  const directRegistryNames =
    args.toolSurface?.directRegistryNames ?? allowedRegistryNames;
  const callbackRegistryNames = resolvePtcExecuteCodeCallbackToolSurface({
    registry: args.registry,
    allowedRegistryNames,
    writeCallbackEnabled: false,
  }).callbackTools.map((tool) => tool.name);
  return createToolCapabilityPolicy({
    directRegistryNames,
    allowedRegistryNames,
    callbackRegistryNames,
    writeCallbackEnabled: false,
  });
}

export function createAgentLoopToolLibraryProjectionPort(
  projectionPort: Pick<ToolLibraryProjectionPort, 'resolveProjection'>,
): AgentLoopToolLibraryProjectionPort {
  return {
    async resolveProjection(args) {
      const result = await projectionPort.resolveProjection({
        stateRoot: args.stateRoot,
        threadId: args.threadId,
        ...(args.allowedRegistryNames === undefined
          ? {}
          : { allowedRegistryNames: args.allowedRegistryNames }),
        ...(args.toolCapabilityPolicy === undefined
          ? {}
          : { toolCapabilityPolicy: args.toolCapabilityPolicy }),
      });
      if (!result.ok) {
        return {
          ok: false,
          message: result.message,
          ...(result.diagnostics === undefined
            ? {}
            : { diagnostics: result.diagnostics }),
        };
      }
      return {
        ok: true,
        identity: getToolLibraryProjectionIdentity(result.pin),
      };
    },
  };
}

export function formatToolLibraryProjectionFailureMessage(args: {
  message: string;
  diagnostics?: ToolLibraryProjectionFailureDiagnostics;
}): string {
  const parts = [
    args.diagnostics?.errorName,
    args.diagnostics?.errorCode,
  ].filter((part): part is string => part !== undefined);
  return parts.length === 0
    ? args.message
    : `${args.message} (${parts.join(' ')})`;
}
