import type { ThreadMessageInput, ThreadMessageMetadata } from './contract.js';

import type { ResolvedExecuteForegroundRunDeps } from './execute-foreground-run-contracts.js';
import { upsertCurrentThreadSummary } from './foreground-thread-state-persistence.js';
import type { AgentInput } from './loop-types.js';

export async function persistRequiredForegroundInput(args: {
  agentInput: Pick<AgentInput, 'prompt' | 'runContext'>;
  transcriptPrompt: string;
  deps: ResolvedExecuteForegroundRunDeps;
}): Promise<void> {
  const { agentInput, transcriptPrompt, deps } = args;
  const { runContext, prompt } = agentInput;

  await deps.appendTranscriptEntry(
    runContext.workspaceRoot,
    runContext.threadId,
    buildForegroundUserTranscriptEntry({
      prompt,
      transcriptPrompt,
      timestamp: deps.now(),
    }),
  );

  await upsertCurrentThreadSummary({
    workspaceRoot: runContext.workspaceRoot,
    threadId: runContext.threadId,
    projectId: runContext.projectId,
    transcriptPrompt,
    deps,
  });
}

function buildForegroundUserTranscriptEntry(args: {
  prompt: string;
  transcriptPrompt: string;
  timestamp: string;
}): ThreadMessageInput {
  const entry: ThreadMessageInput = {
    role: 'user',
    content: args.transcriptPrompt,
    timestamp: args.timestamp,
  };
  const metadata = buildUserTranscriptMetadata(args);

  if (metadata !== undefined) {
    entry.metadata = metadata;
  }

  return entry;
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
