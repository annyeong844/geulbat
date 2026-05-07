import React, { useState } from 'react';
import type { RunRequest } from '@geulbat/protocol/run-contract';
import type { ThreadArtifactVersion } from '@geulbat/protocol/artifacts';
import type { ThreadMessage } from '@geulbat/protocol/threads';

import type { RunTranscriptEntry } from '../../lib/run-transcript-entry.js';
import { AssistantComposer } from './AssistantComposer.js';
import { AssistantTranscript } from './AssistantTranscript.js';
import { assistantStyles } from './assistant-styles.js';

interface Props {
  messages: ThreadMessage[];
  artifacts?: ThreadArtifactVersion[];
  activeArtifact?: ThreadArtifactVersion | null;
  backgroundNotifications: Extract<
    RunTranscriptEntry,
    { kind: 'subagent_activity' }
  >[];
  transcriptEntries: RunTranscriptEntry[];
  finalAnswerText: string;
  streamError: string | null;
  isRunning: boolean;
  isSettling?: boolean;
  onOpenSource: (path: string) => Promise<void> | void;
  onSend: (prompt: string) => Promise<void> | void;
  onStartArtifactRun: (request: RunRequest) => Promise<void> | void;
  onCancel: () => Promise<void> | void;
  approvalPanel?: React.ReactNode;
}

export function Assistant({
  messages,
  artifacts = [],
  activeArtifact = null,
  backgroundNotifications,
  transcriptEntries,
  finalAnswerText,
  streamError,
  isRunning,
  isSettling = false,
  onOpenSource,
  onSend,
  onStartArtifactRun,
  onCancel,
  approvalPanel = null,
}: Props) {
  const [input, setInput] = useState('');
  const isBusy = isRunning || isSettling;

  const handleSend = () => {
    const text = input.trim();
    if (!text || isBusy) {
      return;
    }
    setInput('');
    void onSend(text);
  };

  return (
    <section className="assistant" style={assistantStyles.section}>
      <h3>Assistant</h3>

      <AssistantTranscript
        messages={messages}
        artifacts={artifacts}
        backgroundNotifications={backgroundNotifications}
        transcriptEntries={transcriptEntries}
        finalAnswerText={finalAnswerText}
        activeArtifact={activeArtifact}
        streamError={streamError}
        isRunning={isRunning}
        onOpenSource={onOpenSource}
        onStartArtifactRun={onStartArtifactRun}
      />

      {approvalPanel}

      <AssistantComposer
        input={input}
        isBusy={isBusy}
        isRunning={isRunning}
        onCancel={onCancel}
        onInputChange={setInput}
        onSend={handleSend}
      />
    </section>
  );
}
