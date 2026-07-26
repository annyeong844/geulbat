import type { AgentLoopKernelEvent } from '@geulbat/agent-loop/kernel';

import type { HarnessRunTrace } from './run-trace.js';

export type HarnessRunTraceIdentityField =
  | 'taskId'
  | 'attemptId'
  | 'modelConfigId'
  | 'harnessSnapshotId'
  | 'loopImplementation.implementationId'
  | 'loopImplementation.contractVersion';

export type HarnessRunTraceEventField =
  | 'kind'
  | 'round'
  | 'historyItemCount'
  | 'sawFirstModelRequest'
  | 'outcome'
  | 'functionCallCount'
  | 'structuredOutputCount'
  | 'terminalOk'
  | 'terminalSource';

export type HarnessRunTraceOutcomeField = 'ok' | 'terminalSource';

export interface HarnessRunTraceEventDifference {
  readonly eventIndex: number;
  readonly baselineRound: number | null;
  readonly candidateRound: number | null;
  readonly baselineKind: AgentLoopKernelEvent['kind'] | null;
  readonly candidateKind: AgentLoopKernelEvent['kind'] | null;
  readonly differingFields: readonly HarnessRunTraceEventField[];
}

export interface HarnessRunTraceComparison {
  readonly identical: boolean;
  readonly identityDifferences: readonly HarnessRunTraceIdentityField[];
  readonly eventDifferences: readonly HarnessRunTraceEventDifference[];
  readonly outcomeDifferences: readonly HarnessRunTraceOutcomeField[];
}

const IDENTITY_FIELD_ORDER = [
  'taskId',
  'attemptId',
  'modelConfigId',
  'harnessSnapshotId',
  'loopImplementation.implementationId',
  'loopImplementation.contractVersion',
] as const satisfies readonly HarnessRunTraceIdentityField[];

const EVENT_FIELD_ORDER = [
  'kind',
  'round',
  'historyItemCount',
  'sawFirstModelRequest',
  'outcome',
  'functionCallCount',
  'structuredOutputCount',
  'terminalOk',
  'terminalSource',
] as const satisfies readonly HarnessRunTraceEventField[];

const OUTCOME_FIELD_ORDER = [
  'ok',
  'terminalSource',
] as const satisfies readonly HarnessRunTraceOutcomeField[];

type EventFieldValues = Partial<
  Record<HarnessRunTraceEventField, boolean | number | string>
>;

export function compareHarnessRunTraces(
  baseline: HarnessRunTrace,
  candidate: HarnessRunTrace,
): HarnessRunTraceComparison {
  const identityDifferences = Object.freeze(
    IDENTITY_FIELD_ORDER.filter(
      (field) =>
        readIdentityField(baseline, field) !==
        readIdentityField(candidate, field),
    ),
  );
  const eventDifferences: HarnessRunTraceEventDifference[] = [];
  const eventCount = Math.max(baseline.events.length, candidate.events.length);
  for (let eventIndex = 0; eventIndex < eventCount; eventIndex += 1) {
    const baselineEvent = baseline.events[eventIndex];
    const candidateEvent = candidate.events[eventIndex];
    const baselineFields: EventFieldValues = baselineEvent ?? {};
    const candidateFields: EventFieldValues = candidateEvent ?? {};
    const differingFields = Object.freeze(
      EVENT_FIELD_ORDER.filter(
        (field) => baselineFields[field] !== candidateFields[field],
      ),
    );
    if (differingFields.length === 0) {
      continue;
    }
    eventDifferences.push(
      Object.freeze({
        eventIndex,
        baselineRound: baselineEvent?.round ?? null,
        candidateRound: candidateEvent?.round ?? null,
        baselineKind: baselineEvent?.kind ?? null,
        candidateKind: candidateEvent?.kind ?? null,
        differingFields,
      }),
    );
  }
  const frozenEventDifferences = Object.freeze(eventDifferences);
  const outcomeDifferences = Object.freeze(
    OUTCOME_FIELD_ORDER.filter(
      (field) => baseline.outcome[field] !== candidate.outcome[field],
    ),
  );
  return Object.freeze({
    identical:
      identityDifferences.length === 0 &&
      frozenEventDifferences.length === 0 &&
      outcomeDifferences.length === 0,
    identityDifferences,
    eventDifferences: frozenEventDifferences,
    outcomeDifferences,
  });
}

function readIdentityField(
  trace: HarnessRunTrace,
  field: HarnessRunTraceIdentityField,
): string {
  switch (field) {
    case 'taskId':
      return trace.taskId;
    case 'attemptId':
      return trace.attemptId;
    case 'modelConfigId':
      return trace.modelConfigId;
    case 'harnessSnapshotId':
      return trace.harnessSnapshotId;
    case 'loopImplementation.implementationId':
      return trace.loopImplementation.implementationId;
    case 'loopImplementation.contractVersion':
      return trace.loopImplementation.contractVersion;
  }
}
