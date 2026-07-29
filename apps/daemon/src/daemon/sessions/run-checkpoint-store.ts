// 런 체크포인트의 **원자적 상태 전이**를 소유한다.
//
// 체크포인트는 스레드당 파일 하나이고(`checkpointPath`), 모든 갱신은 그 레코드
// 전체를 원자적으로 교체하며(`writeCheckpoint` → atomic write) 스레드 키로
// 직렬화된다(`createKeyedSerialRunner`). 그래서 approval·interject·tool 결과·런
// 수명은 **관심사가 달라 보여도 store를 나눌 수 없다** — 나누면 여러 owner가 같은
// 파일을 쓰게 되어 그 원자성이 깨진다. 크기를 이유로 다시 쪼개지 않는다.
//
// 저장된 값을 도메인 값으로 바꾸는 일은 이 파일의 일이 아니다. 그 경계는
// `run-checkpoint-persistence`가 소유하고, 여기서는 파싱 결과를 값으로 받는다.

import { readdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';

import {
  assertThreadId,
  type RunId,
  type ThreadId,
} from '@geulbat/protocol/ids';
import type {
  ApprovalClass,
  ApprovalGrantScope,
  PermissionMode,
} from '@geulbat/protocol/run-approval';
import { createLogger } from '@geulbat/structured-logger/logger';

import type { JsonValue } from '../runtime-json.js';

import { writeTextFileAtomically } from '../utils/atomic-file.js';
import { getErrorMessage } from '../utils/error.js';
import { createKeyedSerialRunner } from '../utils/keyed-serial.js';
import {
  RUN_CHECKPOINT_SCHEMA_VERSION,
  isMissingFileError,
  parseRunCheckpoint,
} from './run-checkpoint-persistence.js';
import type {
  RecoverableRunRequest,
  RunCheckpoint,
  RunCheckpointApproval,
  RunCheckpointTerminalSnapshot,
  RunCheckpointToolResultReady,
} from './run-checkpoint-persistence.js';
import type {
  ExecuteResult,
  RunCheckpointToolInvocation,
} from '../runtime-contracts.js';
import type { PendingInterject } from './active-run-interject-buffer.js';
import {
  createRunEventJournalStore,
  type RunCheckpointEvent,
} from './run-event-journal.js';

const logger = createLogger('sessions/run-checkpoint-store');

export type { RunCheckpointEvent } from './run-event-journal.js';
export type { RunCheckpointToolInvocation } from '../runtime-contracts.js';

export type {
  RecoverableRunRequest,
  RunCheckpoint,
  RunCheckpointApproval,
  RunCheckpointTerminalEvent,
  RunCheckpointToolResultReady,
} from './run-checkpoint-persistence.js';

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

type RunCheckpointToolResultMutationResult =
  | { ok: true; checkpoint: RunCheckpoint; changed: boolean }
  | RunCheckpointUnavailableResult
  | { ok: false; code: 'tool_result_conflict' };

type RunCheckpointToolInvocationMutationResult =
  | { ok: true; checkpoint: RunCheckpoint; changed: boolean }
  | RunCheckpointUnavailableResult
  | { ok: false; code: 'tool_invocation_conflict' };

export interface RunCheckpointStore {
  readThread(threadId: ThreadId): Promise<RunCheckpoint | null>;
  hasRunningRun(args: { threadId: ThreadId; runId: RunId }): Promise<boolean>;
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
  recordApprovalDecision(
    args: {
      threadId: ThreadId;
      runId: RunId;
      callId: string;
    } & (
      | {
          decision: 'approved' | 'denied';
          grantScope: ApprovalGrantScope;
          permissionMode?: PermissionMode;
        }
      | {
          decision: 'aborted';
          grantScope?: undefined;
          permissionMode?: undefined;
        }
    ),
  ): Promise<RunCheckpointApprovalMutationResult>;
  recordToolResultReady(args: {
    threadId: ThreadId;
    runId: RunId;
    ready: RunCheckpointToolResultReady;
  }): Promise<RunCheckpointToolResultMutationResult>;
  recordToolInvocation(args: {
    threadId: ThreadId;
    runId: RunId;
    invocation: Omit<
      Extract<RunCheckpointToolInvocation, { status: 'in_flight' }>,
      'status'
    >;
  }): Promise<RunCheckpointToolInvocationMutationResult>;
  recordToolInvocationResult(args: {
    threadId: ThreadId;
    runId: RunId;
    callId: string;
    toolName: string;
    result: ExecuteResult;
  }): Promise<RunCheckpointToolInvocationMutationResult>;
  completeToolResultReady(args: {
    threadId: ThreadId;
    runId: RunId;
    callId: string;
    resultRef: string;
  }): Promise<RunCheckpointToolResultMutationResult>;
  appendRunEvents(args: {
    threadId: ThreadId;
    runId: RunId;
    events: readonly RunCheckpointEvent[];
  }): Promise<void>;
  settleRun(args: {
    threadId: ThreadId;
    runId: RunId;
    terminal: Omit<RunCheckpointTerminalSnapshot, 'acknowledged'>;
    discardPendingInterjects?: boolean;
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
    const checkpointNames = names
      .filter((name) => name.endsWith('.json'))
      .sort();
    // 열거는 스레드 하나의 손상을 그 스레드에 가둔다. 체크포인트나 저널이
    // 깨지는 일은 실제로 일어난다(예: append 중 크래시로 저널 마지막 줄이
    // 반쪽으로 남는다). 그때 이 열거가 통째로 실패하면 부팅 복구가 첫 줄에서
    // 죽어 데몬이 서지 못하고, 재시작해도 같은 파일을 다시 읽으므로 손상 하나가
    // 제품 전체를 영구히 세운다.
    //
    // 손상된 것을 조용히 성공으로 만들지는 않는다: 그 스레드는 열거에서 빠지고
    // 이유가 진단으로 남으며, `readThread`로 그 스레드를 **명시적으로** 물으면
    // 여전히 거부된다.
    const settled = await Promise.allSettled(
      checkpointNames.map(async (name) => {
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
    const checkpoints: RunCheckpoint[] = [];
    for (const [index, result] of settled.entries()) {
      if (result.status === 'fulfilled') {
        checkpoints.push(result.value);
        continue;
      }
      logger.error('run checkpoint excluded from enumeration:', {
        checkpointFile: checkpointNames[index],
        message: getErrorMessage(result.reason),
      });
    }
    return checkpoints;
  }

  return {
    readThread,
    async hasRunningRun({ threadId, runId }) {
      const checkpoint = await readCheckpointFile(threadId);
      return checkpoint?.status === 'running' && checkpoint.runId === runId;
    },
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
          toolInvocations: [],
          toolResultsReady: [],
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
          const isSameDecision =
            existing.decision === decision &&
            (decision === 'aborted' ||
              (existing.decision !== 'aborted' &&
                existing.grantScope === grantScope &&
                (permissionMode === undefined ||
                  previous.request.permissionMode === permissionMode)));
          return isSameDecision
            ? {
                ok: true,
                checkpoint: previous,
                approval: existing,
                changed: false,
              }
            : { ok: false, code: 'approval_conflict' };
        }
        const approval: RunCheckpointApproval =
          decision === 'aborted'
            ? {
                ...existing,
                status: 'decided',
                decision,
              }
            : {
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
    async recordToolInvocation({ threadId, runId, invocation }) {
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
        const existing = previous.toolInvocations.find(
          (candidate) => candidate.callId === invocation.callId,
        );
        if (existing !== undefined) {
          return existing.toolName === invocation.toolName &&
            existing.recoveryStrategy === invocation.recoveryStrategy &&
            isSameJsonValue(existing.recoveryState, invocation.recoveryState)
            ? { ok: true, checkpoint: previous, changed: false }
            : { ok: false, code: 'tool_invocation_conflict' };
        }
        const checkpoint: RunCheckpoint = {
          ...previous,
          revision: previous.revision + 1,
          toolInvocations: [
            ...previous.toolInvocations,
            {
              status: 'in_flight',
              callId: invocation.callId,
              toolName: invocation.toolName,
              recoveryStrategy: invocation.recoveryStrategy,
              recoveryState: structuredClone(invocation.recoveryState),
            },
          ],
          updatedAt: now(),
        };
        await writeCheckpoint(path, checkpoint);
        return { ok: true, checkpoint, changed: true };
      });
    },
    async recordToolInvocationResult({
      threadId,
      runId,
      callId,
      toolName,
      result,
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
        const index = previous.toolInvocations.findIndex(
          (invocation) => invocation.callId === callId,
        );
        const existing = previous.toolInvocations[index];
        if (existing === undefined || existing.toolName !== toolName) {
          return { ok: false, code: 'tool_invocation_conflict' };
        }
        if (existing.status === 'reconciled') {
          return isSameExecuteResult(existing.result, result)
            ? { ok: true, checkpoint: previous, changed: false }
            : { ok: false, code: 'tool_invocation_conflict' };
        }
        const toolInvocations = [...previous.toolInvocations];
        toolInvocations[index] = {
          ...existing,
          status: 'reconciled',
          result: structuredClone(result),
        };
        const checkpoint: RunCheckpoint = {
          ...previous,
          revision: previous.revision + 1,
          toolInvocations,
          updatedAt: now(),
        };
        await writeCheckpoint(path, checkpoint);
        return { ok: true, checkpoint, changed: true };
      });
    },
    async recordToolResultReady({ threadId, runId, ready }) {
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
        const invocation = previous.toolInvocations.find(
          (candidate) => candidate.callId === ready.callId,
        );
        if (
          invocation?.status === 'in_flight' ||
          (invocation !== undefined && invocation.toolName !== ready.toolName)
        ) {
          return { ok: false, code: 'tool_result_conflict' };
        }
        const existing = previous.toolResultsReady.find(
          (result) =>
            result.callId === ready.callId ||
            result.resultRef === ready.resultRef,
        );
        if (existing !== undefined) {
          return existing.callId === ready.callId &&
            existing.toolName === ready.toolName &&
            existing.resultRef === ready.resultRef
            ? { ok: true, checkpoint: previous, changed: false }
            : { ok: false, code: 'tool_result_conflict' };
        }
        const checkpoint: RunCheckpoint = {
          ...previous,
          revision: previous.revision + 1,
          toolResultsReady: [...previous.toolResultsReady, { ...ready }],
          updatedAt: now(),
        };
        await writeCheckpoint(path, checkpoint);
        return { ok: true, checkpoint, changed: true };
      });
    },
    async completeToolResultReady({ threadId, runId, callId, resultRef }) {
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
        const index = previous.toolResultsReady.findIndex(
          (ready) => ready.callId === callId,
        );
        const invocationIndex = previous.toolInvocations.findIndex(
          (invocation) => invocation.callId === callId,
        );
        const invocation = previous.toolInvocations[invocationIndex];
        if (invocation?.status === 'in_flight') {
          return { ok: false, code: 'tool_result_conflict' };
        }
        if (index < 0) {
          if (
            previous.toolResultsReady.some(
              (ready) => ready.resultRef === resultRef,
            )
          ) {
            return { ok: false, code: 'tool_result_conflict' };
          }
          if (invocation !== undefined) {
            return { ok: false, code: 'tool_result_conflict' };
          }
          return { ok: true, checkpoint: previous, changed: false };
        }
        if (previous.toolResultsReady[index]?.resultRef !== resultRef) {
          return { ok: false, code: 'tool_result_conflict' };
        }
        if (
          invocation !== undefined &&
          invocation.toolName !== previous.toolResultsReady[index]?.toolName
        ) {
          return { ok: false, code: 'tool_result_conflict' };
        }
        const toolResultsReady = [...previous.toolResultsReady];
        toolResultsReady.splice(index, 1);
        const toolInvocations = [...previous.toolInvocations];
        if (invocation !== undefined) {
          toolInvocations.splice(invocationIndex, 1);
        }
        const checkpoint: RunCheckpoint = {
          ...previous,
          revision: previous.revision + 1,
          toolInvocations,
          toolResultsReady,
          updatedAt: now(),
        };
        await writeCheckpoint(path, checkpoint);
        return { ok: true, checkpoint, changed: true };
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
    async settleRun({
      threadId,
      runId,
      terminal,
      discardPendingInterjects = false,
    }) {
      const path = checkpointPath(root, threadId);
      return await runMutationSerial(path, async () => {
        const previous = await readThread(threadId);
        if (!previous || previous.runId !== runId) {
          throw new Error(`run checkpoint not found: ${runId}`);
        }
        if (
          discardPendingInterjects &&
          (terminal.event.type !== 'error' ||
            terminal.event.payload.code !== 'aborted')
        ) {
          throw new Error(
            `only an aborted terminal can discard pending interjects: ${runId}`,
          );
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
          !discardPendingInterjects &&
          (previous.applyingInterject !== null ||
            previous.pendingInterjects.length > 0)
        ) {
          throw new Error(
            `run checkpoint still has pending interjects: ${runId}`,
          );
        }
        if (previous.toolResultsReady.length > 0) {
          throw new Error(
            `run checkpoint still has ready tool results: ${runId}`,
          );
        }
        if (previous.toolInvocations.length > 0) {
          throw new Error(
            `run checkpoint still has tool invocations: ${runId}`,
          );
        }
        const checkpoint: RunCheckpoint = {
          ...previous,
          revision: previous.revision + 1,
          status: 'terminal',
          applyingInterject: null,
          pendingInterjects: [],
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

/**
 * 스레드 삭제 시 그 스레드의 run checkpoint를 함께 지운다. 남겨두면 사라진
 * 스레드의 복구 후보가 계속 목록에 오른다.
 */
export async function deleteThreadRunCheckpoint(
  stateRoot: string,
  threadId: ThreadId,
): Promise<boolean> {
  const path = checkpointPath(
    join(stateRoot, '.geulbat', 'run-checkpoints'),
    threadId,
  );
  try {
    await rm(path);
    return true;
  } catch (error: unknown) {
    if (isMissingFileError(error)) {
      return false;
    }
    throw error;
  }
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

function isSameJsonValue(left: JsonValue, right: JsonValue): boolean {
  return isDeepStrictEqual(left, right);
}

function isSameExecuteResult(
  left: ExecuteResult,
  right: ExecuteResult,
): boolean {
  return isDeepStrictEqual(left, right);
}
