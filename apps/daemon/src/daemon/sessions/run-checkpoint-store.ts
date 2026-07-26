import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  assertRunId,
  assertThreadId,
  isRunId,
  isThreadId,
  type RunId,
  type ThreadId,
} from '@geulbat/protocol/ids';
import {
  isImageGenerationModelId,
  isRunModelId,
  isRunProviderId,
  isRunProviderTransitionRecovery,
  isRunReasoningEffort,
  isRunServiceTier,
  isRunSubagentModelRouting,
  isVideoGenerationModelId,
  isVideoGenerationSettings,
  resolveRunModelDescriptor,
  type ImageGenerationModelId,
  type RunProviderTransitionRecovery,
  type RunProviderId,
  type RunReasoningEffort,
  type RunServiceTier,
  type RunSubagentModelRouting,
  type VideoGenerationModelId,
  type VideoGenerationSettings,
} from '@geulbat/protocol/run-contract';
import {
  isApprovalClass,
  isApprovalGrantScope,
  isPermissionMode,
  type ApprovalClass,
  type ApprovalGrantScope,
  type PermissionMode,
} from '@geulbat/protocol/run-approval';
import { isErrorEventPayload } from '@geulbat/protocol/run-events';
import {
  isApprovedPlanRef,
  type ApprovedPlanRef,
} from '@geulbat/protocol/planning-workflow';
import {
  validateToolCapabilityPolicy,
  type ToolCapabilityPolicy,
} from '@geulbat/tool-library/tool-capability-policy';
import { isRecord } from '../runtime-json.js';

import { writeTextFileAtomically } from '../utils/atomic-file.js';
import { createKeyedSerialRunner } from '../utils/keyed-serial.js';
import type { TerminalAgentEvent } from '../runtime-contracts.js';
import type { PendingInterject } from './active-run-interject-buffer.js';
import {
  createRunEventJournalStore,
  type RunCheckpointEvent,
} from './run-event-journal.js';

export type { RunCheckpointEvent } from './run-event-journal.js';

const RUN_CHECKPOINT_SCHEMA_VERSION = 1;

export interface RecoverableRunRequest {
  workingDirectory: string;
  permissionMode: PermissionMode;
  planningWorkflow?: {
    workflowId: string;
  };
  approvedPlanRef?: ApprovedPlanRef;
  goal?: {
    goalId: string;
  };
  loopImplementation?: {
    readonly implementationId: string;
    readonly contractVersion: string;
  };
  providerModel?: { providerId: RunProviderId; model: string };
  providerTransitionRecovery?: RunProviderTransitionRecovery;
  currentFile?: string;
  selection?: { startLine: number; endLine: number; text: string };
  ultraReasoning?: boolean;
  reasoningEffort?: RunReasoningEffort;
  serviceTier?: RunServiceTier;
  subagentModelRouting?: RunSubagentModelRouting;
  toolSurface?: {
    directRegistryNames: string[];
    allowedRegistryNames: string[];
  };
  toolCapabilityPolicy?: ToolCapabilityPolicy;
  imageGenerationModel?: ImageGenerationModelId;
  videoGenerationModel?: VideoGenerationModelId;
  videoGenerationSettings?: VideoGenerationSettings;
}

export type RunCheckpointApproval =
  | {
      status: 'pending';
      callId: string;
      approvalClass: ApprovalClass;
    }
  | {
      status: 'decided';
      callId: string;
      approvalClass: ApprovalClass;
      decision: 'approved' | 'denied';
      grantScope: ApprovalGrantScope;
    };

export type RunCheckpointTerminalEvent = TerminalAgentEvent;

interface RunCheckpointTerminalSnapshot {
  event: RunCheckpointTerminalEvent;
  eventCursor: number;
  acknowledged: boolean;
}

export interface RunCheckpoint {
  schemaVersion: typeof RUN_CHECKPOINT_SCHEMA_VERSION;
  revision: number;
  status: 'running' | 'terminal';
  runId: RunId;
  threadId: ThreadId;
  request: RecoverableRunRequest;
  interjectSeq: number;
  applyingInterject: PendingInterject | null;
  pendingInterjects: PendingInterject[];
  approvals: RunCheckpointApproval[];
  eventHistory: RunCheckpointEvent[];
  terminal: RunCheckpointTerminalSnapshot | null;
  createdAt: string;
  updatedAt: string;
}

type RunCheckpointUnavailableResult = {
  ok: false;
  code: 'not_found' | 'terminal';
};

type RunCheckpointInterjectMutationResult =
  | { ok: true; checkpoint: RunCheckpoint; changed: boolean }
  | RunCheckpointUnavailableResult
  | {
      ok: false;
      code: 'sequence_conflict' | 'not_pending' | 'busy';
    };

