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
      backgroundNotifications={[
        {
          kind: 'subagent_activity',
          childRunId: 'child-run-1',
          subagentType: 'worker',
          state: 'completed',
          result: 'child summary',
        },
      ]}
      backgroundNotificationKeys={['background-1']}
      hasUnreadStreamContent
      isRunning={false}
      onJumpToLatest={() => {}}
    />,
  );

  assert.match(markup, /Final answer/);
  assert.match(markup, /응답 생성 실패/);
  assert.match(markup, /\[internal\] stream failed/);
  assert.match(markup, /worker 작업 완료/);
  assert.match(markup, /child summary/);
  assert.match(markup, /새 메시지 보기/);
});
