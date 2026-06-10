import React, { useMemo } from 'react';
import type { ThreadArtifactVersion } from '@geulbat/protocol/artifacts';
import type { RunRequest } from '@geulbat/protocol/run-contract';
import type { ThreadMessage } from '@geulbat/protocol/threads';

import { createArtifactsByRefMap } from '../artifacts/artifact-transcript-lookup.js';
import type { RunTranscriptEntry } from '../../lib/run-transcript-entry.js';
import { assistantStyles } from './assistant-styles.js';
import {
  createStableOccurrenceKeys,
  getRunTranscriptEntryBaseKey,
  getThreadMessageBaseKey,
} from './assistant-transcript-content.js';
import { RunTranscriptEntryBlock } from './assistant-transcript-entry-blocks.js';
import { AssistantTranscriptLiveTail } from './assistant-transcript-live-tail.js';
import { TranscriptMessage } from './assistant-transcript-message.js';
import { useAssistantTranscriptScrollState } from './use-assistant-transcript-scroll-state.js';

interface AssistantTranscriptProps {
  messages: ThreadMessage[];
  artifacts: ThreadArtifactVersion[];
  backgroundNotifications: Extract<
    RunTranscriptEntry,
    { kind: 'subagent_activity' }
  >[];
  transcriptEntries: RunTranscriptEntry[];
  finalAnswerText: string;
  activeArtifact: ThreadArtifactVersion | null;
  streamError: string | null;
  isRunning: boolean;
  onOpenSource: (path: string) => Promise<void> | void;
  onStartArtifactRun: (request: RunRequest) => Promise<void> | void;
}

export function AssistantTranscript({
  messages,
  artifacts,
  backgroundNotifications,
  transcriptEntries,
  finalAnswerText,
  activeArtifact,
  streamError,
  isRunning,
  onOpenSource,
  onStartArtifactRun,
}: AssistantTranscriptProps) {
  const showStartingPlaceholder =
    isRunning &&
    transcriptEntries.length === 0 &&
    !finalAnswerText &&
    !activeArtifact &&
    !streamError;
  const activeArtifactKey = activeArtifact
    ? `${activeArtifact.artifactId}:${activeArtifact.version}`
    : null;
  const messageKeys = useMemo(
    () => createStableOccurrenceKeys(messages, getThreadMessageBaseKey),
    [messages],
  );
  const transcriptEntryKeys = useMemo(
    () =>
      createStableOccurrenceKeys(
        transcriptEntries,
        getRunTranscriptEntryBaseKey,
      ),
    [transcriptEntries],
  );
  const backgroundNotificationKeys = useMemo(
    () =>
      createStableOccurrenceKeys(
        backgroundNotifications,
        getRunTranscriptEntryBaseKey,
      ),
    [backgroundNotifications],
  );
  const artifactsByRef = useMemo(
    () => createArtifactsByRefMap(artifacts),
    [artifacts],
  );
  const {
    transcriptRef,
    bottomRef,
    hasUnreadStreamContent,
    handleTranscriptScroll,
    handleJumpToLatest,
  } = useAssistantTranscriptScrollState({
    isRunning,
    messageCount: messages.length,
    backgroundNotificationCount: backgroundNotifications.length,
    transcriptEntryCount: transcriptEntries.length,
    finalAnswerText,
    activeArtifactKey,
    streamError,
  });

  return (
    <div
      ref={transcriptRef}
      onScroll={handleTranscriptScroll}
      role="log"
      aria-label="Assistant transcript"
      aria-live="polite"
      aria-relevant="additions text"
      aria-atomic="false"
      aria-busy={isRunning}
      style={assistantStyles.transcript}
    >
      <MemoizedTranscriptMessages
        messages={messages}
        messageKeys={messageKeys}
        artifactsByRef={artifactsByRef}
        isRunning={isRunning}
        onOpenSource={onOpenSource}
        onStartArtifactRun={onStartArtifactRun}
      />

      <MemoizedRunTranscriptEntries
        transcriptEntries={transcriptEntries}
        transcriptEntryKeys={transcriptEntryKeys}
      />

      <AssistantTranscriptLiveTail
        showStartingPlaceholder={showStartingPlaceholder}
        finalAnswerText={finalAnswerText}
        activeArtifact={activeArtifact}
        streamError={streamError}
        backgroundNotifications={backgroundNotifications}
        backgroundNotificationKeys={backgroundNotificationKeys}
        hasUnreadStreamContent={hasUnreadStreamContent}
        isRunning={isRunning}
        onOpenSource={onOpenSource}
        onStartArtifactRun={onStartArtifactRun}
        onJumpToLatest={handleJumpToLatest}
      />
      <div ref={bottomRef} />
    </div>
  );
}

const MemoizedTranscriptMessages = React.memo(
  function TranscriptMessages(props: {
    messages: ThreadMessage[];
    messageKeys: string[];
    artifactsByRef: ReadonlyMap<string, ThreadArtifactVersion>;
    isRunning: boolean;
    onOpenSource: (path: string) => Promise<void> | void;
    onStartArtifactRun: (request: RunRequest) => Promise<void> | void;
  }) {
    const {
      messages,
      messageKeys,
      artifactsByRef,
      isRunning,
      onOpenSource,
      onStartArtifactRun,
    } = props;

    return (
      <>
        {messages.map((message, index) => (
          <TranscriptMessage
            key={messageKeys[index] ?? `${message.timestamp}-${message.role}`}
            message={message}
            artifactsByRef={artifactsByRef}
            isRunning={isRunning}
            onOpenSource={onOpenSource}
            onStartArtifactRun={onStartArtifactRun}
          />
        ))}
      </>
    );
  },
);

const MemoizedRunTranscriptEntries = React.memo(
  function RunTranscriptEntries(props: {
    transcriptEntries: RunTranscriptEntry[];
    transcriptEntryKeys: string[];
  }) {
    const { transcriptEntries, transcriptEntryKeys } = props;

    return (
      <>
        {transcriptEntries.map((entry, index) => (
          <RunTranscriptEntryBlock
            key={transcriptEntryKeys[index] ?? entry.kind}
            entry={entry}
          />
        ))}
      </>
    );
  },
);