type RunCheckpointApprovalMutationResult =
  | {
      ok: true;
      checkpoint: RunCheckpoint;
      approval: RunCheckpointApproval;
      changed: boolean;
    }
  | RunCheckpointUnavailableResult
  | {
      ok: false;
      code: 'approval_conflict' | 'approval_not_pending';
    };

type RunCheckpointTerminalAckMutationResult =
  | { ok: true; checkpoint: RunCheckpoint; changed: boolean }
  | {
      ok: false;
      code: 'not_found' | 'not_terminal' | 'cursor_conflict';
    };

export interface RunCheckpointStore {
  readThread(threadId: ThreadId): Promise<RunCheckpoint | null>;
  listRunning(): Promise<RunCheckpoint[]>;
  listUnacknowledgedTerminal(): Promise<RunCheckpoint[]>;
  startRun(args: {
    runId: RunId;
    threadId: ThreadId;
    request: RecoverableRunRequest;
  }): Promise<
    { ok: true; checkpoint: RunCheckpoint } | { ok: false; activeRunId: RunId }
  >;
  enqueueInterject(args: {
    threadId: ThreadId;
    runId: RunId;
    interject: PendingInterject;
  }): Promise<RunCheckpointInterjectMutationResult>;
  claimInterject(args: {
    threadId: ThreadId;
    runId: RunId;
    receivedSeq: number;
  }): Promise<RunCheckpointInterjectMutationResult>;
  completeInterject(args: {
    threadId: ThreadId;
    runId: RunId;
    receivedSeq: number;
  }): Promise<RunCheckpointInterjectMutationResult>;
  cancelInterject(args: {
    threadId: ThreadId;
    runId: RunId;
    receivedSeq: number;
  }): Promise<RunCheckpointInterjectMutationResult>;
  recordApprovalPending(args: {
    threadId: ThreadId;
    runId: RunId;
    callId: string;
    approvalClass: ApprovalClass;
  }): Promise<RunCheckpointApprovalMutationResult>;
  recordApprovalDecision(args: {
    threadId: ThreadId;
    runId: RunId;
    callId: string;
    decision: 'approved' | 'denied';
    grantScope: ApprovalGrantScope;
    permissionMode?: PermissionMode;
  }): Promise<RunCheckpointApprovalMutationResult>;
  appendRunEvents(args: {
    threadId: ThreadId;
    runId: RunId;
    events: readonly RunCheckpointEvent[];
  }): Promise<void>;
  settleRun(args: {
    threadId: ThreadId;
    runId: RunId;
    terminal: Omit<RunCheckpointTerminalSnapshot, 'acknowledged'>;
  }): Promise<RunCheckpoint>;
  acknowledgeTerminalEvent(args: {
    threadId: ThreadId;
    runId: RunId;
    eventCursor: number;
  }): Promise<RunCheckpointTerminalAckMutationResult>;
}

