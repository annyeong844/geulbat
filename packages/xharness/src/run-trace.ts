import {
  AGENT_LOOP_TERMINAL_SOURCES,
  type AgentLoopImplementationIdentity,
  type AgentLoopKernelEvent,
  type AgentLoopTerminalSource,
} from '@geulbat/agent-loop/kernel';
import {
  sha256StableJson,
  stableStringify,
} from '@geulbat/content-identity/stable-json';

const SHA256_ID_PATTERN = /^sha256:[0-9a-f]{64}$/u;

export interface HarnessRunTraceOutcome {
  readonly ok: boolean;
  readonly terminalSource: AgentLoopTerminalSource;
}

export interface HarnessRunTrace {
  readonly schemaVersion: 2;
  readonly traceId: `sha256:${string}`;
  readonly taskId: string;
  readonly attemptId: string;
  readonly modelConfigId: string;
  readonly harnessSnapshotId: `sha256:${string}`;
  readonly loopImplementation: AgentLoopImplementationIdentity;
  readonly events: readonly AgentLoopKernelEvent[];
  readonly outcome: HarnessRunTraceOutcome;
}

export interface CreateHarnessRunTraceArgs {
  readonly taskId: string;
  readonly attemptId: string;
  readonly modelConfigId: string;
  readonly harnessSnapshotId: `sha256:${string}`;
  readonly loopImplementation: AgentLoopImplementationIdentity;
  readonly events: readonly AgentLoopKernelEvent[];
  readonly outcomeOk: boolean;
}

export function createHarnessRunTrace(
  args: CreateHarnessRunTraceArgs,
): HarnessRunTrace {
  const taskId = assertOpaqueId(args.taskId, 'taskId');
  const attemptId = assertOpaqueId(args.attemptId, 'attemptId');
  const modelConfigId = assertOpaqueId(args.modelConfigId, 'modelConfigId');
  const harnessSnapshotId = assertSha256Id(
    args.harnessSnapshotId,
    'harnessSnapshotId',
  );
  const loopImplementation = cloneLoopImplementation(args.loopImplementation);
  const events = Object.freeze(
    args.events.map((event, index) => parseHarnessRunTraceEvent(event, index)),
  );
  const terminalSource = validateEventSequence(events, args.outcomeOk);
  const outcome = Object.freeze({
    ok: args.outcomeOk,
    terminalSource,
  });
  const traceBody = Object.freeze({
    schemaVersion: 2 as const,
    taskId,
    attemptId,
    modelConfigId,
    harnessSnapshotId,
    loopImplementation,
    events,
    outcome,
  });
  const traceId: `sha256:${string}` = `sha256:${sha256StableJson(traceBody)}`;
  return Object.freeze({ ...traceBody, traceId });
}

export function serializeHarnessRunTrace(trace: HarnessRunTrace): string {
  const serialized = stableStringify(trace);
  parseHarnessRunTrace(serialized);
  return serialized;
}

export function parseHarnessRunTrace(serialized: string): HarnessRunTrace {
  let value: unknown;
  try {
    value = JSON.parse(serialized);
  } catch {
    throw new Error('harness run trace must be valid JSON');
  }
  const trace = assertRecord(value, 'harness run trace');
  assertExactKeys(
    trace,
    [
      'schemaVersion',
      'traceId',
      'taskId',
      'attemptId',
      'modelConfigId',
      'harnessSnapshotId',
      'loopImplementation',
      'events',
      'outcome',
    ],
    'harness run trace',
  );
  if (trace.schemaVersion !== 2) {
    throw new Error('unsupported harness run trace schemaVersion');
  }
  const traceId = assertSha256Id(trace.traceId, 'traceId');
  const loopImplementation = parseLoopImplementation(trace.loopImplementation);
  if (!Array.isArray(trace.events)) {
    throw new Error('events must be an array');
  }
  const outcome = assertRecord(trace.outcome, 'outcome');
  assertExactKeys(outcome, ['ok', 'terminalSource'], 'outcome');
  if (typeof outcome.ok !== 'boolean') {
    throw new Error('outcome.ok must be a boolean');
  }
  if (!isAgentLoopTerminalSource(outcome.terminalSource)) {
    throw new Error('outcome.terminalSource is invalid');
  }
  const canonical = createHarnessRunTrace({
    taskId: assertOpaqueId(trace.taskId, 'taskId'),
    attemptId: assertOpaqueId(trace.attemptId, 'attemptId'),
    modelConfigId: assertOpaqueId(trace.modelConfigId, 'modelConfigId'),
    harnessSnapshotId: assertSha256Id(
      trace.harnessSnapshotId,
      'harnessSnapshotId',
    ),
    loopImplementation,
    events: trace.events.map((event, index) =>
      parseHarnessRunTraceEvent(event, index),
    ),
    outcomeOk: outcome.ok,
  });
  if (canonical.outcome.terminalSource !== outcome.terminalSource) {
    throw new Error('outcome.terminalSource does not match the terminal event');
  }
  if (canonical.traceId !== traceId) {
    throw new Error('traceId does not match the harness run trace body');
  }
  return canonical;
}

