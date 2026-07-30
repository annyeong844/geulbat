import { fileURLToPath } from 'node:url';

import { assertThreadId } from '@geulbat/protocol/ids';
import type {
  ToolSdkCredential,
  ToolSdkJsonValue,
  ToolSdkProjectionIdentity,
  ToolSdkPublicTool,
  ToolSdkTransport,
} from '@geulbat/tool-sdk';

import { createDaemonContext, type DaemonContext } from '../context.js';
import { createComputerFileScope } from '../files/computer-file-scope.js';

export interface DaemonToolSdkEmbeddingScope {
  readonly callId: string;
  readonly runId: string;
  readonly threadId: string;
  readonly workingDirectory: string;
}

export interface DaemonToolSdkEmbeddingAuthority<Principal> {
  authenticate(
    credential: ToolSdkCredential,
    options: { signal?: AbortSignal },
  ): Promise<
    | { ok: true; principal: Principal }
    | {
        ok: false;
        code: 'authentication_invalid' | 'authentication_required';
      }
  >;
  authorizeInvocation(options: {
    principal: Principal;
    projection: ToolSdkProjectionIdentity;
    publicTool: ToolSdkPublicTool;
    input: Readonly<Record<string, ToolSdkJsonValue>>;
    signal?: AbortSignal;
  }): Promise<
    | { ok: true; scope: DaemonToolSdkEmbeddingScope }
    | {
        ok: false;
        code: 'approval_denied' | 'approval_required' | 'tool_not_admitted';
      }
  >;
  authorizeOutputRecovery?(options: {
    principal: Principal;
    projection: ToolSdkProjectionIdentity;
    outputRef: string;
    signal?: AbortSignal;
  }): Promise<
    | { ok: true; scope: DaemonToolSdkEmbeddingScope }
    | {
        ok: false;
        code: 'approval_denied' | 'approval_required' | 'tool_not_admitted';
      }
  >;
}

export interface CreateDaemonToolSdkEmbeddingHostOptions<Principal> {
  readonly authority: DaemonToolSdkEmbeddingAuthority<Principal>;
  readonly computerFileRoot: string;
  readonly computerSessionId: string;
  readonly getProjectionIdentity: () => ToolSdkProjectionIdentity;
  readonly stateRoot: string;
}

export interface DaemonToolSdkEmbeddingHost {
  readonly transport: ToolSdkTransport;
  close(): Promise<void>;
}

export function createDaemonToolSdkEmbeddingHost<Principal>(
  options: CreateDaemonToolSdkEmbeddingHostOptions<Principal>,
): DaemonToolSdkEmbeddingHost {
  const computerFileScope = createComputerFileScope({
    root: options.computerFileRoot,
  });
  if (computerFileScope === undefined) {
    throw new Error(
      'Tool SDK embedding host requires an explicit computer file root',
    );
  }
  const daemonContext = createDaemonContext({
    bundledCreatorPluginRoot: fileURLToPath(
      new URL('../../../creator-plugin', import.meta.url),
    ),
    computerFileScope,
    computerSessionId: options.computerSessionId,
    homeStateRoot: options.stateRoot,
  });
  const toExecutionContext = (scope: DaemonToolSdkEmbeddingScope) => ({
    callId: scope.callId,
    computerFileRoot: options.computerFileRoot,
    computerSessionId: options.computerSessionId,
    fileStateCache: daemonContext.fileStateCache,
    memoryIndex: daemonContext.memoryIndex,
    runId: scope.runId,
    runtimeServices: daemonContext,
    stateRoot: options.stateRoot,
    threadId: assertThreadId(scope.threadId),
    workingDirectory: scope.workingDirectory,
  });
  const authorizeOutputRecovery =
    options.authority.authorizeOutputRecovery?.bind(options.authority);
  const transport = daemonContext.createExternalToolSdkTransport<Principal>({
    getProjectionIdentity: options.getProjectionIdentity,
    authority: {
      authenticate: (credential, callOptions) =>
        options.authority.authenticate(credential, callOptions),
      async authorizeInvocation(invocation) {
        const admission =
          await options.authority.authorizeInvocation(invocation);
        return admission.ok
          ? { ok: true, context: toExecutionContext(admission.scope) }
          : admission;
      },
      ...(authorizeOutputRecovery === undefined
        ? {}
        : {
            async authorizeOutputRecovery(recovery) {
              const admission = await authorizeOutputRecovery(recovery);
              return admission.ok
                ? { ok: true, context: toExecutionContext(admission.scope) }
                : admission;
            },
          }),
    },
  });
  let closePromise: Promise<void> | undefined;

  return {
    transport,
    close() {
      closePromise ??= closeDaemonToolSdkEmbeddingContext(daemonContext);
      return closePromise;
    },
  };
}

async function closeDaemonToolSdkEmbeddingContext(
  daemonContext: DaemonContext,
): Promise<void> {
  const settlements = await Promise.allSettled([
    daemonContext.globalMcp.close(),
    daemonContext.ptc.executeCode.closeAll(),
    daemonContext.provider.webSocketSessions.closeAll(),
  ]);
  let hostCommandFailure: unknown;
  try {
    await daemonContext.hostCommands.closeAll();
  } catch (error) {
    hostCommandFailure = error;
  }
  const rejected = settlements.find(
    (settlement): settlement is PromiseRejectedResult =>
      settlement.status === 'rejected',
  );
  if (rejected !== undefined) {
    throw rejected.reason instanceof Error
      ? rejected.reason
      : new Error('daemon Tool SDK host task rejected', {
          cause: rejected.reason,
        });
  }
  if (hostCommandFailure !== undefined) {
    throw hostCommandFailure instanceof Error
      ? hostCommandFailure
      : new Error('daemon Tool SDK host command cleanup failed', {
          cause: hostCommandFailure,
        });
  }
}