export function createRunCheckpointStore(args: {
  stateRoot: string;
  now?: () => string;
}): RunCheckpointStore {
  const root = join(args.stateRoot, '.geulbat', 'run-checkpoints');
  const now = args.now ?? (() => new Date().toISOString());
  const runMutationSerial = createKeyedSerialRunner();
  const runningRunIdByThread = new Map<ThreadId, RunId>();
  const runEventJournal = createRunEventJournalStore({
    stateRoot: args.stateRoot,
  });

  async function readCheckpointFile(
    threadId: ThreadId,
  ): Promise<RunCheckpoint | null> {
    const path = checkpointPath(root, threadId);
    try {
      const checkpoint = parseRunCheckpoint(
        JSON.parse(await readFile(path, 'utf8')),
      );
      if (checkpoint.status === 'running') {
        runningRunIdByThread.set(threadId, checkpoint.runId);
      } else {
        runningRunIdByThread.delete(threadId);
      }
      return checkpoint;
    } catch (error: unknown) {
      if (isMissingFileError(error)) {
        runningRunIdByThread.delete(threadId);
        return null;
      }
      throw error;
    }
  }

  async function hydrateEventHistory(
    checkpoint: RunCheckpoint,
  ): Promise<RunCheckpoint> {
    return {
      ...checkpoint,
      eventHistory: await runEventJournal.read({
        threadId: checkpoint.threadId,
        runId: checkpoint.runId,
      }),
    };
  }

  async function readThread(threadId: ThreadId): Promise<RunCheckpoint | null> {
    const checkpoint = await readCheckpointFile(threadId);
    return checkpoint === null ? null : await hydrateEventHistory(checkpoint);
  }

  async function listCheckpoints(): Promise<RunCheckpoint[]> {
    let names: string[];
    try {
      names = await readdir(root);
    } catch (error: unknown) {
      if (isMissingFileError(error)) {
        return [];
      }
      throw error;
    }
    return await Promise.all(
      names
        .filter((name) => name.endsWith('.json'))
        .sort()
        .map(async (name) => {
          const checkpoint = parseRunCheckpoint(
            JSON.parse(await readFile(join(root, name), 'utf8')),
          );
          if (checkpoint.status === 'running') {
            runningRunIdByThread.set(checkpoint.threadId, checkpoint.runId);
          } else {
            runningRunIdByThread.delete(checkpoint.threadId);
          }
          return await hydrateEventHistory(checkpoint);
        }),
    );
  }

  return {
    readThread,
    async listRunning() {
      const checkpoints = await listCheckpoints();
      return checkpoints.filter(
        (checkpoint) => checkpoint.status === 'running',
      );
    },
    async listUnacknowledgedTerminal() {
      const checkpoints = await listCheckpoints();
      return checkpoints.filter(
        (checkpoint) =>
          checkpoint.status === 'terminal' &&
          checkpoint.terminal !== null &&
          !checkpoint.terminal.acknowledged,
      );
    },
    async startRun({ runId, threadId, request }) {
      const path = checkpointPath(root, threadId);
      return await runMutationSerial(path, async () => {
        const previous = await readThread(threadId);
        if (previous?.status === 'running' && previous.runId !== runId) {
          return { ok: false, activeRunId: previous.runId };
        }
        if (previous?.status === 'running') {
          return { ok: true, checkpoint: previous };
        }
        const timestamp = now();
        const checkpoint: RunCheckpoint = {
          schemaVersion: RUN_CHECKPOINT_SCHEMA_VERSION,
          revision: (previous?.revision ?? 0) + 1,
          status: 'running',
          runId,
          threadId,
          request,
          interjectSeq: 0,
          applyingInterject: null,
          pendingInterjects: [],
          approvals: [],
          eventHistory: [],
          terminal: null,
          createdAt: timestamp,
          updatedAt: timestamp,
        };
        await writeCheckpoint(path, checkpoint);
        runningRunIdByThread.set(threadId, runId);
        return { ok: true, checkpoint };
      });
    },
    async enqueueInterject({ threadId, runId, interject }) {
      const path = checkpointPath(root, threadId);
      return await runMutationSerial(path, async () => {
        const resolution = resolveRunMutationCheckpoint(
          await readThread(threadId),
          runId,
        );
        if (!resolution.ok) {
          return resolution;
        }
        const previous = resolution.checkpoint;
        const existing = [
          ...(previous.applyingInterject === null
            ? []
            : [previous.applyingInterject]),
          ...previous.pendingInterjects,
        ].find((item) => item.receivedSeq === interject.receivedSeq);
        if (existing !== undefined) {
          return existing.text === interject.text
            ? { ok: true, checkpoint: previous, changed: false }
            : { ok: false, code: 'sequence_conflict' };
        }
        if (interject.receivedSeq <= previous.interjectSeq) {
          return { ok: false, code: 'not_pending' };
        }
        if (interject.receivedSeq !== previous.interjectSeq + 1) {
          return { ok: false, code: 'sequence_conflict' };
        }
        const checkpoint: RunCheckpoint = {
          ...previous,
          revision: previous.revision + 1,
          interjectSeq: interject.receivedSeq,
          pendingInterjects: [...previous.pendingInterjects, interject],
          updatedAt: now(),
        };
        await writeCheckpoint(path, checkpoint);
        return { ok: true, checkpoint, changed: true };
      });
    },
    async claimInterject({ threadId, runId, receivedSeq }) {
      const path = checkpointPath(root, threadId);
      return await runMutationSerial(path, async () => {
        const resolution = resolveRunMutationCheckpoint(
          await readThread(threadId),
          runId,
        );
        if (!resolution.ok) {
          return resolution;
        }
        const previous = resolution.checkpoint;
        if (previous.applyingInterject !== null) {
          return previous.applyingInterject.receivedSeq === receivedSeq
            ? { ok: true, checkpoint: previous, changed: false }
            : { ok: false, code: 'busy' };
        }
        const next = previous.pendingInterjects[0];
        if (next === undefined) {
          return { ok: false, code: 'not_pending' };
        }
        if (next.receivedSeq !== receivedSeq) {
          return {
            ok: false,
            code: previous.pendingInterjects.some(
              (interject) => interject.receivedSeq === receivedSeq,
            )
              ? 'busy'
              : 'not_pending',
          };
        }
        const checkpoint: RunCheckpoint = {
          ...previous,
          revision: previous.revision + 1,
          applyingInterject: next,
          pendingInterjects: previous.pendingInterjects.slice(1),
          updatedAt: now(),
        };
        await writeCheckpoint(path, checkpoint);
        return { ok: true, checkpoint, changed: true };
      });
    },
    async completeInterject({ threadId, runId, receivedSeq }) {
      const path = checkpointPath(root, threadId);
      return await runMutationSerial(path, async () => {
        const resolution = resolveRunMutationCheckpoint(
          await readThread(threadId),
          runId,
        );
        if (!resolution.ok) {
          return resolution;
        }
        const previous = resolution.checkpoint;
        if (previous.applyingInterject === null) {
          return { ok: false, code: 'not_pending' };
        }
        if (previous.applyingInterject.receivedSeq !== receivedSeq) {
          return { ok: false, code: 'busy' };
        }
        const checkpoint: RunCheckpoint = {
          ...previous,
          revision: previous.revision + 1,
          applyingInterject: null,
          updatedAt: now(),
        };
        await writeCheckpoint(path, checkpoint);
        return { ok: true, checkpoint, changed: true };
      });
    },
    async cancelInterject({ threadId, runId, receivedSeq }) {
      const path = checkpointPath(root, threadId);
      return await runMutationSerial(path, async () => {
        const resolution = resolveRunMutationCheckpoint(
          await readThread(threadId),
          runId,
        );
        if (!resolution.ok) {
          return resolution;
        }
        const previous = resolution.checkpoint;
        if (previous.applyingInterject?.receivedSeq === receivedSeq) {
          return { ok: true, checkpoint: previous, changed: false };
        }
        const index = previous.pendingInterjects.findIndex(
          (interject) => interject.receivedSeq === receivedSeq,
        );
        if (index < 0) {
          return { ok: true, checkpoint: previous, changed: false };
        }
        const pendingInterjects = [...previous.pendingInterjects];
        pendingInterjects.splice(index, 1);
        const checkpoint: RunCheckpoint = {
          ...previous,
          revision: previous.revision + 1,
          pendingInterjects,
          updatedAt: now(),
        };
        await writeCheckpoint(path, checkpoint);
        return { ok: true, checkpoint, changed: true };
      });
    },
    async recordApprovalPending({ threadId, runId, callId, approvalClass }) {
      const path = checkpointPath(root, threadId);
      return await runMutationSerial(path, async () => {
        const resolution = resolveRunMutationCheckpoint(
          await readThread(threadId),
          runId,
        );
        if (!resolution.ok) {
          return resolution;
        }
        const previous = resolution.checkpoint;
        const existing = previous.approvals.find(
          (approval) => approval.callId === callId,
        );
        if (existing !== undefined) {
          return existing.approvalClass === approvalClass
            ? {
                ok: true,
                checkpoint: previous,
                approval: existing,
                changed: false,
              }
            : { ok: false, code: 'approval_conflict' };
        }
        const approval: RunCheckpointApproval = {
          status: 'pending',
          callId,
          approvalClass,
        };
        const checkpoint: RunCheckpoint = {
          ...previous,
          revision: previous.revision + 1,
          approvals: [...previous.approvals, approval],
          updatedAt: now(),
        };
        await writeCheckpoint(path, checkpoint);
        return {
          ok: true,
          checkpoint,
          approval,
          changed: true,
        };
      });
    },
    async recordApprovalDecision({
      threadId,
      runId,
      callId,
      decision,
      grantScope,
      permissionMode,
    }) {
      const path = checkpointPath(root, threadId);
      return await runMutationSerial(path, async () => {
        const resolution = resolveRunMutationCheckpoint(
          await readThread(threadId),
          runId,
        );
        if (!resolution.ok) {
          return resolution;
        }
        const previous = resolution.checkpoint;
        const index = previous.approvals.findIndex(
          (approval) => approval.callId === callId,
        );
        const existing = previous.approvals[index];
        if (existing === undefined) {
          return { ok: false, code: 'approval_not_pending' };
        }
        if (decision === 'denied' && permissionMode !== undefined) {
          return { ok: false, code: 'approval_conflict' };
        }
        if (existing.status === 'decided') {
          return existing.decision === decision &&
            existing.grantScope === grantScope &&
            (permissionMode === undefined ||
              previous.request.permissionMode === permissionMode)
            ? {
                ok: true,
                checkpoint: previous,
                approval: existing,
                changed: false,
              }
            : { ok: false, code: 'approval_conflict' };
        }
        const approval: RunCheckpointApproval = {
          ...existing,
          status: 'decided',
          decision,
          grantScope,
        };
        const approvals = [...previous.approvals];
        approvals[index] = approval;
        const checkpoint: RunCheckpoint = {
          ...previous,
          revision: previous.revision + 1,
          request:
            decision === 'approved' && permissionMode !== undefined
              ? { ...previous.request, permissionMode }
              : previous.request,
          approvals,
          updatedAt: now(),
        };
        await writeCheckpoint(path, checkpoint);
        return {
          ok: true,
          checkpoint,
          approval,
          changed: true,
        };
      });
    },
    async appendRunEvents({ threadId, runId, events }) {
      if (events.length === 0) {
        return;
      }
      const path = checkpointPath(root, threadId);
      await runMutationSerial(path, async () => {
        if (runningRunIdByThread.get(threadId) !== runId) {
          const checkpoint = await readCheckpointFile(threadId);
          if (checkpoint === null || checkpoint.runId !== runId) {
            throw new Error(`run checkpoint not found: ${runId}`);
          }
          if (checkpoint.status !== 'running') {
            throw new Error(`run checkpoint is terminal: ${runId}`);
          }
        }
        await runEventJournal.append({ threadId, runId, events });
      });
    },
    async settleRun({ threadId, runId, terminal }) {
      const path = checkpointPath(root, threadId);
      return await runMutationSerial(path, async () => {
        const previous = await readThread(threadId);
        if (!previous || previous.runId !== runId) {
          throw new Error(`run checkpoint not found: ${runId}`);
        }
        if (previous.status === 'terminal') {
          if (
            previous.terminal === null ||
            !isSameTerminalSnapshot(previous.terminal, terminal)
          ) {
            throw new Error(`run terminal checkpoint conflict: ${runId}`);
          }
          return previous;
        }
        if (
          previous.applyingInterject !== null ||
          previous.pendingInterjects.length > 0
        ) {
          throw new Error(
            `run checkpoint still has pending interjects: ${runId}`,
          );
        }
        const checkpoint: RunCheckpoint = {
          ...previous,
          revision: previous.revision + 1,
          status: 'terminal',
          terminal: { ...terminal, acknowledged: false },
          updatedAt: now(),
        };
        await writeCheckpoint(path, checkpoint);
        runningRunIdByThread.delete(threadId);
        return checkpoint;
      });
    },
    async acknowledgeTerminalEvent({ threadId, runId, eventCursor }) {
      const path = checkpointPath(root, threadId);
      return await runMutationSerial(path, async () => {
        const previous = await readThread(threadId);
        if (previous === null || previous.runId !== runId) {
          return { ok: false, code: 'not_found' };
        }
        if (previous.status !== 'terminal' || previous.terminal === null) {
          return { ok: false, code: 'not_terminal' };
        }
        if (previous.terminal.eventCursor !== eventCursor) {
          return { ok: false, code: 'cursor_conflict' };
        }
        if (previous.terminal.acknowledged) {
          return { ok: true, checkpoint: previous, changed: false };
        }
        const checkpoint: RunCheckpoint = {
          ...previous,
          revision: previous.revision + 1,
          terminal: { ...previous.terminal, acknowledged: true },
          updatedAt: now(),
        };
        await writeCheckpoint(path, checkpoint);
        return { ok: true, checkpoint, changed: true };
      });
    },
  };
}

