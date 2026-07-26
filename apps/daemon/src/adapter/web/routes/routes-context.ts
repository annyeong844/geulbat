import type { RunId } from '@geulbat/protocol/ids';
import type { ProviderAuthCallbackServerController } from '../../../daemon/auth/bootstrap/callback-server.js';
import type { ProviderAuthBootstrapStore } from '../../../daemon/auth/bootstrap/session-store.js';
import type { ProviderAuthRuntimeStore } from '../../../daemon/auth/runtime-state.js';
import type { BackgroundNotificationQueue } from '../../../daemon/agent/runtime/background-notification-queue.js';
import type {
  PrepareProviderTransitionCompactionArgs,
  PrepareProviderTransitionCompactionResult,
} from '../../../daemon/agent/memory/provider-transition-compaction.js';

type PrepareThreadProviderTransitionArgs = Pick<
  PrepareProviderTransitionCompactionArgs,
  'workspaceRoot' | 'threadId' | 'source' | 'target' | 'reasoningEffort'
>;

export interface ThreadsRoutesContext {
  homeStateRoot: string;
  activeRuns: ActiveThreadRunLookup;
  backgroundNotifications: Pick<
    BackgroundNotificationQueue,
    'clearThreadBackgroundResults' | 'readThreadBackgroundResultHistory'
  >;
  providerTransitionCompaction: {
    prepare(
      args: PrepareThreadProviderTransitionArgs,
    ): Promise<PrepareProviderTransitionCompactionResult>;
  };
}

export interface ActiveThreadRunLookup {
  getRunByThreadId(threadId: string): { runId: RunId } | undefined;
  getRunByOwnerThread(threadId: string): { runId: RunId } | undefined;
}

export interface ProviderAuthRoutesContext {
  provider: {
    authBootstrap: ProviderAuthBootstrapStore;
    authCallbackServer: ProviderAuthCallbackServerController;
    authRuntime: ProviderAuthRuntimeStore;
  };
}
