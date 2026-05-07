import test from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';

import { makeApprovalRequiredFixture } from '../../test-support/protocol-fixtures.js';
import { RunTranscriptEntryBlock } from './assistant-transcript-entry-blocks.js';

void test('RunTranscriptEntryBlock renders run transcript leaf entries', () => {
  const assistantTextHtml = renderToStaticMarkup(
    <RunTranscriptEntryBlock
      entry={{ kind: 'assistant_text', text: 'Thinking...' }}
    />,
  );

  assert.match(assistantTextHtml, /assistant \(commentary\)/);
  assert.match(assistantTextHtml, /Thinking/);

  const approvalHtml = renderToStaticMarkup(
    <RunTranscriptEntryBlock
      entry={{
        kind: 'approval_request',
        pendingApproval: makeApprovalRequiredFixture({
          argumentsPreview: { path: 'hello.txt', content: 'Hello' },
        }),
      }}
    />,
  );

  assert.match(approvalHtml, /assistant \(approval\)/);
  assert.match(approvalHtml, /Write hello.txt/);

  const subagentHtml = renderToStaticMarkup(
    <RunTranscriptEntryBlock
      entry={{
        kind: 'subagent_activity',
        childRunId: 'child-run-1',
        subagentType: 'explorer',
        state: 'completed',
        result: 'summary',
      }}
    />,
  );

  assert.match(subagentHtml, /explorer sub-agent completed/);
  assert.match(subagentHtml, /summary/);
});