function checkpointPath(root: string, threadId: ThreadId): string {
  return join(root, `${assertThreadId(threadId)}.json`);
}

function isSameTerminalSnapshot(
  previous: RunCheckpointTerminalSnapshot,
  next: Omit<RunCheckpointTerminalSnapshot, 'acknowledged'>,
): boolean {
  if (
    previous.eventCursor !== next.eventCursor ||
    previous.event.type !== next.event.type
  ) {
    return false;
  }
  if (previous.event.type === 'done' && next.event.type === 'done') {
    return (
      previous.event.payload.answer === next.event.payload.answer &&
      previous.event.payload.ok === next.event.payload.ok
    );
  }
  if (previous.event.type === 'error' && next.event.type === 'error') {
    return (
      previous.event.payload.code === next.event.payload.code &&
      previous.event.payload.message === next.event.payload.message
    );
  }
  return false;
}

async function writeCheckpoint(
  path: string,
  checkpoint: RunCheckpoint,
): Promise<void> {
  const { eventHistory: _eventHistory, ...persistedCheckpoint } = checkpoint;
  await writeTextFileAtomically(
    path,
    `${JSON.stringify(persistedCheckpoint)}\n`,
    {
      mode: 0o600,
    },
  );
}

function parseRunCheckpoint(value: unknown): RunCheckpoint {
  if (
    !isRecord(value) ||
    value.schemaVersion !== RUN_CHECKPOINT_SCHEMA_VERSION ||
    !Number.isSafeInteger(value.revision) ||
    typeof value.revision !== 'number' ||
    value.revision < 1 ||
    (value.status !== 'running' && value.status !== 'terminal') ||
    typeof value.runId !== 'string' ||
    !isRunId(value.runId) ||
    typeof value.threadId !== 'string' ||
    !isThreadId(value.threadId) ||
    typeof value.createdAt !== 'string' ||
    typeof value.updatedAt !== 'string'
  ) {
    throw new Error('invalid run checkpoint');
  }
  const interjectSeq = parseInterjectSeq(value.interjectSeq);
  const applyingInterject =
    value.applyingInterject === undefined || value.applyingInterject === null
      ? null
      : parsePendingInterject(value.applyingInterject);
  const pendingInterjects =
    value.pendingInterjects === undefined
      ? []
      : parsePendingInterjects(value.pendingInterjects);
  const approvals =
    value.approvals === undefined
      ? []
      : parseCheckpointApprovals(value.approvals);
  const terminal =
    value.terminal === undefined || value.terminal === null
      ? null
      : parseRunCheckpointTerminalSnapshot(value.terminal);
  if (value.status === 'running' && terminal !== null) {
    throw new Error('running checkpoint cannot have terminal snapshot');
  }
  const orderedInterjects = [
    ...(applyingInterject === null ? [] : [applyingInterject]),
    ...pendingInterjects,
  ];
  if (
    orderedInterjects.some(
      (interject, index) =>
        interject.receivedSeq > interjectSeq ||
        (index > 0 &&
          interject.receivedSeq <=
            (orderedInterjects[index - 1]?.receivedSeq ?? 0)),
    )
  ) {
    throw new Error('invalid run checkpoint interject order');
  }
  return {
    schemaVersion: RUN_CHECKPOINT_SCHEMA_VERSION,
    revision: value.revision,
    status: value.status,
    runId: assertRunId(value.runId),
    threadId: assertThreadId(value.threadId),
    request: parseRecoverableRunRequest(value.request),
    interjectSeq,
    applyingInterject,
    pendingInterjects,
    approvals,
    eventHistory: [],
    terminal,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  };
}

