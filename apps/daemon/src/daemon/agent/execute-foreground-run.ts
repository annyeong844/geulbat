import {
  appendTranscriptEntry,
  readTranscriptEntries,
  replaceTranscriptEntries,
} from '../sessions/transcript-log.js';
import type {
  ArtifactRef,
  ThreadStatePersistenceFailureDiagnostic,
} from './contract.js';
import {
  commitThreadArtifactUpdateVersion,
  commitThreadArtifactVersion,
  deleteThreadArtifact,
  deleteThreadArtifactUpdateVersion,
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
import {
  composeAgentLoopUserPrompt,
  createAgentLoopPromptPort,
} from './loop-prompt.js';
import { formatBackgroundResultNote } from './loop-shared.js';
import { isRootRunState } from '../runtime-contracts.js';

const logger = createLogger('agent/execute-foreground-run');

interface ExecuteForegroundRunArgs {
  agentInput: AgentInput;
  transcriptPrompt: string;
  // 답변 재생성 — run 시작 전에 transcript를 마지막 사용자 턴 직전까지
  // 잘라낸다. 이어지는 정상 흐름이 prompt를 그 자리에 다시 기록하므로
  // 질문은 한 번만 남고 이전 답변은 새 답변으로 대체된다.
  regenerate?: boolean;
  // UI 발 자동 요청 — 사용자 턴을 감사용으로만 기록(metadata.silent)
  silentPrompt?: boolean;
  // 아티팩트 프레임 발 턴 귀속 — 사용자 턴에 metadata.origin으로 각인해
  // 채팅이 "아티팩트 발"로 렌더한다 (back-channel 설계 가시성 불변식).
  promptOrigin?: 'artifact_frame';
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
    commitThreadArtifactUpdateVersion:
      deps?.commitThreadArtifactUpdateVersion ??
      commitThreadArtifactUpdateVersion,
    deleteThreadArtifactUpdateVersion:
      deps?.deleteThreadArtifactUpdateVersion ??
      deleteThreadArtifactUpdateVersion,
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

// 마지막 사용자 엔트리(포함)부터 끝까지 잘라낸다. 사용자 턴이 없으면
// 자를 것이 없으므로 그대로 둔다(첫 턴 재생성 요청은 사실상 일반 실행).
async function truncateThreadForRegenerate(args: {
  workspaceRoot: string;
  threadId: string;
  deps: ResolvedExecuteForegroundRunDeps;
}): Promise<void> {
  const entries = await args.deps.readTranscriptEntries(
    args.workspaceRoot,
    args.threadId,
  );
  // silent user 턴(아티팩트 ♻ 등 UI 발 자동 요청)은 화면에 보이지 않는다 —
  // "질문 수정/재생성"의 기준은 사용자가 보는 마지막 질문이므로, silent
  // 턴은 건너뛰고 마지막 가시 user 턴부터 잘라낸다 (그 뒤의 silent 턴과
  // 답변들도 함께 대체된다).
  let lastUserIndex = -1;
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry?.role === 'user' && entry.metadata?.silent !== true) {
      lastUserIndex = index;
      break;
    }
  }
  if (lastUserIndex < 0) {
    return;
  }
  await args.deps.replaceTranscriptEntries(
    args.workspaceRoot,
    args.threadId,
    entries.slice(0, lastUserIndex),
  );
}

export async function executeForegroundRun(
  args: ExecuteForegroundRunArgs,
): Promise<AgentResult> {
  const { agentInput, transcriptPrompt } = args;
  const persistenceDiagnostics: ThreadStatePersistenceFailureDiagnostic[] = [];
  const { runId, runContext } = agentInput;
  const startedAtMs = Date.now();
  const logMeta = {
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
    const pendingBackgroundResults =
      agentInput.runState === undefined || isRootRunState(agentInput.runState)
        ? agentInput.runtimeServices.backgroundNotifications.readThreadBackgroundResults(
            runContext.threadId,
          )
        : [];
    const promptPort = agentInput.promptPort ?? createAgentLoopPromptPort();
    const { promptContext } = promptPort.buildPromptBundle({
      threadId: runContext.threadId,
      ...(agentInput.currentFile === undefined
        ? {}
        : { currentFile: agentInput.currentFile }),
      ...(agentInput.selection === undefined
        ? {}
        : { selection: agentInput.selection }),
    });
    const loopAgentInput: AgentInput = {
      ...agentInput,
      embeddedBackgroundResultCount: pendingBackgroundResults.length,
      prompt: composeAgentLoopUserPrompt({
        prompt: agentInput.prompt,
        promptContext,
        backgroundResultNote: formatBackgroundResultNote(
          pendingBackgroundResults,
        ),
      }),
    };

    if (args.regenerate) {
      await truncateThreadForRegenerate({
        workspaceRoot: runContext.stateRoot,
        threadId: runContext.threadId,
        deps,
      });
    }

    // Pre-run transcript persistence is required. If the user prompt cannot be
    // recorded, the run should not start because future replay/history would diverge.
    await persistRequiredForegroundInput({
      agentInput: loopAgentInput,
      transcriptPrompt,
      silentPrompt: args.silentPrompt === true,
      ...(args.promptOrigin !== undefined
        ? { promptOrigin: args.promptOrigin }
        : {}),
      deps,
      onTranscriptPersisted() {
        agentInput.runtimeServices.backgroundNotifications.acknowledgeThreadBackgroundResults(
          runContext.threadId,
          pendingBackgroundResults.map((result) => result.deliveryId),
        );
      },
    });

    // 도구(generate_image 등)가 런 도중 직접 커밋한 아티팩트 ref를 수집해
    // 어시스턴트 메시지 메타데이터에 바인딩한다. 바인딩이 없으면 재로드 시
    // 트랜스크립트에서 아티팩트를 다시 찾을 수 없다.
    const toolCommittedArtifactRefs: ArtifactRef[] = [];
    const observedLoopAgentInput: AgentInput = {
      ...loopAgentInput,
      onEvent: (event) => {
        if (event.type === 'artifact_committed') {
          toolCommittedArtifactRefs.push({
            artifactId: event.payload.artifactId,
            version: event.payload.version,
          });
        }
        agentInput.onEvent(event);
      },
    };

    const result = await runAgentLoop(observedLoopAgentInput);

    if (
      result.ok &&
      (result.finalProse ||
        result.artifactCandidate ||
        toolCommittedArtifactRefs.length > 0)
    ) {
      // Post-run persistence is best-effort. The UI already observed the final
      // model result, so a storage failure should not retroactively turn the run
      // into an internal error.
      await persistSuccessfulForegroundOutput({
        agentInput,
        transcriptPrompt,
        result,
        deps,
        persistenceDiagnostics,
        toolCommittedArtifactRefs,
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
