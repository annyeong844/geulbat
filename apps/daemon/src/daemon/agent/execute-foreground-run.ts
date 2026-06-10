import {
  appendTranscriptEntry,
  readTranscriptEntries,
  replaceTranscriptEntries,
} from '../sessions/transcript-log.js';
import type { ThreadStatePersistenceFailureDiagnostic } from '@geulbat/protocol/run-events';
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
} from './foreground-thread-state-persistence.js';
import { persistRequiredForegroundInput } from './foreground-input-persistence.js';

const logger = createLogger('agent/execute-foreground-run');

interface ExecuteForegroundRunArgs {
  agentInput: AgentInput;
  transcriptPrompt: string;
  deps?: ExecuteForegroundRunDeps;
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
