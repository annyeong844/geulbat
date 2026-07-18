import { getToolLibraryProjectionIdentity } from '../tools/tool-library-projection-manifest.js';
import type {
  ToolLibraryProjectionFailureDiagnostics,
  ToolLibraryProjectionPort,
} from '../tools/tool-library-projection-port.js';

interface ResolveAgentLoopToolLibraryProjectionArgs {
  stateRoot: string;
  threadId: string;
  allowedRegistryNames?: readonly string[];
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
