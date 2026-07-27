import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { brandRunId } from '../../lib/id-brand-helpers.js';
import { createAssistantProps } from '../../test-support/create-assistant-props.js';
import {
  createCommittedArtifact,
  createCommittedArtifactMessage,
} from '../../test-support/thread-artifact-fixtures.js';
import { Assistant } from './Assistant.js';

void test('assistant keeps legacy transcript envelope content as plain text without preview controls', () => {
  const html = renderToStaticMarkup(
    <Assistant
      {...createAssistantProps({
        conversation: {
          messages: [
            {
              entryId: 'entry-legacy-artifact-envelope',
              role: 'assistant',
              content:
                '<!-- GEULBAT_ARTIFACT {"renderer":"markdown","digest":"요약"} -->\n# title\n<!-- /GEULBAT_ARTIFACT -->',
              timestamp: '2026-03-24T00:00:01.000Z',
              metadata: {
                sourceFile: 'episodes/ch01.md',
                sourceRunId: brandRunId('run-1'),
                phase: 'final_answer',
              },
            },
          ],
        },
      })}
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
      {...createAssistantProps({
        conversation: {
          messages: [createCommittedArtifactMessage(artifact)],
        },
        artifacts: {
          versions: [artifact],
        },
      })}
    />,
  );

  assert.match(html, /보기/);
  assert.match(html, /적용/);
  assert.match(html, /내보내기/);
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
      {...createAssistantProps({
        conversation: {
          messages: [
            createCommittedArtifactMessage(artifact, {
              content: 'Here is the normalized artifact.',
            }),
          ],
        },
        artifacts: {
          versions: [artifact],
        },
      })}
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
      {...createAssistantProps({
        conversation: {
          finalAnswerText: 'Here is the live answer.',
        },
        artifacts: {
          versions: [],
          activeVersion: artifact,
        },
        runState: {
          isRunning: true,
        },
      })}
    />,
  );

  assert.match(html, /Here is the live answer\./);
  assert.match(html, /live title/);
});

void test('assistant treats live finalAnswerText as plain transcript text instead of parsing a streaming artifact preview', () => {
  const html = renderToStaticMarkup(
    <Assistant
      {...createAssistantProps({
        conversation: {
          finalAnswerText:
            '<!-- GEULBAT_ARTIFACT {"renderer":"html5","digest":"romance-fantasy-character-map-v2"} -->\n<!DOCTYPE html><html lang="ko"><body><section>hello</section></body></html>\n<!-- /GEULBAT_ARTIFACT -->',
        },
        runState: {
          isRunning: true,
        },
      })}
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
      {...createAssistantProps({
        conversation: {
          finalAnswerText:
            '<!-- GEULBAT_ARTIFACT {"renderer":"html5","digest":"creative-html-v1"} -->\n* { box-sizing: border-box; }\nhtml, body { margin: 0; }\nbody { min-height: 100vh; }',
        },
        runState: {
          isRunning: true,
        },
      })}
    />,
  );

  assert.doesNotMatch(html, /<iframe/);
  assert.match(html, /\* \{ box-sizing/);
});

void test('assistant does not reconstruct artifacts from commentary plus final answer fragments', () => {
  const html = renderToStaticMarkup(
    <Assistant
      {...createAssistantProps({
        conversation: {
          transcriptEntries: [
            {
              kind: 'assistant_text',
              text: '<!-- GEULBAT_ARTIFACT {"renderer":"html5","digest":"romance-fantasy-character-map-v2"} -->\n<!DOCTYPE html><html lang="ko"><head><style>body{color:red;}</style></head>',
            },
          ],
          finalAnswerText:
            '<body><section>hello</section></body></html>\n<!-- /GEULBAT_ARTIFACT -->',
        },
        runState: {
          isRunning: true,
        },
      })}
    />,
  );

  assert.match(html, /assistant/);
  assert.doesNotMatch(html, /<iframe/);
  assert.match(
    html,
    /&lt;body&gt;&lt;section&gt;hello&lt;\/section&gt;&lt;\/body&gt;&lt;\/html&gt;/,
  );
});
