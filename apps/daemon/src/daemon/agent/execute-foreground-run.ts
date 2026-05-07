import {
  appendTranscriptEntry,
  readTranscriptEntries,
  replaceTranscriptEntries,
} from '../sessions/transcript-log.js';
import type { ThreadStatePersistenceFailureDiagnostic } from '@geulbat/protocol/run-events';
import type { ThreadMessageMetadata } from '@geulbat/protocol/thread-metadata';
import {
  commitThreadArtifactVersion,
  deleteThreadArtifact,
} from '../sessions/artifact-store.js';
import {
  loadThreadIndex,
  upsertThreadSummary,
} from '../sessions/threads-index.js';
import { runAgentLoop } from './run-agent-loop.js';
import type { AgentInput } from './loop-types.js';
import type { AgentResult } from './agent-result.js';
import { createAgentEvent } from './events.js';
import { hasVisibleAgentOutput } from './agent-result.js';
import { getErrorMessage } from '../utils/error.js';
import { createLogger } from '@geulbat/shared-utils/logger';
import type {
  ExecuteForegroundRunDeps,
  ResolvedExecuteForegroundRunDeps,
} from './execute-foreground-run-contracts.js';
import {
  buildThreadStatePersistenceFailureDiagnostic,
  persistSuccessfulForegroundOutput,
  upsertCurrentThreadSummary,
} from './foreground-thread-state-persistence.js';

const logger = createLogger('agent/execute-foreground-run');

interface ExecuteForegroundRunArgs {
  agentInput: AgentInput;
  transcriptPrompt: string;
  deps?: ExecuteForegroundRunDeps;
}

function buildUserTranscriptMetadata(args: {
  prompt: string;
  transcriptPrompt: string;
}): ThreadMessageMetadata | undefined {
  if (args.transcriptPrompt === args.prompt) {
    return undefined;
  }

  return {
    hiddenPrompt: args.prompt,
  };
}

function resolveExecuteForegroundRunDeps(
  deps: ExecuteForegroundRunDeps | undefined,
  onPostRunPersistenceError: (phase: string, error: unknown) => void,
): ResolvedExecuteForegroundRunDeps {
  return {
    appendTranscriptEntry: deps?.appendTranscriptEntry ?? appendTranscriptEntry,
    commitThreadArtifactVersion:
      deps?.commitThreadArtifactVersion ?? commitThreadArtifactVersion,
    deleteThreadArtifact: deps?.deleteThreadArtifact ?? deleteThreadArtifact,
    readTranscriptEntries: deps?.readTranscriptEntries ?? readTranscriptEntries,
    replaceTranscriptEntries:
      deps?.replaceTranscriptEntries ?? replaceTranscriptEntries,
    loadThreadIndex: deps?.loadThreadIndex ?? loadThreadIndex,
    upsertThreadSummary: deps?.upsertThreadSummary ?? upsertThreadSummary,
    now: deps?.now ?? (() => new Date().toISOString()),
    onPostRunPersistenceError,
  };
}

async function appendForegroundTranscriptEntry(args: {
  workspaceRoot: string;
  threadId: AgentInput['runContext']['threadId'];
  role: 'user' | 'assistant';
  content: string;
  metadata?: ThreadMessageMetadata;
  timestamp?: string;
  deps: ResolvedExecuteForegroundRunDeps;
}): Promise<void> {
  const { deps, ...rest } = args;
  const entry: Parameters<
    ResolvedExecuteForegroundRunDeps['appendTranscriptEntry']
  >[2] = {
    role: rest.role,
    content: rest.content,
    timestamp: rest.timestamp ?? deps.now(),
  };

  if (rest.metadata !== undefined) {
    entry.metadata = rest.metadata;
  }

  await deps.appendTranscriptEntry(rest.workspaceRoot, rest.threadId, entry);
}

async function persistRequiredForegroundInput(args: {
  agentInput: AgentInput;
  transcriptPrompt: string;
  deps: ResolvedExecuteForegroundRunDeps;
}): Promise<void> {
  const { agentInput, transcriptPrompt, deps } = args;
  const { runContext, prompt } = agentInput;
  const userMetadata = buildUserTranscriptMetadata({
    prompt,
    transcriptPrompt,
  });
  const userEntry: Parameters<typeof appendForegroundTranscriptEntry>[0] = {
    workspaceRoot: runContext.workspaceRoot,
    threadId: runContext.threadId,
    role: 'user',
    content: transcriptPrompt,
    deps,
  };

  if (userMetadata !== undefined) {
    userEntry.metadata = userMetadata;
  }

  await appendForegroundTranscriptEntry(userEntry);

  await upsertCurrentThreadSummary({
    workspaceRoot: runContext.workspaceRoot,
    threadId: runContext.threadId,
    projectId: runContext.projectId,
    transcriptPrompt,
    deps,
  });
}

export async function executeForegroundRun(
  args: ExecuteForegroundRunArgs,
): Promise<AgentResult> {
  const { agentInput, transcriptPrompt } = args;
  const persistenceDiagnostics: ThreadStatePersistenceFailureDiagnostic[] = [];
  const { runId, runContext } = agentInput;
  const startedAtMs = Date.now();
  const logMeta = {
    projectId: runContext.projectId,
    runId,
    threadId: runContext.threadId,
  };
  const runLogger = logger.withContext(logMeta);
  const deps = resolveExecuteForegroundRunDeps(args.deps, (phase, error) => {
    persistenceDiagnostics.push(
      buildThreadStatePersistenceFailureDiagnostic(phase, error),
    );
    runLogger.warn(`${phase} failed:`, {
      message: getErrorMessage(error),
    });
    args.deps?.onPostRunPersistenceError?.(phase, error);
  });

  runLogger.info('run started');

  try {
    // Pre-run transcript persistence is required. If the user prompt cannot be
    // recorded, the run should not start because future replay/history would diverge.
    await persistRequiredForegroundInput({
      agentInput,
      transcriptPrompt,
      deps,
    });

    const result = await runAgentLoop(agentInput);

    if (result.ok && (result.finalProse || result.artifactCandidate)) {
      // Post-run persistence is best-effort. The UI already observed the final
      // model result, so a storage failure should not retroactively turn the run
      // into an internal error.
      await persistSuccessfulForegroundOutput({
        agentInput,
        transcriptPrompt,
        result,
        deps,
        persistenceDiagnostics,
      });
    }

    if (hasVisibleAgentOutput(result)) {
      agentInput.onEvent(
        createAgentEvent('done', {
          answer: result.finalProse,
          ok: result.ok,
        }),
      );
    }

    runLogger.info('run completed', {
      durationMs: Date.now() - startedAtMs,
      ok: result.ok,
    });
    return result;
  } catch (error: unknown) {
    runLogger.error('run failed:', {
      durationMs: Date.now() - startedAtMs,
      message: getErrorMessage(error),
    });
    throw error;
  }
}