function cloneLoopImplementation(
  value: AgentLoopImplementationIdentity,
): AgentLoopImplementationIdentity {
  return Object.freeze({
    implementationId: assertOpaqueId(
      value.implementationId,
      'loopImplementation.implementationId',
    ),
    contractVersion: assertOpaqueId(
      value.contractVersion,
      'loopImplementation.contractVersion',
    ),
  });
}

function parseLoopImplementation(
  value: unknown,
): AgentLoopImplementationIdentity {
  const implementation = assertRecord(value, 'loopImplementation');
  assertExactKeys(
    implementation,
    ['implementationId', 'contractVersion'],
    'loopImplementation',
  );
  return cloneLoopImplementation({
    implementationId: assertOpaqueId(
      implementation.implementationId,
      'loopImplementation.implementationId',
    ),
    contractVersion: assertOpaqueId(
      implementation.contractVersion,
      'loopImplementation.contractVersion',
    ),
  });
}

// 커널 이벤트 종류별 파서. 키가 AgentLoopKernelEvent['kind']로 고정돼 있어,
// 커널이 이벤트를 늘리면 여기 항목을 채울 때까지 컴파일이 깨진다. switch +
// default였을 때는 새 종류가 조용히 "kind is invalid"로 거부됐다.
const HARNESS_RUN_TRACE_EVENT_PARSERS: {
  [Kind in AgentLoopKernelEvent['kind']]: (
    event: Record<string, unknown>,
    label: string,
  ) => AgentLoopKernelEvent;
} = {
  round_started: parseRoundStartedEvent,
  model_call_started: parseModelCallEvent,
  model_call_completed: parseModelCallEvent,
  structured_outputs_started: parseStructuredOutputsEvent,
  structured_outputs_completed: parseStructuredOutputsEvent,
  tool_calls_started: parseToolCallsEvent,
  tool_calls_completed: parseToolCallsEvent,
  round_completed: parseRoundCompletedEvent,
};

// 임의 문자열로 찾는 자리 — 단언 없이 조회하려고 Map으로 한 번 옮긴다.
// 소진 검사는 위 레코드 리터럴이 맡는다.
const HARNESS_RUN_TRACE_EVENT_PARSER_BY_KIND = new Map<
  string,
  (event: Record<string, unknown>, label: string) => AgentLoopKernelEvent
>(Object.entries(HARNESS_RUN_TRACE_EVENT_PARSERS));

export function parseHarnessRunTraceEvent(
  value: unknown,
  index: number,
): AgentLoopKernelEvent {
  const label = `events[${index}]`;
  const event = assertRecord(value, label);
  const parse =
    typeof event.kind === 'string'
      ? HARNESS_RUN_TRACE_EVENT_PARSER_BY_KIND.get(event.kind)
      : undefined;
  if (parse === undefined) {
    throw new Error(`${label}.kind is invalid`);
  }
  return parse(event, label);
}

function parseRoundStartedEvent(
  event: Record<string, unknown>,
  label: string,
): AgentLoopKernelEvent {
  assertExactKeys(
    event,
    ['kind', 'round', 'historyItemCount', 'sawFirstModelRequest'],
    label,
  );
  if (typeof event.sawFirstModelRequest !== 'boolean') {
    throw new Error(`${label}.sawFirstModelRequest must be a boolean`);
  }
  return Object.freeze({
    kind: 'round_started',
    round: assertNonNegativeInteger(event.round, `${label}.round`),
    historyItemCount: assertNonNegativeInteger(
      event.historyItemCount,
      `${label}.historyItemCount`,
    ),
    sawFirstModelRequest: event.sawFirstModelRequest,
  });
}

