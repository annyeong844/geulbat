import type { PtcSessionEpochBridgeCallbackPolicy } from './session-epoch-bridge.js';
import { isPtcRecord } from '../shared/record-shape.js';

interface PtcEpochCallbackHostBootstrap {
  kind: 'bootstrap';
  rootDir: string;
  epochId: string;
  token: string;
  controlSocketPath: string;
  policy: PtcSessionEpochBridgeCallbackPolicy;
}

interface PtcEpochCallbackHostAttach {
  kind: 'attach';
  controlSocketPath: string;
}

interface PtcEpochCallbackHostInitializeOrAttach {
  kind: 'initialize_or_attach';
  rootDir: string;
  epochId: string;
  token: string;
  controlSocketPath: string;
  policy: PtcSessionEpochBridgeCallbackPolicy;
}

type PtcEpochCallbackHostCommand =
  | PtcEpochCallbackHostBootstrap
  | PtcEpochCallbackHostAttach
  | PtcEpochCallbackHostInitializeOrAttach;

export type PtcEpochCallbackDaemonFrame =
  | {
      kind: 'settle';
      invocationId: string;
      handlerResult: unknown;
    }
  | {
      kind: 'handler_failed';
      invocationId: string;
    }
  | {
      kind: 'enter_long_wait';
      invocationId: string;
      admissionId: string;
    }
  | { kind: 'shutdown' };

export type PtcEpochCallbackHostFrame =
  | {
      kind: 'ready';
      epochId: string;
      token: string;
      socketPath: string;
    }
  | { kind: 'startup_failed' }
  | { kind: 'busy' }
  | {
      kind: 'invoke';
      invocationId: string;
      requestId: string;
      callbackKind: string;
      args: unknown;
    }
  | { kind: 'cancel'; invocationId: string }
  | {
      kind: 'long_wait_result';
      invocationId: string;
      admissionId: string;
      admitted: boolean;
    }
  | { kind: 'closed' };

export function encodePtcEpochCallbackHostFrame(
  frame:
    | PtcEpochCallbackHostCommand
    | PtcEpochCallbackDaemonFrame
    | PtcEpochCallbackHostFrame,
): string {
  return `${JSON.stringify(frame)}\n`;
}

export function parsePtcEpochCallbackHostCommand(
  line: string,
): PtcEpochCallbackHostCommand | undefined {
  const value = parseRecord(line);
  if (value?.kind === 'attach' && isNonEmptyString(value.controlSocketPath)) {
    return {
      kind: 'attach',
      controlSocketPath: value.controlSocketPath,
    };
  }
  if (
    (value?.kind !== 'bootstrap' && value?.kind !== 'initialize_or_attach') ||
    !isNonEmptyString(value.rootDir) ||
    !isEpochId(value.epochId) ||
    !isToken(value.token) ||
    !isNonEmptyString(value.controlSocketPath) ||
    !isCallbackPolicy(value.policy)
  ) {
    return undefined;
  }
  return {
    kind: value.kind,
    rootDir: value.rootDir,
    epochId: value.epochId,
    token: value.token,
    controlSocketPath: value.controlSocketPath,
    policy: value.policy,
  };
}

export function parsePtcEpochCallbackDaemonFrame(
  line: string,
): PtcEpochCallbackDaemonFrame | undefined {
  const value = parseRecord(line);
  if (value?.kind === 'shutdown') {
    return { kind: 'shutdown' };
  }
  if (
    value?.kind === 'handler_failed' &&
    isNonEmptyString(value.invocationId)
  ) {
    return {
      kind: 'handler_failed',
      invocationId: value.invocationId,
    };
  }
  if (
    value?.kind === 'enter_long_wait' &&
    isNonEmptyString(value.invocationId) &&
    isNonEmptyString(value.admissionId)
  ) {
    return {
      kind: 'enter_long_wait',
      invocationId: value.invocationId,
      admissionId: value.admissionId,
    };
  }
  if (value?.kind === 'settle' && isNonEmptyString(value.invocationId)) {
    return {
      kind: 'settle',
      invocationId: value.invocationId,
      handlerResult: value.handlerResult,
    };
  }
  return undefined;
}

export function parsePtcEpochCallbackHostFrame(
  line: string,
): PtcEpochCallbackHostFrame | undefined {
  const value = parseRecord(line);
  if (
    value?.kind === 'startup_failed' ||
    value?.kind === 'busy' ||
    value?.kind === 'closed'
  ) {
    return { kind: value.kind };
  }
  if (
    value?.kind === 'ready' &&
    isEpochId(value.epochId) &&
    isToken(value.token) &&
    isNonEmptyString(value.socketPath)
  ) {
    return {
      kind: 'ready',
      epochId: value.epochId,
      token: value.token,
      socketPath: value.socketPath,
    };
  }
  if (value?.kind === 'cancel' && isNonEmptyString(value.invocationId)) {
    return { kind: 'cancel', invocationId: value.invocationId };
  }
  if (
    value?.kind === 'long_wait_result' &&
    isNonEmptyString(value.invocationId) &&
    isNonEmptyString(value.admissionId) &&
    typeof value.admitted === 'boolean'
  ) {
    return {
      kind: 'long_wait_result',
      invocationId: value.invocationId,
      admissionId: value.admissionId,
      admitted: value.admitted,
    };
  }
  if (
    value?.kind === 'invoke' &&
    isNonEmptyString(value.invocationId) &&
    isNonEmptyString(value.requestId) &&
    isNonEmptyString(value.callbackKind)
  ) {
    return {
      kind: 'invoke',
      invocationId: value.invocationId,
      requestId: value.requestId,
      callbackKind: value.callbackKind,
      args: value.args,
    };
  }
  return undefined;
}

function parseRecord(line: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(line);
    return isPtcRecord(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

function isCallbackPolicy(
  value: unknown,
): value is PtcSessionEpochBridgeCallbackPolicy {
  if (!isPtcRecord(value)) {
    return false;
  }
  return (
    isPositiveSafeInteger(value.maxFrameBytes) &&
    isPositiveSafeInteger(value.maxOpenConnections) &&
    isPositiveSafeInteger(value.maxCallbacks) &&
    isPositiveSafeInteger(value.callbackTimeoutMs) &&
    isPositiveSafeInteger(value.maxResponseBytes)
  );
}

function isPositiveSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isEpochId(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{16}$/u.test(value);
}

function isToken(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
}
