import test from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';

import { Assistant } from './Assistant.js';
import {
  createCommittedArtifact,
  createCommittedArtifactMessage,
} from '../../test-support/thread-artifact-fixtures.js';
import { makeApprovalRequiredFixture } from '../../test-support/protocol-fixtures.js';

void test('background notifications render after transcript content so auto-scroll keeps them visible', () => {
  const html = renderToStaticMarkup(
    <Assistant
      messages={[
        {
          entryId: 'entry-user',
          role: 'user',
          content: 'prompt',
          timestamp: '2026-03-24T00:00:00.000Z',
        },
        {
          entryId: 'entry-assistant',
          role: 'assistant',
          content: 'answer',
          timestamp: '2026-03-24T00:00:01.000Z',
        },
      ]}
      backgroundNotifications={[
        {
          kind: 'subagent_activity',
          childRunId: 'run-child-1',
          subagentType: 'explorer',
          state: 'completed',
        },
      ]}
      transcriptEntries={[]}
      finalAnswerText=""
      streamError={null}
      isRunning={false}
      onOpenSource={() => {}}
      onSend={() => {}}
      onStartArtifactRun={() => {}}
      onCancel={() => {}}
    />,
  );

  assert.match(html, /explorer sub-agent completed/);
  assert.ok(
    html.indexOf('assistant') < html.indexOf('explorer sub-agent completed'),
    'background completion notice should render after prior transcript blocks',
  );
});

void test('assistant transcript exposes a polite live region for streamed updates', () => {
  const html = renderToStaticMarkup(
    <Assistant
      messages={[]}
      backgroundNotifications={[]}
      transcriptEntries={[{ kind: 'assistant_text', text: 'Thinking...' }]}
      finalAnswerText=""
      streamError={null}
      isRunning={true}
      onOpenSource={() => {}}
      onSend={() => {}}
      onStartArtifactRun={() => {}}
      onCancel={() => {}}
    />,
  );

  assert.match(html, /role="log"/);
  assert.match(html, /aria-label="Assistant transcript"/);
  assert.match(html, /aria-live="polite"/);
  assert.match(html, /aria-relevant="additions text"/);
  assert.match(html, /aria-atomic="false"/);
  assert.match(html, /aria-busy="true"/);
});

void test('assistant keeps legacy transcript envelope content as plain text without preview controls', () => {
  const html = renderToStaticMarkup(
    <Assistant
      messages={[
        {
          entryId: 'entry-legacy-artifact-envelope',
          role: 'assistant',
          content:
            '<!-- GEULBAT_ARTIFACT {"renderer":"markdown","digest":"요약"} -->\n# title\n<!-- /GEULBAT_ARTIFACT -->',
          timestamp: '2026-03-24T00:00:01.000Z',
          metadata: {
            sourceFile: 'episodes/ch01.md',
            sourceRunId: 'run-1',
            phase: 'final_answer',
          },
        },
      ]}
      backgroundNotifications={[]}
      transcriptEntries={[]}
      finalAnswerText=""
      streamError={null}
      isRunning={false}
      onOpenSource={() => {}}
      onSend={() => {}}
      onStartArtifactRun={() => {}}
      onCancel={() => {}}
    />,
  );

  assert.doesNotMatch(html, /Show/);
  assert.doesNotMatch(html, /Apply/);
  assert.doesNotMatch(html, /Export/);
  assert.doesNotMatch(html, /원본 열기/);
  assert.match(html, /title/);
  assert.match(html, /요약/);
});

void test('assistant renders committed artifact objects from versioned refs without reparsing transcript text', () => {
  const artifact = createCommittedArtifact({
    artifactId: 'art_1',
    renderer: 'markdown',
    payload: '# title',
    digest: '요약',
  });

  const html = renderToStaticMarkup(
    <Assistant
      messages={[createCommittedArtifactMessage(artifact)]}
      artifacts={[artifact]}
      backgroundNotifications={[]}
      transcriptEntries={[]}
      finalAnswerText=""
      streamError={null}
      isRunning={false}
      onOpenSource={() => {}}
      onSend={() => {}}
      onStartArtifactRun={() => {}}
      onCancel={() => {}}
    />,
  );

  assert.match(html, /Show/);
  assert.match(html, /Apply/);
  assert.match(html, /Export/);
  assert.match(html, /title/);
  assert.doesNotMatch(html, /요약/);
});

void test('assistant keeps assistant prose visible when a committed artifact ref is present', () => {
  const artifact = createCommittedArtifact({
    artifactId: 'art_backfilled_1',
    renderer: 'markdown',
    payload: '# normalized title',
    digest: 'normalized-digest',
  });

  const html = renderToStaticMarkup(
    <Assistant
      messages={[
        createCommittedArtifactMessage(artifact, {
          content: 'Here is the normalized artifact.',
        }),
      ]}
      artifacts={[artifact]}
      backgroundNotifications={[]}
      transcriptEntries={[]}
      finalAnswerText=""
      streamError={null}
      isRunning={false}
      onOpenSource={() => {}}
      onSend={() => {}}
      onStartArtifactRun={() => {}}
      onCancel={() => {}}
    />,
  );

  assert.match(html, /Here is the normalized artifact\./);
  assert.match(html, /normalized title/);
});

void test('assistant keeps live final answer prose visible alongside the committed artifact object', () => {
  const artifact = createCommittedArtifact({
    artifactId: 'art_live_1',
    renderer: 'markdown',
    payload: '# live title',
    digest: 'live-digest',
  });

  const html = renderToStaticMarkup(
    <Assistant
      messages={[]}
      artifacts={[]}
      activeArtifact={artifact}
      backgroundNotifications={[]}
      transcriptEntries={[]}
      finalAnswerText="Here is the live answer."
      streamError={null}
      isRunning={true}
      onOpenSource={() => {}}
      onSend={() => {}}
      onStartArtifactRun={() => {}}
      onCancel={() => {}}
    />,
  );

  assert.match(html, /Here is the live answer\./);
  assert.match(html, /live title/);
});