function parseModelCallEvent(
  event: Record<string, unknown>,
  label: string,
): AgentLoopKernelEvent {
  const round = assertNonNegativeInteger(event.round, `${label}.round`);
  if (event.kind === 'model_call_started') {
    assertExactKeys(event, ['kind', 'round'], label);
    return Object.freeze({ kind: 'model_call_started', round });
  }
  if (event.outcome === 'failure') {
    assertExactKeys(event, ['kind', 'round', 'outcome'], label);
    return Object.freeze({
      kind: 'model_call_completed',
      round,
      outcome: 'failure',
    });
  }
  if (event.outcome !== 'success') {
    throw new Error(`${label}.outcome is invalid`);
  }
  assertExactKeys(
    event,
    ['kind', 'round', 'outcome', 'functionCallCount', 'structuredOutputCount'],
    label,
  );
  return Object.freeze({
    kind: 'model_call_completed',
    round,
    outcome: 'success',
    functionCallCount: assertNonNegativeInteger(
      event.functionCallCount,
      `${label}.functionCallCount`,
    ),
    structuredOutputCount: assertNonNegativeInteger(
      event.structuredOutputCount,
      `${label}.structuredOutputCount`,
    ),
  });
}

function parseStructuredOutputsEvent(
  event: Record<string, unknown>,
  label: string,
): AgentLoopKernelEvent {
  const round = assertNonNegativeInteger(event.round, `${label}.round`);
  if (event.kind === 'structured_outputs_started') {
    assertExactKeys(event, ['kind', 'round', 'structuredOutputCount'], label);
    return Object.freeze({
      kind: 'structured_outputs_started',
      round,
      structuredOutputCount: assertNonNegativeInteger(
        event.structuredOutputCount,
        `${label}.structuredOutputCount`,
      ),
    });
  }
  if (
    event.outcome !== 'none' &&
    event.outcome !== 'handled' &&
    event.outcome !== 'unhandled' &&
    event.outcome !== 'failure'
  ) {
    throw new Error(`${label}.outcome is invalid`);
  }
  assertExactKeys(event, ['kind', 'round', 'outcome'], label);
  return Object.freeze({
    kind: 'structured_outputs_completed',
    round,
    outcome: event.outcome,
  });
}

function parseToolCallsEvent(
  event: Record<string, unknown>,
  label: string,
): AgentLoopKernelEvent {
  const round = assertNonNegativeInteger(event.round, `${label}.round`);
  if (event.kind === 'tool_calls_started') {
    assertExactKeys(event, ['kind', 'round', 'functionCallCount'], label);
    return Object.freeze({
      kind: 'tool_calls_started',
      round,
      functionCallCount: assertNonNegativeInteger(
        event.functionCallCount,
        `${label}.functionCallCount`,
      ),
    });
  }
  if (event.outcome !== 'success' && event.outcome !== 'failure') {
    throw new Error(`${label}.outcome is invalid`);
  }
  assertExactKeys(event, ['kind', 'round', 'outcome'], label);
  return Object.freeze({
    kind: 'tool_calls_completed',
    round,
    outcome: event.outcome,
  });
}

function parseRoundCompletedEvent(
  event: Record<string, unknown>,
  label: string,
): AgentLoopKernelEvent {
  if (event.outcome === 'continue') {
    assertExactKeys(event, ['kind', 'round', 'outcome'], label);
    return Object.freeze({
      kind: 'round_completed',
      round: assertNonNegativeInteger(event.round, `${label}.round`),
      outcome: 'continue',
    });
  }
  if (event.outcome !== 'terminal') {
    throw new Error(`${label}.outcome is invalid`);
  }
  assertExactKeys(
    event,
    ['kind', 'round', 'outcome', 'terminalOk', 'terminalSource'],
    label,
  );
  if (typeof event.terminalOk !== 'boolean') {
    throw new Error(`${label}.terminalOk must be a boolean`);
  }
  if (!isAgentLoopTerminalSource(event.terminalSource)) {
    throw new Error(`${label}.terminalSource is invalid`);
  }
  return Object.freeze({
    kind: 'round_completed',
    round: assertNonNegativeInteger(event.round, `${label}.round`),
    outcome: 'terminal',
    terminalOk: event.terminalOk,
    terminalSource: event.terminalSource,
  });
}

