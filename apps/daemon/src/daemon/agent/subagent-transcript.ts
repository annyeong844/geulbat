import {
  assertAgentRunId,
  type RunId,
  type ThreadMessageMetadata,
} from './contract.js';

import {
  appendTranscriptEntry,
  appendTranscriptEntryOnce,
} from '../sessions/transcript-log.js';

export async function appendChildUserTranscriptEntry(args: {
  workspaceRoot: string;
  threadId: string;
  prompt: string;
  modelPrompt?: string;
  entryId?: string;
  timestamp?: string;
}): Promise<void> {
  const entry = {
    ...(args.entryId === undefined ? {} : { entryId: args.entryId }),
    role: 'user',
    content: args.prompt,
    timestamp: args.timestamp ?? new Date().toISOString(),
    ...(args.modelPrompt !== undefined && args.modelPrompt !== args.prompt
      ? { metadata: { hiddenPrompt: args.modelPrompt } }
      : {}),
  } as const;
  if (args.entryId === undefined) {
    await appendTranscriptEntry(args.workspaceRoot, args.threadId, entry);
    return;
  }
  await appendTranscriptEntryOnce(args.workspaceRoot, args.threadId, {
    ...entry,
    entryId: args.entryId,
  });
}

export async function appendChildAssistantTranscriptEntry(args: {
  workspaceRoot: string;
  threadId: string;
  childRunId: string;
  content: string;
  timestamp?: string;
}): Promise<void> {
  const childRunId = assertAgentRunId(args.childRunId);
  await appendTranscriptEntry(args.workspaceRoot, args.threadId, {
    role: 'assistant',
    content: args.content,
    metadata: buildChildAssistantMetadata({
      childRunId,
    }),
    timestamp: args.timestamp ?? new Date().toISOString(),
  });
}

function buildChildAssistantMetadata(args: {
  childRunId: RunId;
}): ThreadMessageMetadata {
  return {
    phase: 'final_answer',
    sourceRunId: args.childRunId,
  };
}