function parseRunCheckpointTerminalSnapshot(
  value: unknown,
): RunCheckpointTerminalSnapshot {
  if (
    !isRecord(value) ||
    !Number.isSafeInteger(value.eventCursor) ||
    typeof value.eventCursor !== 'number' ||
    value.eventCursor < 0 ||
    typeof value.acknowledged !== 'boolean' ||
    !isRecord(value.event) ||
    !isRecord(value.event.payload)
  ) {
    throw new Error('invalid run checkpoint terminal snapshot');
  }
  if (
    value.event.type === 'done' &&
    typeof value.event.payload.answer === 'string' &&
    typeof value.event.payload.ok === 'boolean'
  ) {
    return {
      eventCursor: value.eventCursor,
      acknowledged: value.acknowledged,
      event: {
        type: 'done',
        payload: {
          answer: value.event.payload.answer,
          ok: value.event.payload.ok,
        },
      },
    };
  }
  if (
    value.event.type === 'error' &&
    isErrorEventPayload(value.event.payload)
  ) {
    return {
      eventCursor: value.eventCursor,
      acknowledged: value.acknowledged,
      event: {
        type: 'error',
        payload: value.event.payload,
      },
    };
  }
  throw new Error('invalid run checkpoint terminal event');
}

function parseInterjectSeq(value: unknown): number {
  if (value === undefined) {
    return 0;
  }
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error('invalid run checkpoint interject sequence');
  }
  return value;
}

