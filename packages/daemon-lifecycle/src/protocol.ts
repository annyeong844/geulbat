export const DAEMON_LIFECYCLE_START_COMMAND_TYPE =
  'daemon-lifecycle.start' as const;
export const DAEMON_LIFECYCLE_SHUTDOWN_COMMAND_TYPE =
  'daemon-lifecycle.shutdown' as const;
export const DAEMON_LIFECYCLE_EVENT_TYPE = 'daemon-lifecycle.event' as const;
export const DAEMON_LIFECYCLE_READY_MESSAGE_TYPE =
  'daemon-lifecycle.daemon-ready' as const;

export type DaemonShutdownSignal = 'SIGINT' | 'SIGTERM';

export interface DaemonLifecycleStartCommand {
  type: typeof DAEMON_LIFECYCLE_START_COMMAND_TYPE;
  lifecycleRunId: string;
  entrypoint: string;
  arguments: readonly string[];
  execArgv: readonly string[];
}

export interface DaemonLifecycleShutdownCommand {
  type: typeof DAEMON_LIFECYCLE_SHUTDOWN_COMMAND_TYPE;
  lifecycleRunId: string;
  signal: DaemonShutdownSignal;
}

export type DaemonLifecycleCommand =
  | DaemonLifecycleStartCommand
  | DaemonLifecycleShutdownCommand;

export type DaemonLifecycleState =
  | 'starting'
  | 'ready'
  | 'exited'
  | 'restarting'
  | 'failed'
  | 'stopped';

export interface DaemonLifecycleEvent {
  type: typeof DAEMON_LIFECYCLE_EVENT_TYPE;
  lifecycleRunId: string;
  generation: number;
  state: DaemonLifecycleState;
  pid: number | null;
  code: number | null;
  signal: string | null;
  expected: boolean;
  detail: string | null;
}

export interface DaemonLifecycleReadyMessage {
  type: typeof DAEMON_LIFECYCLE_READY_MESSAGE_TYPE;
}

export function parseDaemonLifecycleCommand(
  value: unknown,
): DaemonLifecycleCommand | undefined {
  if (!isRecord(value) || typeof value.type !== 'string') {
    return undefined;
  }
  if (value.type === DAEMON_LIFECYCLE_START_COMMAND_TYPE) {
    if (
      !isNonEmptyString(value.lifecycleRunId) ||
      !isNonEmptyString(value.entrypoint) ||
      !isStringArray(value.arguments) ||
      !isStringArray(value.execArgv)
    ) {
      return undefined;
    }
    return {
      type: DAEMON_LIFECYCLE_START_COMMAND_TYPE,
      lifecycleRunId: value.lifecycleRunId,
      entrypoint: value.entrypoint,
      arguments: [...value.arguments],
      execArgv: [...value.execArgv],
    };
  }
  if (value.type === DAEMON_LIFECYCLE_SHUTDOWN_COMMAND_TYPE) {
    if (
      !isNonEmptyString(value.lifecycleRunId) ||
      !isDaemonShutdownSignal(value.signal)
    ) {
      return undefined;
    }
    return {
      type: DAEMON_LIFECYCLE_SHUTDOWN_COMMAND_TYPE,
      lifecycleRunId: value.lifecycleRunId,
      signal: value.signal,
    };
  }
  return undefined;
}

export function parseDaemonLifecycleEvent(
  value: unknown,
): DaemonLifecycleEvent | undefined {
  if (
    !isRecord(value) ||
    value.type !== DAEMON_LIFECYCLE_EVENT_TYPE ||
    !isNonEmptyString(value.lifecycleRunId) ||
    !isPositiveInteger(value.generation) ||
    !isDaemonLifecycleState(value.state) ||
    !isNullablePositiveInteger(value.pid) ||
    !isNullableInteger(value.code) ||
    !isNullableString(value.signal) ||
    typeof value.expected !== 'boolean' ||
    !isNullableString(value.detail)
  ) {
    return undefined;
  }
  return {
    type: DAEMON_LIFECYCLE_EVENT_TYPE,
    lifecycleRunId: value.lifecycleRunId,
    generation: value.generation,
    state: value.state,
    pid: value.pid,
    code: value.code,
    signal: value.signal,
    expected: value.expected,
    detail: value.detail,
  };
}

export function isDaemonLifecycleReadyMessage(
  value: unknown,
): value is DaemonLifecycleReadyMessage {
  return isRecord(value) && value.type === DAEMON_LIFECYCLE_READY_MESSAGE_TYPE;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((item) => typeof item === 'string')
  );
}

function isDaemonShutdownSignal(value: unknown): value is DaemonShutdownSignal {
  return value === 'SIGINT' || value === 'SIGTERM';
}

function isDaemonLifecycleState(value: unknown): value is DaemonLifecycleState {
  return (
    value === 'starting' ||
    value === 'ready' ||
    value === 'exited' ||
    value === 'restarting' ||
    value === 'failed' ||
    value === 'stopped'
  );
}

function isPositiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0;
}

function isNullablePositiveInteger(value: unknown): value is number | null {
  return value === null || isPositiveInteger(value);
}

function isNullableInteger(value: unknown): value is number | null {
  return value === null || Number.isSafeInteger(value);
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string';
}
