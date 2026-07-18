import type { ThreadMessageMetadata } from './contract.js';

import { appendTranscriptEntry } from '../sessions/transcript-log.js';

export async function appendChildUserTranscriptEntry(args: {
  workspaceRoot: string;
  threadId: string;
  prompt: string;
  modelPrompt?: string;
  timestamp?: string;
}): Promise<void> {
  await appendTranscriptEntry(args.workspaceRoot, args.threadId, {
    role: 'user',
    content: args.prompt,
    timestamp: args.timestamp ?? new Date().toISOString(),
    ...(args.modelPrompt !== undefined && args.modelPrompt !== args.prompt
      ? { metadata: { hiddenPrompt: args.modelPrompt } }
      : {}),
  });
}

export async function appendChildAssistantTranscriptEntry(args: {
  workspaceRoot: string;
  threadId: string;
  childRunId: string;
  content: string;
  timestamp?: string;
}): Promise<void> {
  await appendTranscriptEntry(args.workspaceRoot, args.threadId, {
    role: 'assistant',
    content: args.content,
    metadata: buildChildAssistantMetadata({
      childRunId: args.childRunId,
    }),
    timestamp: args.timestamp ?? new Date().toISOString(),
  });
}

function buildChildAssistantMetadata(args: {
  childRunId: string;
}): ThreadMessageMetadata {
  return {
    phase: 'final_answer',
    sourceRunId: args.childRunId,
  };
}