function parsePendingInterjects(value: unknown): PendingInterject[] {
  if (!Array.isArray(value)) {
    throw new Error('invalid run checkpoint pending interjects');
  }
  return value.map(parsePendingInterject);
}

function parsePendingInterject(value: unknown): PendingInterject {
  if (
    !isRecord(value) ||
    typeof value.text !== 'string' ||
    typeof value.receivedSeq !== 'number' ||
    !Number.isSafeInteger(value.receivedSeq) ||
    value.receivedSeq < 1
  ) {
    throw new Error('invalid run checkpoint pending interject');
  }
  return { text: value.text, receivedSeq: value.receivedSeq };
}

function parseCheckpointApprovals(value: unknown): RunCheckpointApproval[] {
  if (!Array.isArray(value)) {
    throw new Error('invalid run checkpoint approvals');
  }
  const approvals = value.map(parseCheckpointApproval);
  if (
    new Set(approvals.map((approval) => approval.callId)).size !==
    approvals.length
  ) {
    throw new Error('invalid run checkpoint approval identities');
  }
  return approvals;
}

function parseCheckpointApproval(value: unknown): RunCheckpointApproval {
  if (
    !isRecord(value) ||
    typeof value.callId !== 'string' ||
    value.callId.length === 0 ||
    !isApprovalClass(value.approvalClass)
  ) {
    throw new Error('invalid run checkpoint approval');
  }
  if (value.status === 'pending') {
    return {
      status: value.status,
      callId: value.callId,
      approvalClass: value.approvalClass,
    };
  }
  if (
    value.status === 'decided' &&
    (value.decision === 'approved' || value.decision === 'denied') &&
    isApprovalGrantScope(value.grantScope)
  ) {
    return {
      status: value.status,
      callId: value.callId,
      approvalClass: value.approvalClass,
      decision: value.decision,
      grantScope: value.grantScope,
    };
  }
  throw new Error('invalid run checkpoint approval state');
}

