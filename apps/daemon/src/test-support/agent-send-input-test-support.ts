import { rm } from 'node:fs/promises';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TestContext } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import type { RunId, ThreadId } from '@geulbat/protocol/ids';

import { buildAgentToolExecutionContextBase } from '../daemon/agent/loop-tool-runtime.js';
import { createRunState } from '../daemon/agent/runtime/run-state.js';
import { createDaemonContext } from '../daemon/context.js';
import { createDaemonRuntimeStateStore } from '../daemon/runtime-state-store.js';
import {
  buildAgentToolExecutionContext,
  type StandaloneToolExecutionContext,
} from '../daemon/tools/types.js';
import { makeApprovalContext } from './approval-runtime.js';
import { makeRunContext } from './run-context.js';
import {
  TEST_AUTO_SUBAGENT_MODEL_ROUTING,
  TEST_INHERITED_SOL_MODEL_PIN,
} from './subagent-model-routing.js';

type DaemonContext = ReturnType<typeof createDaemonContext>;
type ChildRegistration = Parameters<
  DaemonContext['childRuns']['registerChildRun']
>[0];
type ChildTerminalState = Parameters<
  DaemonContext['childRuns']['markChildTerminal']
>[0]['terminalState'];
type SeedChildArgs = Omit<
  ChildRegistration,
  'ownerThreadId' | 'modelPin' | 'subagentModelRouting'
> & {
  modelPin?: ChildRegistration['modelPin'];
  subagentModelRouting?: ChildRegistration['subagentModelRouting'];
  terminalState?: ChildTerminalState | null;
  result?: string;
};

interface ToolContextArgs {
  callId: string;
  runId: RunId;
  threadId?: ThreadId;
  parentRunId?: RunId;
  workingDirectory?: string;
  computerSessionId?: string;
  permissionMode?: 'basic' | 'full_access';
  runtimeServices?: DaemonContext;
}

