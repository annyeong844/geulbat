import test from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';

import { Assistant } from './Assistant.js';

void test('Assistant renders transport-level stream errors as a visible banner', () => {
  const html = renderToStaticMarkup(
    <Assistant
      messages={[]}
      backgroundNotifications={[]}
      transcriptEntries={[]}
      finalAnswerText=""
      streamError="[internal] run channel websocket connection failed"
      isRunning={false}
      onSend={() => {}}
      onStartArtifactRun={() => {}}
      onCancel={() => {}}
    />,
  );

  assert.match(html, /run channel websocket connection failed/);
});