function resolveRunMutationCheckpoint(
  checkpoint: RunCheckpoint | null,
  runId: RunId,
): { ok: true; checkpoint: RunCheckpoint } | RunCheckpointUnavailableResult {
  if (checkpoint === null || checkpoint.runId !== runId) {
    return { ok: false, code: 'not_found' };
  }
  if (checkpoint.status === 'terminal') {
    return { ok: false, code: 'terminal' };
  }
  return { ok: true, checkpoint };
}

function parseRecoverableRunRequest(value: unknown): RecoverableRunRequest {
  if (
    !isRecord(value) ||
    typeof value.workingDirectory !== 'string' ||
    !isPermissionMode(value.permissionMode)
  ) {
    throw new Error('invalid recoverable run request');
  }
  const providerModel = parseProviderModel(value.providerModel);
  const providerTransitionRecovery = parseProviderTransitionRecovery(
    value.providerTransitionRecovery,
    providerModel,
  );
  const loopImplementation = parseAgentLoopImplementationIdentity(
    value.loopImplementation,
  );
  const selection = parseSelection(value.selection);
  const toolSurface = parseToolSurface(value.toolSurface);
  const toolCapabilityPolicy = parseCheckpointToolCapabilityPolicy(
    value.toolCapabilityPolicy,
  );
  const planningWorkflow = parsePlanningWorkflowBinding(value.planningWorkflow);
  const goal = parseGoalBinding(value.goal);
  if (
    (value.currentFile !== undefined &&
      typeof value.currentFile !== 'string') ||
    (value.ultraReasoning !== undefined &&
      typeof value.ultraReasoning !== 'boolean') ||
    (value.reasoningEffort !== undefined &&
      !isRunReasoningEffort(value.reasoningEffort)) ||
    (value.serviceTier !== undefined && !isRunServiceTier(value.serviceTier)) ||
    (value.serviceTier === 'fast' &&
      providerModel?.providerId !== 'openai_codex_direct') ||
    (value.subagentModelRouting !== undefined &&
      !isRunSubagentModelRouting(value.subagentModelRouting)) ||
    (value.imageGenerationModel !== undefined &&
      !isImageGenerationModelId(value.imageGenerationModel)) ||
    (value.videoGenerationModel !== undefined &&
      !isVideoGenerationModelId(value.videoGenerationModel)) ||
    (value.videoGenerationSettings !== undefined &&
      !isVideoGenerationSettings(value.videoGenerationSettings)) ||
    (value.approvedPlanRef !== undefined &&
      !isApprovedPlanRef(value.approvedPlanRef)) ||
    (planningWorkflow !== undefined && value.approvedPlanRef !== undefined) ||
    (planningWorkflow !== undefined && goal !== undefined)
  ) {
    throw new Error('invalid recoverable run request');
  }
  if (toolSurface !== undefined && toolCapabilityPolicy !== undefined) {
    throw new Error(
      'recoverable run request cannot contain both toolSurface and toolCapabilityPolicy',
    );
  }
  return {
    workingDirectory: value.workingDirectory,
    permissionMode: value.permissionMode,
    ...(planningWorkflow === undefined ? {} : { planningWorkflow }),
    ...(value.approvedPlanRef === undefined
      ? {}
      : { approvedPlanRef: value.approvedPlanRef }),
    ...(goal === undefined ? {} : { goal }),
    ...(loopImplementation === undefined ? {} : { loopImplementation }),
    ...(providerModel === undefined ? {} : { providerModel }),
    ...(providerTransitionRecovery === undefined
      ? {}
      : { providerTransitionRecovery }),
    ...(value.currentFile === undefined
      ? {}
      : { currentFile: value.currentFile }),
    ...(selection === undefined ? {} : { selection }),
    ...(value.ultraReasoning === undefined
      ? {}
      : { ultraReasoning: value.ultraReasoning }),
    ...(value.reasoningEffort === undefined
      ? {}
      : { reasoningEffort: value.reasoningEffort }),
    ...(value.serviceTier === undefined
      ? {}
      : { serviceTier: value.serviceTier }),
    ...(value.subagentModelRouting === undefined
      ? {}
      : { subagentModelRouting: value.subagentModelRouting }),
    ...(toolSurface === undefined ? {} : { toolSurface }),
    ...(toolCapabilityPolicy === undefined ? {} : { toolCapabilityPolicy }),
    ...(value.imageGenerationModel === undefined
      ? {}
      : { imageGenerationModel: value.imageGenerationModel }),
    ...(value.videoGenerationModel === undefined
      ? {}
      : { videoGenerationModel: value.videoGenerationModel }),
    ...(value.videoGenerationSettings === undefined
      ? {}
      : { videoGenerationSettings: value.videoGenerationSettings }),
  };
}

