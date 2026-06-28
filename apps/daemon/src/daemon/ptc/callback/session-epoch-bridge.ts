import { posix as pathPosix } from 'node:path';
import { isPtcRecord } from '../shared/record-shape.js';
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
} from '../lab/session/session-docker-contract.js';

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

export const PTC_EPOCH_CALLBACK_MAX_FRAME_BYTES_ENV =
  'GEULBAT_PTC_CALLBACK_MAX_FRAME_BYTES' as const;
export const PTC_EPOCH_CALLBACK_MAX_OPEN_CONNECTIONS_ENV =
  'GEULBAT_PTC_CALLBACK_MAX_OPEN_CONNECTIONS' as const;
export const PTC_EPOCH_CALLBACK_MAX_CALLBACKS_ENV =
  'GEULBAT_PTC_CALLBACK_MAX_CALLBACKS' as const;
export const PTC_EPOCH_CALLBACK_TIMEOUT_MS_ENV =
  'GEULBAT_PTC_CALLBACK_TIMEOUT_MS' as const;
export const PTC_EPOCH_CALLBACK_MAX_RESPONSE_BYTES_ENV =
  'GEULBAT_PTC_CALLBACK_MAX_RESPONSE_BYTES' as const;

type PtcSessionEpochBridgeCallbackPolicyEnv = Readonly<
  Partial<
    Record<
      | typeof PTC_EPOCH_CALLBACK_MAX_FRAME_BYTES_ENV
      | typeof PTC_EPOCH_CALLBACK_MAX_OPEN_CONNECTIONS_ENV
      | typeof PTC_EPOCH_CALLBACK_MAX_CALLBACKS_ENV
      | typeof PTC_EPOCH_CALLBACK_TIMEOUT_MS_ENV
      | typeof PTC_EPOCH_CALLBACK_MAX_RESPONSE_BYTES_ENV,
      string | undefined
    >
  >
>;

export interface PtcSessionEpochBridgeCallbackPolicy {
  maxFrameBytes: number;
  maxOpenConnections: number;
  maxCallbacks: number;
  callbackTimeoutMs: number;
  maxResponseBytes: number;
}

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
  callbackPolicy?: PtcSessionEpochBridgeCallbackPolicy;
  callbackFactory?: PtcEpochCallbackChannelFactory;
  signal?: AbortSignal;
}

export function resolvePtcSessionEpochBridgeCallbackPolicyFromEnv(
  env: PtcSessionEpochBridgeCallbackPolicyEnv = process.env,
): PtcSessionEpochBridgeCallbackPolicy | undefined {
  const maxFrameBytesRaw = env[PTC_EPOCH_CALLBACK_MAX_FRAME_BYTES_ENV];
  const maxOpenConnectionsRaw =
    env[PTC_EPOCH_CALLBACK_MAX_OPEN_CONNECTIONS_ENV];
  const maxCallbacksRaw = env[PTC_EPOCH_CALLBACK_MAX_CALLBACKS_ENV];
  const callbackTimeoutMsRaw = env[PTC_EPOCH_CALLBACK_TIMEOUT_MS_ENV];
  const maxResponseBytesRaw = env[PTC_EPOCH_CALLBACK_MAX_RESPONSE_BYTES_ENV];

  if (
    maxFrameBytesRaw === undefined &&
    maxOpenConnectionsRaw === undefined &&
    maxCallbacksRaw === undefined &&
    callbackTimeoutMsRaw === undefined &&
    maxResponseBytesRaw === undefined
  ) {
    return undefined;
  }

  return Object.freeze({
    maxFrameBytes: readRequiredPtcCallbackPositiveIntegerEnv(
      PTC_EPOCH_CALLBACK_MAX_FRAME_BYTES_ENV,
      maxFrameBytesRaw,
    ),
    maxOpenConnections: readRequiredPtcCallbackPositiveIntegerEnv(
      PTC_EPOCH_CALLBACK_MAX_OPEN_CONNECTIONS_ENV,
      maxOpenConnectionsRaw,
    ),
    maxCallbacks: readRequiredPtcCallbackPositiveIntegerEnv(
      PTC_EPOCH_CALLBACK_MAX_CALLBACKS_ENV,
      maxCallbacksRaw,
    ),
    callbackTimeoutMs: readRequiredPtcCallbackPositiveIntegerEnv(
      PTC_EPOCH_CALLBACK_TIMEOUT_MS_ENV,
      callbackTimeoutMsRaw,
    ),
    maxResponseBytes: readRequiredPtcCallbackPositiveIntegerEnv(
      PTC_EPOCH_CALLBACK_MAX_RESPONSE_BYTES_ENV,
      maxResponseBytesRaw,
    ),
  });
}

export async function createPtcSessionEpochBridge(
  args: CreatePtcSessionEpochBridgeArgs,
): Promise<PtcSessionEpochBridgeResult<PtcSessionEpochBridge>> {
  if (args.callbackPolicy === undefined && args.callbackFactory === undefined) {
    return {
      ok: false,
      reasonCode: 'callback_channel_failed',
      message: 'PTC epoch callback transport policy is required',
      diagnostics: { callbackTransportPolicyRequired: true },
    };
  }

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
      ...(args.callbackPolicy ?? {}),
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

function readRequiredPtcCallbackPositiveIntegerEnv(
  name: string,
  raw: string | undefined,
): number {
  if (raw === undefined) {
    throw new Error(
      `${name} is required when PTC callback transport policy is configured`,
    );
  }
  return readPtcCallbackPositiveIntegerEnv(name, raw);
}

function readPtcCallbackPositiveIntegerEnv(name: string, raw: string): number {
  const value = raw.trim();
  if (!/^\d+$/u.test(value)) {
    throw new Error(`invalid ${name}: ${value || 'empty'}`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`invalid ${name}: ${value}`);
  }
  return parsed;
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
  if (isPtcRecord(error)) {
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
