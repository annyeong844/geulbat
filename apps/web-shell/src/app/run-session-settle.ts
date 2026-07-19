import { getErrorMessage } from '../lib/error-message.js';
import { createLogger } from '@geulbat/shared-utils/logger';
import type { ThreadDetailResponse } from '@geulbat/protocol/threads';

const runSettleLogger = createLogger('run-settle');

interface SettleRunFollowUpEffectsArgs {
  selectedFile: string | null;
  loadThreads: () => Promise<void>;
  openFile: (path: string) => Promise<void>;
}

export async function settleRunFollowUpEffects({
  selectedFile,
  loadThreads,
  openFile,
}: SettleRunFollowUpEffectsArgs): Promise<PromiseSettledResult<void>[]> {
  return Promise.allSettled(
    createSettleRunFollowUpTasks({
      selectedFile,
      loadThreads,
      openFile,
    }),
  );
}

interface SettleRunEffectsArgs {
  threadId: string;
  selectedFile: string | null;
  loadThreads: () => Promise<void>;
  openThreadForRunSettle: (
    threadId: string,
  ) => Promise<ThreadDetailResponse | null>;
  openFile: (path: string) => Promise<void>;
}

type SettleRunEffectsResult = [
  PromiseSettledResult<ThreadDetailResponse | null>,
  ...PromiseSettledResult<void>[],
];

export async function settleRunEffects({
  threadId,
  selectedFile,
  loadThreads,
  openThreadForRunSettle,
  openFile,
}: SettleRunEffectsArgs): Promise<SettleRunEffectsResult> {
  const tasks: [Promise<ThreadDetailResponse | null>, ...Promise<void>[]] = [
    openThreadForRunSettle(threadId),
    ...createSettleRunFollowUpTasks({
      selectedFile,
      loadThreads,
      openFile,
    }),
  ];

  return Promise.allSettled(tasks) as Promise<SettleRunEffectsResult>;
}

export function logSettleRunEffectFailures(
  results: readonly PromiseSettledResult<unknown>[],
) {
  for (const result of results) {
    if (result.status === 'rejected') {
      runSettleLogger.error(
        'run settle failed:',
        getErrorMessage(result.reason),
      );
    }
  }
}

function createSettleRunFollowUpTasks({
  selectedFile,
  loadThreads,
  openFile,
}: SettleRunFollowUpEffectsArgs): Promise<void>[] {
  const tasks: Promise<void>[] = [loadThreads()];
  if (selectedFile) {
    tasks.push(openFile(selectedFile));
  }
  return tasks;
}