function parsePlanningWorkflowBinding(
  value: unknown,
): RecoverableRunRequest['planningWorkflow'] {
  if (value === undefined) {
    return undefined;
  }
  if (
    !isRecord(value) ||
    typeof value.workflowId !== 'string' ||
    value.workflowId.trim() === ''
  ) {
    throw new Error('invalid recoverable planning workflow binding');
  }
  return {
    workflowId: value.workflowId,
  };
}

function parseGoalBinding(value: unknown): RecoverableRunRequest['goal'] {
  if (value === undefined) {
    return undefined;
  }
  if (
    !isRecord(value) ||
    typeof value.goalId !== 'string' ||
    value.goalId.trim() === ''
  ) {
    throw new Error('invalid recoverable Goal binding');
  }
  return {
    goalId: value.goalId,
  };
}

function parseProviderTransitionRecovery(
  value: unknown,
  target: RecoverableRunRequest['providerModel'],
): RunProviderTransitionRecovery | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (
    target === undefined ||
    !isRunModelId(target.model) ||
    resolveRunModelDescriptor(target.model).providerId !== target.providerId ||
    !isRunProviderTransitionRecovery(value, target.model)
  ) {
    throw new Error('invalid recoverable provider transition recovery');
  }
  return value;
}

function parseAgentLoopImplementationIdentity(
  value: unknown,
): RecoverableRunRequest['loopImplementation'] {
  if (value === undefined) {
    return undefined;
  }
  if (
    !isRecord(value) ||
    typeof value.implementationId !== 'string' ||
    value.implementationId.trim().length === 0 ||
    typeof value.contractVersion !== 'string' ||
    value.contractVersion.trim().length === 0
  ) {
    throw new Error('invalid recoverable agent loop implementation identity');
  }
  return {
    implementationId: value.implementationId,
    contractVersion: value.contractVersion,
  };
}

function parseProviderModel(
  value: unknown,
): RecoverableRunRequest['providerModel'] {
  if (value === undefined) {
    return undefined;
  }
  if (
    !isRecord(value) ||
    !isRunProviderId(value.providerId) ||
    typeof value.model !== 'string'
  ) {
    throw new Error('invalid run checkpoint provider model');
  }
  return { providerId: value.providerId, model: value.model };
}

function parseSelection(value: unknown): RecoverableRunRequest['selection'] {
  if (value === undefined) {
    return undefined;
  }
  if (
    !isRecord(value) ||
    !Number.isInteger(value.startLine) ||
    typeof value.startLine !== 'number' ||
    !Number.isInteger(value.endLine) ||
    typeof value.endLine !== 'number' ||
    typeof value.text !== 'string'
  ) {
    throw new Error('invalid run checkpoint selection');
  }
  return {
    startLine: value.startLine,
    endLine: value.endLine,
    text: value.text,
  };
}

function parseCheckpointToolCapabilityPolicy(
  value: unknown,
): ToolCapabilityPolicy | undefined {
  if (value === undefined) {
    return undefined;
  }
  try {
    return validateToolCapabilityPolicy(value);
  } catch {
    throw new Error('invalid run checkpoint tool capability policy');
  }
}

function parseToolSurface(
  value: unknown,
): RecoverableRunRequest['toolSurface'] {
  if (value === undefined) {
    return undefined;
  }
  if (
    !isRecord(value) ||
    !isStringArray(value.directRegistryNames) ||
    !isStringArray(value.allowedRegistryNames)
  ) {
    throw new Error('invalid run checkpoint tool surface');
  }
  return {
    directRegistryNames: [...value.directRegistryNames],
    allowedRegistryNames: [...value.allowedRegistryNames],
  };
}

function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((entry) => typeof entry === 'string')
  );
}

function isMissingFileError(error: unknown): boolean {
  return isRecord(error) && error.code === 'ENOENT';
}
