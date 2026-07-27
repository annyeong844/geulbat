import type { CancelRequest } from '@geulbat/protocol/cancel';
import type { ThreadArtifactVersion } from '@geulbat/protocol/artifacts';
import type { ApprovalRequest } from '@geulbat/protocol/run-approval';
import type { RunChannelServerMessage } from '@geulbat/protocol/run-channel';
import type { RunStartRequest } from '@geulbat/protocol/run-contract';
import type { ThreadDetailResponse } from '@geulbat/protocol/threads';

import type {
  RunSessionControllerClient,
  useRunSession,
} from '../app/use-run-session.js';
import { THREAD_ID } from './run-session-fixtures.js';

// useRunSession 훅 테스트 하네스. use-run-session.test.ts 안의 지역 하네스였고,
// 테마별 훅 테스트로 나눌 때 네 파일이 같은 하네스를 쓰도록 여기로 올렸다.
// 본문은 이동 전과 동일하며, `createPersistedThreadDetail`만 이름을 바꿨다:
// run-session-fixtures.ts가 같은 이름으로 다른 fixture(고정 메시지, 인자 없음)를
// 이미 export하므로, 동명 export 두 개를 만들지 않기 위해 여기서는
// `createPersistedThreadDetailWithOverrides`로 두고 호출부가 별칭 import한다.
export type UseRunSessionArgs = Parameters<typeof useRunSession>[0];

export interface RunSessionClientHarness {
  createClient: () => RunSessionControllerClient;
  emit: (message: RunChannelServerMessage) => void;
  createClientCalls: () => number;
  connectCalls: () => number;
  closeCalls: () => number;
  subscribeCount: () => number;
  unsubscribeCount: () => number;
  threadSubscriptionCalls: () => string[];
}

export function createPersistedThreadDetailWithOverrides(args?: {
  snapshotVersion?: string;
  messages?: ThreadDetailResponse['messages'];
  artifacts?: ThreadArtifactVersion[];
}): ThreadDetailResponse {
  return {
    threadId: THREAD_ID,
    snapshotVersion: args?.snapshotVersion ?? '2026-04-16T00:00:00.000Z',
    messages: args?.messages ?? [],
    artifacts: args?.artifacts ?? [],
  };
}

export function createRunSessionArgs(
  overrides: Partial<UseRunSessionArgs> = {},
): UseRunSessionArgs {
  return {
    selectedFile: null,
    selectedThreadId: null,
    newSessionGeneration: 0,
    activeModelId: null,
    runPreferences: null,
    loadThreads: async () => {},
    loadTree: async () => {},
    openThreadForRunSettle: async () => null,
    openFile: async () => {},
    appendOptimisticUserMessage: () => {},
    trimMessagesForRegenerate: () => {},
    setSelectedThreadId: () => {},
    prepareStartRequest: async (request) => ({
      ...(request.displayPrompt !== undefined
        ? { displayPrompt: request.displayPrompt }
        : {}),
      ...(request.threadId !== undefined ? { threadId: request.threadId } : {}),
      ...(request.workingDirectory !== undefined
        ? { workingDirectory: request.workingDirectory }
        : {}),
      ...(request.modelId !== undefined ? { modelId: request.modelId } : {}),
      ...(request.currentFile !== undefined
        ? { currentFile: request.currentFile }
        : {}),
      ...(request.permissionMode !== undefined
        ? { permissionMode: request.permissionMode }
        : {}),
      ...(request.planModeRequested !== undefined
        ? { planModeRequested: request.planModeRequested }
        : {}),
      ...(request.planModeIntensity !== undefined
        ? { planModeIntensity: request.planModeIntensity }
        : {}),
      ...(request.planModeDepth !== undefined
        ? { planModeDepth: request.planModeDepth }
        : {}),
      ...(request.reasoningEffort !== undefined
        ? { reasoningEffort: request.reasoningEffort }
        : {}),
      ...(request.providerTransitionRecovery !== undefined
        ? {
            providerTransitionRecovery: request.providerTransitionRecovery,
          }
        : {}),
      ...(request.serviceTier !== undefined
        ? { serviceTier: request.serviceTier }
        : {}),
      ...(request.subagentModelRouting !== undefined
        ? { subagentModelRouting: request.subagentModelRouting }
        : {}),
      promptRef: 'run-prompt-input:11111111-1111-4111-8111-111111111111',
    }),
    ...overrides,
  };
}

