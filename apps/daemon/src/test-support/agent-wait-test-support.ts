import type { ThreadId } from '@geulbat/protocol/ids';

import { createRunState } from '../daemon/agent/runtime/run-state.js';
import { createDaemonContext } from '../daemon/context.js';
import type { StandaloneToolExecutionContext } from '../daemon/tools/types.js';
import { testRunId } from './run-id.js';
import { makeRunContext } from './run-context.js';
import { testThreadId } from './thread-id.js';

type AgentWaitTestContext = {
  daemonContext: ReturnType<typeof createDaemonContext>;
  runState: ReturnType<typeof createRunState>;
  executionContext: StandaloneToolExecutionContext & {
    workspaceRoot: string;
    threadId: ThreadId;
    runId: string;
    runtimeServices: ReturnType<typeof createDaemonContext>;
    runState: ReturnType<typeof createRunState>;
    interjectBuffer: ReturnType<typeof createRunState>['interject'];
  };
};

export function createWaitContext(args?: {
  daemonContext?: ReturnType<typeof createDaemonContext>;
  runId?: string;
  threadId?: ThreadId;
}): AgentWaitTestContext {
  const daemonContext = args?.daemonContext ?? createDaemonContext();
  const threadId = args?.threadId ?? testThreadId(1);
  const runId = args?.runId ?? testRunId('parent-run');
  const runState = createRunState({
    runId,
    runContext: makeRunContext({ threadId }),
  });
  return {
    daemonContext,
    runState,
    executionContext: {
      callId: 'call-wait',
      workspaceRoot: '/tmp/workspace',
      runId,
      threadId,
      runtimeServices: daemonContext,
      runState,
      interjectBuffer: runState.interject,
      signal: new AbortController().signal,
    },
  };
}
