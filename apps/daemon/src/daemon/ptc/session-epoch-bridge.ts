import { posix as pathPosix } from 'node:path';
import { isRecord } from '@geulbat/protocol/runtime-utils';
import {
  createPtcEpochCallbackChannel,
  type CreatePtcEpochCallbackChannelArgs,
  type PtcEpochCallbackChannel,
  type PtcEpochCallbackHandler,
} from './epoch-callback.js';
import type {
  PtcSessionDockerFailureReason,
  PtcSessionDockerHandle,
  PtcSessionDockerIdentity,
  PtcSessionDockerManager,
} from './session-docker-contract.js';

export type PtcSessionEpochBridgeFailureReason =
  | 'session_unavailable'
  | 'callback_channel_failed'
  | 'callback_path_projection_failed';

export type PtcSessionEpochBridgeResult<T> =
  | { ok: true; value: T }
  | {
      ok: false;
      reasonCode: PtcSessionEpochBridgeFailureReason;
      message: string;
      diagnostics?: Record<string, string | number | boolean>;
    };

export type PtcEpochCallbackChannelFactory = (
  args: CreatePtcEpochCallbackChannelArgs,
) => Promise<PtcEpochCallbackChannel>;

export interface PtcSessionEpochBridge {
  containerId: string;
  epochId: string;
  token: string;
  callbackSocketHostPath: string;
  callbackSocketContainerPath: string;
  session: PtcSessionDockerHandle;
  close(): Promise<void>;
}

export interface CreatePtcSessionEpochBridgeArgs {
  identity: PtcSessionDockerIdentity;
  sessionManager: PtcSessionDockerManager;
  callbackHandler: PtcEpochCallbackHandler;
  callbackFactory?: PtcEpochCallbackChannelFactory;
  signal?: AbortSignal;
}

export async function createPtcSessionEpochBridge(
  args: CreatePtcSessionEpochBridgeArgs,
): Promise<PtcSessionEpochBridgeResult<PtcSessionEpochBridge>> {
  const session = await args.sessionManager.getOrCreate(
    args.identity,
    args.signal === undefined ? undefined : { signal: args.signal },
  );
  if (!session.ok) {
    return sessionFailure(session.reasonCode);
  }

  const handle = session.value;
  let channel: PtcEpochCallbackChannel;
  try {
    channel = await (args.callbackFactory ?? createPtcEpochCallbackChannel)({
      rootDir: handle.callbackRootHostPath,
      handler: args.callbackHandler,
    });
  } catch (error: unknown) {
    return {
      ok: false,
      reasonCode: 'callback_channel_failed',
      message: 'PTC epoch callback channel creation failed',
      diagnostics: callbackChannelFailureDiagnostics(error),
    };
  }

  const projected = projectCallbackSocketPath({
    callbackRootHostPath: handle.callbackRootHostPath,
    callbackRootContainerPath: handle.callbackRootContainerPath,
    socketPath: channel.socketPath,
  });
  if (!projected.ok) {
    // Best-effort cleanup only. Projection failure remains the classified
    // bridge failure, and cleanup diagnostics are intentionally not surfaced
    // to avoid leaking host paths.
    await channel.close().catch(() => {});
    return projected;
  }

  let closed = false;
  return {
    ok: true,
    value: {
      containerId: handle.containerId,
      epochId: channel.epochId,
      token: channel.token,
      callbackSocketHostPath: channel.socketPath,
      callbackSocketContainerPath: projected.value,
      session: handle,
      close: async () => {
        if (closed) {
          return;
        }
        closed = true;
        await channel.close();
      },
    },
  };
}

function callbackChannelFailureDiagnostics(
  error: unknown,
): Record<string, string | number | boolean> {
  const diagnostics: Record<string, string | number | boolean> = {
    callbackChannelFailed: true,
  };
  if (error instanceof Error && error.name.length > 0) {
    diagnostics.callbackChannelErrorName = error.name;
  }
  if (isRecord(error)) {
    const code = error.code;
    if (typeof code === 'string' || typeof code === 'number') {
      diagnostics.callbackChannelErrorCode = code;
    }
  }
  return diagnostics;
}

function projectCallbackSocketPath(args: {
  callbackRootHostPath: string;
  callbackRootContainerPath: string;
  socketPath: string;
}): PtcSessionEpochBridgeResult<string> {
  const normalized = pathPosix.relative(
    args.callbackRootHostPath,
    args.socketPath,
  );
  if (
    normalized.length === 0 ||
    normalized === '..' ||
    normalized.startsWith('../') ||
    normalized.startsWith('/') ||
    normalized.includes('/../')
  ) {
    return {
      ok: false,
      reasonCode: 'callback_path_projection_failed',
      message: 'PTC callback socket path is outside the session callback root',
    };
  }
  return {
    ok: true,
    value: `${args.callbackRootContainerPath}/${normalized}`,
  };
}

function sessionFailure(
  reasonCode: PtcSessionDockerFailureReason,
): PtcSessionEpochBridgeResult<never> {
  return {
    ok: false,
    reasonCode: 'session_unavailable',
    message: 'PTC session container is unavailable',
    diagnostics: { sessionReasonCode: reasonCode },
  };
}