export function createRunSessionClientHarness(overrides?: {
  start?: (request: RunStartRequest) => Promise<string>;
  approve?: (request: ApprovalRequest) => Promise<string>;
  cancel?: (request: CancelRequest) => Promise<string>;
  connect?: () => Promise<unknown>;
  close?: () => void;
  getActiveRunForThread?: RunSessionControllerClient['getActiveRunForThread'];
  interject?: RunSessionControllerClient['interject'];
  subscribeThread?: RunSessionControllerClient['subscribeThread'];
}): RunSessionClientHarness {
  let listener: ((message: RunChannelServerMessage) => void) | null = null;
  let createClientCalls = 0;
  let connectCalls = 0;
  let closeCalls = 0;
  let subscribeCount = 0;
  let unsubscribeCount = 0;
  const threadSubscriptionCalls: string[] = [];

  const client: RunSessionControllerClient = {
    async acknowledgeEvent() {
      return 'req-event-ack';
    },
    subscribe(callback) {
      subscribeCount += 1;
      listener = callback;
      return () => {
        unsubscribeCount += 1;
        if (listener === callback) {
          listener = null;
        }
      };
    },
    close() {
      closeCalls += 1;
      overrides?.close?.();
    },
    async interject(request) {
      if (overrides?.interject) {
        return await overrides.interject(request);
      }
      return { requestId: 'req-interject', receivedSeq: 1 };
    },
    async cancelInterject() {
      return { cancelled: true };
    },
    async flushInterject() {
      return { flushed: true };
    },
    async tool() {
      return { ok: true, output: 'tool-ok' };
    },
    async start(request) {
      if (overrides?.start) {
        return await overrides.start(request);
      }
      throw new Error('start not implemented in client harness');
    },
    async approve(request) {
      if (overrides?.approve) {
        return await overrides.approve(request);
      }
      throw new Error('approve not implemented in client harness');
    },
    async cancel(request) {
      if (overrides?.cancel) {
        return await overrides.cancel(request);
      }
      throw new Error('cancel not implemented in client harness');
    },
    async cancelChild() {
      return 'req-child-cancel';
    },
    async planCommand(request) {
      return {
        type: 'run.control',
        requestId: 'req-plan-command',
        action: 'plan.command',
        ok: true,
        commandKind: request.kind,
        snapshot: null,
      };
    },
    async goalCommand(request) {
      return {
        type: 'run.control',
        requestId: 'req-goal-command',
        action: 'goal.command',
        ok: true,
        commandKind: request.kind,
        snapshot: null,
      };
    },
    async subscribeThread(threadId) {
      threadSubscriptionCalls.push(threadId);
      await overrides?.subscribeThread?.(threadId);
    },
    async connect() {
      connectCalls += 1;
      if (overrides?.connect) {
        return await overrides.connect();
      }
      return {};
    },
    getActiveRunForThread(threadId) {
      return overrides?.getActiveRunForThread?.(threadId) ?? null;
    },
  };

  return {
    createClient() {
      createClientCalls += 1;
      return client;
    },
    emit(message) {
      if (listener === null) {
        throw new Error('run session listener was not registered');
      }
      listener(message);
    },
    createClientCalls: () => createClientCalls,
    connectCalls: () => connectCalls,
    closeCalls: () => closeCalls,
    subscribeCount: () => subscribeCount,
    unsubscribeCount: () => unsubscribeCount,
    threadSubscriptionCalls: () => threadSubscriptionCalls.slice(),
  };
}
