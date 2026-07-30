import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

import { assertRunId, assertThreadId } from '@geulbat/protocol/ids';

import { createDaemonContext as createBaseDaemonContext } from '../daemon/context.js';
import type {
  DurableSubagentLaunchRequest,
  SubagentLaunchRequestInput,
  SubagentLaunchRequestStore,
} from '../daemon/subagent-runtime-contracts.js';

export function createAgentSpawnDaemonContext(
  options: Parameters<typeof createBaseDaemonContext>[0] = {},
): ReturnType<typeof createBaseDaemonContext> {
  return createBaseDaemonContext({
    ...options,
    subagentLaunchRequests: createTestSubagentLaunchRequestStore(),
  });
}

function createTestSubagentLaunchRequestStore(): SubagentLaunchRequestStore {
  const requests = new Map<string, DurableSubagentLaunchRequest>();
  const launchInputs = new Map<string, SubagentLaunchRequestInput>();
  let enqueueOrder = 0;
  const keyOf = (parentRunId: string, toolCallId: string) =>
    `${parentRunId}\u0000${toolCallId}`;
  const update = (
    childRunId: string,
    launchState: DurableSubagentLaunchRequest['launchState'],
    failureReason: string | null,
  ): void => {
    const current = [...requests.values()].find(
      (request) => request.childRunId === childRunId,
    );
    assert.ok(current, `expected durable launch request ${childRunId}`);
    requests.set(keyOf(current.parentRunId, current.toolCallId), {
      ...current,
      launchState,
      deferReason: null,
      failureReason,
      updatedAt: new Date().toISOString(),
    });
  };

  return {
    enqueueSubagentLaunchBatch(inputs) {
      const batchId = inputs.length > 1 ? randomUUID() : null;
      return inputs.map((input, batchPosition) => {
        const timestamp = new Date().toISOString();
        const request: DurableSubagentLaunchRequest = {
          enqueueOrder: (enqueueOrder += 1),
          childRunId: assertRunId(randomUUID()),
          childThreadId: assertThreadId(randomUUID()),
          previousChildRunId: null,
          parentRunId: input.parentRunId,
          ownerThreadId: input.ownerThreadId,
          toolCallId: input.toolCallId,
          batchId,
          batchPosition,
          launchState: 'queued',
          priorityClass: 'normal',
          deferReason: null,
          createdAt: timestamp,
          updatedAt: timestamp,
          failureReason: null,
          runtime: {
            phase: 'queued',
            observedAt: timestamp,
            partialOutputAvailable: false,
          },
        };
        requests.set(keyOf(input.parentRunId, input.toolCallId), request);
        launchInputs.set(request.childRunId, input);
        return request;
      });
    },
    readSubagentLaunchRequest({ parentRunId, toolCallId }) {
      return requests.get(keyOf(parentRunId, toolCallId));
    },
    readSubagentLaunchRequestByChildRunId(childRunId) {
      return [...requests.values()].find(
        (request) => request.childRunId === childRunId,
      );
    },
    readSubagentLaunchInput(childRunId) {
      const input = launchInputs.get(childRunId);
      assert.ok(input, `expected durable launch input ${childRunId}`);
      return input;
    },
    readQueuedSubagentLaunchRequests() {
      const priorityOrder = { high: 0, normal: 1, low: 2 } as const;
      return [...requests.values()]
        .filter((request) => request.launchState === 'queued')
        .sort(
          (left, right) =>
            priorityOrder[left.priorityClass] -
              priorityOrder[right.priorityClass] ||
            left.enqueueOrder - right.enqueueOrder,
        );
    },
    markSubagentLaunchDeferredBatch({ childRunIds, deferReason }) {
      return childRunIds.map((childRunId) => {
        const current = [...requests.values()].find(
          (request) => request.childRunId === childRunId,
        );
        assert.ok(current);
        assert.equal(current.launchState, 'queued');
        const updated = {
          ...current,
          deferReason,
          updatedAt: new Date().toISOString(),
        };
        requests.set(keyOf(current.parentRunId, current.toolCallId), updated);
        return updated;
      });
    },
    cancelQueuedSubagentLaunchRequest({ childRunId, ownerThreadId }) {
      const current = [...requests.values()].find(
        (request) => request.childRunId === childRunId,
      );
      assert.ok(current);
      assert.equal(current.ownerThreadId, ownerThreadId);
      if (current.launchState === 'queued') {
        update(childRunId, 'cancelled', null);
      }
      const updated = [...requests.values()].find(
        (request) => request.childRunId === childRunId,
      );
      assert.ok(updated);
      return updated;
    },
    updateQueuedSubagentLaunchPriority({
      childRunId,
      ownerThreadId,
      priorityClass,
    }) {
      const current = [...requests.values()].find(
        (request) => request.childRunId === childRunId,
      );
      assert.ok(current);
      assert.equal(current.ownerThreadId, ownerThreadId);
      if (
        current.launchState === 'queued' &&
        current.priorityClass !== priorityClass
      ) {
        requests.set(keyOf(current.parentRunId, current.toolCallId), {
          ...current,
          priorityClass,
          updatedAt: new Date().toISOString(),
        });
      }
      const updated = [...requests.values()].find(
        (request) => request.childRunId === childRunId,
      );
      assert.ok(updated);
      return updated;
    },
    retryInterruptedSubagentLaunch() {
      throw new Error(
        'agent_spawn test store does not retry interrupted launches',
      );
    },
    markSubagentLaunchStarting(childRunId) {
      update(childRunId, 'starting', null);
    },
    markSubagentLaunchStarted(childRunId) {
      update(childRunId, 'started', null);
    },
    markSubagentLaunchFailedToStart({ childRunId, reason }) {
      update(childRunId, 'failed_to_start', reason);
    },
    recordSubagentRuntimeObservation({ childRunId, runtime }) {
      const current = [...requests.values()].find(
        (request) => request.childRunId === childRunId,
      );
      assert.ok(current);
      requests.set(keyOf(current.parentRunId, current.toolCallId), {
        ...current,
        runtime,
        updatedAt: runtime.observedAt,
      });
    },
  };
}