function validateEventSequence(
  events: readonly AgentLoopKernelEvent[],
  outcomeOk: boolean,
): AgentLoopTerminalSource {
  if (events.length === 0) {
    throw new Error('events must contain at least one completed round');
  }
  let cursor = 0;
  let expectedRound = 0;
  let terminalSource: AgentLoopTerminalSource | undefined;
  while (cursor < events.length) {
    const started = events[cursor];
    if (started?.kind !== 'round_started' || started.round !== expectedRound) {
      throw new Error(`events must start round ${expectedRound} in order`);
    }
    if (started.sawFirstModelRequest !== expectedRound > 0) {
      throw new Error(
        `round ${expectedRound} has an invalid sawFirstModelRequest value`,
      );
    }
    cursor += 1;
    let completed:
      | Extract<AgentLoopKernelEvent, { kind: 'round_completed' }>
      | undefined;
    while (cursor < events.length) {
      const event = events[cursor];
      if (event?.kind === 'round_completed') {
        if (event.round !== expectedRound) {
          throw new Error(
            `events must complete round ${expectedRound} in order`,
          );
        }
        completed = event;
        cursor += 1;
        break;
      }
      if (event === undefined || event.round !== expectedRound) {
        throw new Error(`round ${expectedRound} events must remain contiguous`);
      }
      const completionKind = getPhaseCompletionKind(event);
      const phaseCompleted = events[cursor + 1];
      if (
        completionKind === undefined ||
        phaseCompleted?.kind !== completionKind ||
        phaseCompleted.round !== expectedRound
      ) {
        throw new Error(
          'phase events must contain adjacent start/completion pairs',
        );
      }
      cursor += 2;
    }
    if (completed === undefined) {
      throw new Error(`events must complete round ${expectedRound} in order`);
    }
    const isLastRound = cursor === events.length;
    if (!isLastRound && completed.outcome !== 'continue') {
      throw new Error('only the final round may be terminal');
    }
    if (isLastRound && completed.outcome !== 'terminal') {
      throw new Error('the final round must be terminal');
    }
    if (completed.outcome === 'terminal') {
      if (completed.terminalOk !== outcomeOk) {
        throw new Error('terminal event does not match outcome.ok');
      }
      terminalSource = completed.terminalSource;
    }
    expectedRound += 1;
  }
  if (terminalSource === undefined) {
    throw new Error('events must contain one terminal round');
  }
  return terminalSource;
}

function getPhaseCompletionKind(
  event: AgentLoopKernelEvent,
): AgentLoopKernelEvent['kind'] | undefined {
  switch (event.kind) {
    case 'model_call_started':
      return 'model_call_completed';
    case 'structured_outputs_started':
      return 'structured_outputs_completed';
    case 'tool_calls_started':
      return 'tool_calls_completed';
    default:
      return undefined;
  }
}

function assertRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error(`${label} must be an object`);
  }
  const prototype = Reflect.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error(`${label} must be a plain object`);
  }
  return value;
}

function assertExactKeys(
  value: Record<string, unknown>,
  expectedKeys: readonly string[],
  label: string,
): void {
  const actualKeys = Object.keys(value).sort();
  const sortedExpectedKeys = [...expectedKeys].sort();
  if (
    actualKeys.length !== sortedExpectedKeys.length ||
    actualKeys.some((key, index) => key !== sortedExpectedKeys[index])
  ) {
    throw new Error(`${label} has unexpected fields`);
  }
}

function assertOpaqueId(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${label} must be a non-blank string`);
  }
  return value;
}

function assertSha256Id(value: unknown, label: string): `sha256:${string}` {
  if (!isSha256Id(value)) {
    throw new Error(`${label} must be a lowercase sha256 identifier`);
  }
  return value;
}

function assertNonNegativeInteger(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative safe integer`);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isSha256Id(value: unknown): value is `sha256:${string}` {
  return typeof value === 'string' && SHA256_ID_PATTERN.test(value);
}

function isAgentLoopTerminalSource(
  value: unknown,
): value is AgentLoopTerminalSource {
  return AGENT_LOOP_TERMINAL_SOURCES.some((source) => source === value);
}