export async function createAgentSendInputTestFixture(
  t: TestContext,
  args: {
    ownerThreadId: ThreadId;
    workspacePrefix: string;
  },
) {
  const stateRoot = await mkdtemp(join(tmpdir(), args.workspacePrefix));
  const runtimeStateStore = await createDaemonRuntimeStateStore({
    homeStateRoot: stateRoot,
  });
  const daemonContext = createDaemonContext({
    homeStateRoot: stateRoot,
    subagentLaunchRequests: runtimeStateStore,
  });

  t.after(async () => {
    runtimeStateStore.close();
    await rm(stateRoot, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 20,
    });
  });

  function buildRunState(contextArgs: ToolContextArgs) {
    const runContext = makeRunContext({
      threadId: contextArgs.threadId ?? args.ownerThreadId,
      stateRoot,
      workingDirectory: contextArgs.workingDirectory ?? stateRoot,
    });
    return createRunState({
      runId: contextArgs.runId,
      runContext,
      ...(contextArgs.parentRunId === undefined
        ? {}
        : { parentRunId: contextArgs.parentRunId }),
    });
  }

  return {
    stateRoot,
    ownerThreadId: args.ownerThreadId,
    daemonContext,
    runtimeStateStore,
    registerChild(child: SeedChildArgs) {
      const {
        terminalState: requestedTerminalState,
        result,
        modelPin,
        subagentModelRouting,
        ...registration
      } = child;
      daemonContext.childRuns.registerChildRun({
        ...registration,
        ownerThreadId: args.ownerThreadId,
        modelPin: modelPin ?? TEST_INHERITED_SOL_MODEL_PIN,
        subagentModelRouting:
          subagentModelRouting ?? TEST_AUTO_SUBAGENT_MODEL_ROUTING,
      });
      const terminalState =
        requestedTerminalState === undefined
          ? 'completed'
          : requestedTerminalState;
      if (terminalState !== null) {
        daemonContext.childRuns.markChildTerminal({
          childRunId: child.childRunId,
          terminalState,
          result: result ?? 'seed child result',
        });
      }
      return daemonContext.childRuns.getChildRun(child.childRunId);
    },
    makeStandaloneContext(
      contextArgs: ToolContextArgs,
    ): StandaloneToolExecutionContext {
      return {
        callId: contextArgs.callId,
        providerRunSelection: TEST_INHERITED_SOL_MODEL_PIN.providerRunSelection,
        subagentModelRouting: TEST_AUTO_SUBAGENT_MODEL_ROUTING,
        stateRoot,
        workingDirectory: contextArgs.workingDirectory ?? stateRoot,
        threadId: contextArgs.threadId ?? args.ownerThreadId,
        runId: contextArgs.runId,
        runState: buildRunState(contextArgs),
        signal: new AbortController().signal,
        runSignal: new AbortController().signal,
        computerSessionId:
          contextArgs.computerSessionId ?? `session-${contextArgs.runId}`,
        permissionMode: contextArgs.permissionMode ?? 'basic',
        runtimeServices: contextArgs.runtimeServices ?? daemonContext,
      };
    },
    makeAgentContext(
      contextArgs: ToolContextArgs & {
        ultraReasoning?: boolean;
        approvalGranted?: boolean;
        emit?: Parameters<typeof buildAgentToolExecutionContextBase>[0]['emit'];
      },
    ) {
      const runState = buildRunState(contextArgs);
      const runContext = makeRunContext({
        threadId: contextArgs.threadId ?? args.ownerThreadId,
        stateRoot,
        workingDirectory: contextArgs.workingDirectory ?? stateRoot,
      });
      return buildAgentToolExecutionContext({
        base: buildAgentToolExecutionContextBase({
          runContext,
          runId: contextArgs.runId,
          approvalContext: makeApprovalContext({
            computerSessionId:
              contextArgs.computerSessionId ?? `session-${contextArgs.runId}`,
            permissionMode: contextArgs.permissionMode ?? 'basic',
          }),
          emit: contextArgs.emit ?? (() => {}),
          currentFile: undefined,
          selection: undefined,
          signal: new AbortController().signal,
          runState,
          memoryIndex: undefined,
          runtimeServices: contextArgs.runtimeServices ?? daemonContext,
          providerRunSelection:
            TEST_INHERITED_SOL_MODEL_PIN.providerRunSelection,
          subagentModelRouting: TEST_AUTO_SUBAGENT_MODEL_ROUTING,
          ultraReasoning: contextArgs.ultraReasoning ?? false,
        }),
        callId: contextArgs.callId,
        approvalGranted: contextArgs.approvalGranted ?? false,
      });
    },
    async startParentCheckpoint(contextArgs: {
      runId: RunId;
      workingDirectory?: string;
      permissionMode?: 'basic' | 'full_access';
      runtimeServices?: DaemonContext;
    }) {
      return await (
        contextArgs.runtimeServices ?? daemonContext
      ).runCheckpoints.startRun({
        runId: contextArgs.runId,
        threadId: args.ownerThreadId,
        request: {
          workingDirectory: contextArgs.workingDirectory ?? stateRoot,
          permissionMode: contextArgs.permissionMode ?? 'basic',
        },
      });
    },
    async waitForChildStatus(
      childRunId: RunId,
      status: 'completed' | 'failed' | 'cancelled',
      runtimeServices: DaemonContext = daemonContext,
    ): Promise<void> {
      for (let attempt = 0; attempt < 100; attempt += 1) {
        if (
          runtimeServices.childRuns.getChildRun(childRunId)?.status === status
        ) {
          return;
        }
        await delay(10);
      }
      throw new Error(`child ${childRunId} did not reach ${status}`);
    },
    async waitForChildCheckpointTerminal(
      childThreadId: ThreadId,
      runtimeServices: DaemonContext = daemonContext,
    ): Promise<void> {
      for (let attempt = 0; attempt < 100; attempt += 1) {
        if (
          (await runtimeServices.runCheckpoints.readThread(childThreadId))
            ?.status === 'terminal'
        ) {
          return;
        }
        await delay(10);
      }
      throw new Error(
        `child thread ${childThreadId} checkpoint did not become terminal`,
      );
    },
  };
}
