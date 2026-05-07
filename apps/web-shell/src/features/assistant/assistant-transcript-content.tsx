import type { RunRequest } from '@geulbat/protocol/run-contract';
import type { ThreadMessage } from '@geulbat/protocol/threads';

import {
  type ArtifactsByRefMap,
  readCommittedMessageArtifact,
} from '../artifacts/artifact-transcript-lookup.js';
import type { RunTranscriptEntry } from '../../lib/run-transcript-entry.js';
import { CommittedArtifactMessage } from './artifact-pane/index.js';
import {
  assistantStyles,
  getTranscriptMessageStyle,
} from './assistant-styles.js';

export function createStableOccurrenceKeys<T>(
  items: readonly T[],
  getBaseKey: (item: T) => string,
): string[] {
  const counts = new Map<string, number>();
  return items.map((item) => {
    const baseKey = getBaseKey(item);
    const nextCount = (counts.get(baseKey) ?? 0) + 1;
    counts.set(baseKey, nextCount);
    return `${baseKey}::${nextCount}`;
  });
}

export function getThreadMessageBaseKey(message: ThreadMessage): string {
  return `message:${message.timestamp}:${message.role}:${message.content}`;
}

export function getRunTranscriptEntryBaseKey(
  entry: RunTranscriptEntry,
): string {
  switch (entry.kind) {
    case 'assistant_text':
      return `assistant_text:${entry.text}`;
    case 'tool_activity':
      return `tool_activity:${entry.tool}:${entry.state}`;
    case 'approval_request':
      return `approval:${entry.pendingApproval.callId}`;
    case 'subagent_activity':
      return `subagent:${entry.childRunId}:${entry.state}:${entry.reason ?? ''}:${entry.result ?? ''}`;
  }
}

export function TranscriptMessage(props: {
  message: ThreadMessage;
  artifactsByRef: ArtifactsByRefMap;
  isRunning: boolean;
  onOpenSource?: (path: string) => Promise<void> | void;
  onStartArtifactRun?: (request: RunRequest) => Promise<void> | void;
}) {
  const {
    message,
    artifactsByRef,
    isRunning,
    onOpenSource,
    onStartArtifactRun,
  } = props;
  if (message.role === 'assistant') {
    const committedArtifact = readCommittedMessageArtifact(
      message,
      artifactsByRef,
    );
    if (committedArtifact) {
      return (
        <>
          {message.content ? (
            <TranscriptTextMessage role="assistant" content={message.content} />
          ) : null}
          <CommittedArtifactMessage
            label="assistant"
            artifact={committedArtifact}
            isRunning={isRunning}
            {...(onOpenSource !== undefined ? { onOpenSource } : {})}
            {...(onStartArtifactRun !== undefined
              ? { onStartArtifactRun }
              : {})}
          />
        </>
      );
    }
  }

  return (
    <TranscriptTextMessage role={message.role} content={message.content} />
  );
}

export function TranscriptTextMessage(props: {
  role: ThreadMessage['role'];
  content: string;
}) {
  const { role, content } = props;
  return (
    <div style={getTranscriptMessageStyle(role)}>
      <div style={assistantStyles.messageRole}>{role}</div>
      <pre style={assistantStyles.messageText}>{content}</pre>
    </div>
  );
}
