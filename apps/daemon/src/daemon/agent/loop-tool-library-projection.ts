import { getToolLibraryProjectionIdentity } from '@geulbat/tool-library/projection-manifest';
import type { ToolLibraryProjectionIdentity } from '@geulbat/tool-library/projection-codec';
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
import { createAgentLoopToolDefinitionPort } from './loop-tool-definitions.js';
import type { AgentToolSurface } from './loop-types.js';

interface ResolveAgentLoopToolLibraryProjectionArgs {
  stateRoot: string;
  threadId: string;
  allowedRegistryNames?: readonly string[];
  toolCapabilityPolicy?: ToolCapabilityPolicy;
  expectedIdentity?: ToolLibraryProjectionIdentity;
}

type ResolveAgentLoopToolLibraryProjectionResult =
  | {
      ok: true;
      identity: ToolLibraryProjectionIdentity;
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
    args.toolSurface?.directRegistryNames ??
    createAgentLoopToolDefinitionPort(args.registry)
      .buildToolDefinitions({})
      .map((tool) => tool.name);
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
  projectionPort: Pick<
    ToolLibraryProjectionPort,
    'resolveProjection' | 'rehydrateProjectionMount'
  >,
): AgentLoopToolLibraryProjectionPort {
  return {
    async resolveProjection(args) {
      if (
        args.expectedIdentity !== undefined &&
        args.toolCapabilityPolicy !== undefined &&
        args.expectedIdentity.policyId !==
          args.toolCapabilityPolicy.toolCapabilityPolicyId
      ) {
        return {
          ok: false,
          message:
            'Recorded tool library projection identity does not match the run capability policy',
        };
      }
      const result =
        args.expectedIdentity === undefined
          ? await projectionPort.resolveProjection({
              stateRoot: args.stateRoot,
              threadId: args.threadId,
              ...(args.allowedRegistryNames === undefined
                ? {}
                : { allowedRegistryNames: args.allowedRegistryNames }),
              ...(args.toolCapabilityPolicy === undefined
                ? {}
                : { toolCapabilityPolicy: args.toolCapabilityPolicy }),
            })
          : await projectionPort.rehydrateProjectionMount({
              stateRoot: args.stateRoot,
              threadId: args.threadId,
              expectedIdentity: args.expectedIdentity,
            });
      if (!result.ok) {
        const diagnostics =
          'diagnostics' in result ? result.diagnostics : undefined;
        return {
          ok: false,
          message: result.message,
          ...(diagnostics === undefined ? {} : { diagnostics }),
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
