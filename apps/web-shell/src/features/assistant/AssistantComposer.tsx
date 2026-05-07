import { type KeyboardEvent } from 'react';

import { assistantStyles, getSendButtonStyle } from './assistant-styles.js';

interface AssistantComposerProps {
  input: string;
  isBusy: boolean;
  isRunning: boolean;
  onCancel: () => Promise<void> | void;
  onInputChange: (value: string) => void;
  onSend: () => Promise<void> | void;
}

export function AssistantComposer({
  input,
  isBusy,
  isRunning,
  onCancel,
  onInputChange,
  onSend,
}: AssistantComposerProps) {
  const handleKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      void onSend();
    }
  };

  return (
    <div style={assistantStyles.inputRow}>
      <textarea
        value={input}
        onChange={(event) => onInputChange(event.target.value)}
        onKeyDown={handleKeyDown}
        placeholder="Send a message..."
        disabled={isBusy}
        rows={2}
        style={assistantStyles.textarea}
      />
      <div style={assistantStyles.buttonColumn}>
        <button
          onClick={() => void onSend()}
          disabled={isBusy || !input.trim()}
          style={getSendButtonStyle(isBusy || !input.trim())}
        >
          Send
        </button>
        {isRunning && (
          <button
            onClick={() => void onCancel()}
            style={assistantStyles.cancelButton}
          >
            Cancel
          </button>
        )}
      </div>
    </div>
  );
}
