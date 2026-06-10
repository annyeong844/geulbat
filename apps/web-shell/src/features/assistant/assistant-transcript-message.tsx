import type { RunRequest } from '@geulbat/protocol/run-contract';
import type { ThreadMessage } from '@geulbat/protocol/threads';

import {
  type ArtifactsByRefMap,
  readCommittedMessageArtifact,
} from '../artifacts/artifact-transcript-lookup.js';
import { CommittedArtifactMessage } from './artifact-pane/index.js';
import {
  assistantStyles,
  getTranscriptMessageStyle,
} from './assistant-styles.js';

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
