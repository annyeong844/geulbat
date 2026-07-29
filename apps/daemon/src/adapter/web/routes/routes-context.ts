import type { RunId } from '@geulbat/protocol/ids';
import type { ProviderAuthCallbackServerController } from '../../../daemon/auth/bootstrap/callback-server.js';
import type { ProviderAuthBootstrapStore } from '../../../daemon/auth/bootstrap/session-store.js';
import type { ProviderAuthRuntimeStore } from '../../../daemon/auth/runtime-state.js';
import type { BackgroundNotificationQueue } from '../../../daemon/agent/runtime/background-notification-queue.js';
import type {
  PrepareProviderTransitionCompactionArgs,
  PrepareProviderTransitionCompactionResult,
} from '../../../daemon/agent/memory/provider-transition-compaction.js';
import type { ThreadArchiveTransferService } from '../../../daemon/sessions/thread-portable-transfer.js';
import type { ThreadProjectionPinDeletionPort } from '../../../daemon/sessions/delete-thread.js';

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
  threadArchiveTransfer: ThreadArchiveTransferService;
  threadProjectionPins: ThreadProjectionPinDeletionPort;
  providerTransitionCompaction: {
    prepare(
      args: PrepareThreadProviderTransitionArgs,
    ): Promise<PrepareProviderTransitionCompactionResult>;
  };
}

interface ActiveThreadRunLookup {
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