void test('assistant treats live finalAnswerText as plain transcript text instead of parsing a streaming artifact preview', () => {
  const html = renderToStaticMarkup(
    <Assistant
      messages={[]}
      backgroundNotifications={[]}
      transcriptEntries={[]}
      finalAnswerText={
        '<!-- GEULBAT_ARTIFACT {"renderer":"html5","digest":"romance-fantasy-character-map-v2"} -->\n<!DOCTYPE html><html lang="ko"><body><section>hello</section></body></html>\n<!-- /GEULBAT_ARTIFACT -->'
      }
      streamError={null}
      isRunning={true}
      onOpenSource={() => {}}
      onSend={() => {}}
      onStartArtifactRun={() => {}}
      onCancel={() => {}}
    />,
  );

  assert.match(html, /assistant/);
  assert.doesNotMatch(html, /<iframe/);
  assert.match(
    html,
    /&lt;!-- GEULBAT_ARTIFACT \{&quot;renderer&quot;:&quot;html5&quot;,&quot;digest&quot;:&quot;romance-fantasy-character-map-v2&quot;\} --&gt;/,
  );
});

void test('assistant keeps incomplete live artifact transport as plain text instead of a pending preview shell', () => {
  const html = renderToStaticMarkup(
    <Assistant
      messages={[]}
      backgroundNotifications={[]}
      transcriptEntries={[]}
      finalAnswerText={
        '<!-- GEULBAT_ARTIFACT {"renderer":"html5","digest":"creative-html-v1"} -->\n* { box-sizing: border-box; }\nhtml, body { margin: 0; }\nbody { min-height: 100vh; }'
      }
      streamError={null}
      isRunning={true}
      onOpenSource={() => {}}
      onSend={() => {}}
      onStartArtifactRun={() => {}}
      onCancel={() => {}}
    />,
  );

  assert.doesNotMatch(html, /<iframe/);
  assert.match(html, /\* \{ box-sizing/);
});

void test('assistant does not reconstruct artifacts from commentary plus final answer fragments', () => {
  const html = renderToStaticMarkup(
    <Assistant
      messages={[]}
      backgroundNotifications={[]}
      transcriptEntries={[
        {
          kind: 'assistant_text',
          text: '<!-- GEULBAT_ARTIFACT {"renderer":"html5","digest":"romance-fantasy-character-map-v2"} -->\n<!DOCTYPE html><html lang="ko"><head><style>body{color:red;}</style></head>',
        },
      ]}
      finalAnswerText={
        '<body><section>hello</section></body></html>\n<!-- /GEULBAT_ARTIFACT -->'
      }
      streamError={null}
      isRunning={true}
      onOpenSource={() => {}}
      onSend={() => {}}
      onStartArtifactRun={() => {}}
      onCancel={() => {}}
    />,
  );

  assert.match(html, /assistant/);
  assert.doesNotMatch(html, /<iframe/);
  assert.match(
    html,
    /&lt;body&gt;&lt;section&gt;hello&lt;\/section&gt;&lt;\/body&gt;&lt;\/html&gt;/,
  );
});

void test('assistant renders structured run transcript entries without relying on string markers', () => {
  const html = renderToStaticMarkup(
    <Assistant
      messages={[]}
      backgroundNotifications={[]}
      transcriptEntries={[
        { kind: 'assistant_text', text: 'Thinking...' },
        { kind: 'tool_activity', tool: 'write_file', state: 'running' },
        {
          kind: 'approval_request',
          pendingApproval: makeApprovalRequiredFixture({
            argumentsPreview: {
              path: 'hello.txt',
              content: 'Hello',
            },
          }),
        },
      ]}
      finalAnswerText=""
      streamError={null}
      isRunning
      onOpenSource={() => {}}
      onSend={() => {}}
      onStartArtifactRun={() => {}}
      onCancel={() => {}}
    />,
  );

  assert.match(html, /Thinking/);
  assert.match(html, /Calling write_file/);
  assert.match(html, /Write hello.txt/);
  assert.doesNotMatch(html, /\[tool_call:/);
});

void test('assistant keeps transcript content visible when a stream error is also present', () => {
  const html = renderToStaticMarkup(
    <Assistant
      messages={[]}
      backgroundNotifications={[]}
      transcriptEntries={[{ kind: 'assistant_text', text: 'Still here' }]}
      finalAnswerText=""
      streamError="[internal] socket down"
      isRunning={false}
      onOpenSource={() => {}}
      onSend={() => {}}
      onStartArtifactRun={() => {}}
      onCancel={() => {}}
    />,
  );

  assert.match(html, /Still here/);
  assert.match(html, /\[internal\] socket down/);
});

void test('assistant renders the starting placeholder only once while a run is waiting for first output', () => {
  const html = renderToStaticMarkup(
    <Assistant
      messages={[]}
      backgroundNotifications={[]}
      transcriptEntries={[]}
      finalAnswerText=""
      streamError={null}
      isRunning
      onOpenSource={() => {}}
      onSend={() => {}}
      onStartArtifactRun={() => {}}
      onCancel={() => {}}
    />,
  );

  assert.equal(html.match(/assistant \(starting\.\.\.\)/g)?.length ?? 0, 1);
  assert.equal(html.match(/Thinking\.\.\./g)?.length ?? 0, 1);
});
