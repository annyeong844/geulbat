import test from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';

import { AssistantTranscriptLiveTail } from './assistant-transcript-live-tail.js';

void test('AssistantTranscriptLiveTail renders live transcript tail branches', () => {
  const markup = renderToStaticMarkup(
    <AssistantTranscriptLiveTail
      finalAnswerText="Final answer"
      activeArtifact={null}
      streamError="[internal] stream failed"
      hasUnreadStreamContent
      isRunning={false}
      onJumpToLatest={() => {}}
    />,
  );

  assert.match(markup, /Final answer/);
  assert.match(markup, /응답 생성 실패/);
  assert.match(markup, /\[internal\] stream failed/);
  assert.match(markup, /새 메시지 보기/);
});
