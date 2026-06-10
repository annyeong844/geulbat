import test from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ThreadArtifactVersion } from '@geulbat/protocol/artifacts';
import type { ThreadMessage } from '@geulbat/protocol/threads';

import { Assistant } from './Assistant.js';
import { brandProjectId, brandThreadId } from '../../lib/id-brand-helpers.js';
import { makeApprovalRequiredFixture } from '../../test-support/protocol-fixtures.js';

const PROJECT_ID = brandProjectId('workspace');
const THREAD_ID = brandThreadId('00000000-0000-4000-8000-000000000001');

type CommittedArtifactSourceRef = NonNullable<
  ThreadArtifactVersion['sourceRef']
>;

function createCommittedArtifactSourceRef(
  overrides: Partial<Omit<CommittedArtifactSourceRef, 'kind' | 'filePath'>> & {
    filePath?: string | null;
  } = {},
): CommittedArtifactSourceRef {
  const projectId = overrides.projectId ?? PROJECT_ID;
  const threadId = overrides.threadId ?? THREAD_ID;
  const runId = overrides.runId ?? 'run-1';
  const messageTimestamp =
    overrides.messageTimestamp ?? '2026-03-24T00:00:01.000Z';
  const filePath =
    overrides.filePath === undefined ? 'episodes/ch01.md' : overrides.filePath;

  if (filePath === null) {
    return {
      kind: 'thread',
      projectId,
      threadId,
      runId,
      filePath: null,
      messageTimestamp,
    };
  }

  return {
    kind: 'thread-file',
    projectId,
    threadId,
    runId,
    filePath,
    messageTimestamp,
  };
}

function createCommittedArtifact(
  overrides: Partial<ThreadArtifactVersion> & {
    artifactId: string;
    renderer: ThreadArtifactVersion['renderer'];
    payload: string;
  },
): ThreadArtifactVersion {
  return {
    artifactId: overrides.artifactId,
    version: overrides.version ?? 1,
    parentVersion: overrides.parentVersion ?? null,
    baseVersion: overrides.baseVersion ?? null,
    renderer: overrides.renderer,
    payload: overrides.payload,
    digest: overrides.digest ?? null,
    contentHash: overrides.contentHash ?? 'hash',
    createdAt: overrides.createdAt ?? '2026-03-24T00:00:01.000Z',
    createdByRunId: overrides.createdByRunId ?? 'run-1',
    previewValidation: overrides.previewValidation ?? { ok: true },
    title: overrides.title ?? null,
    persistenceEpoch: overrides.persistenceEpoch ?? 0,
    sourceRef: overrides.sourceRef ?? createCommittedArtifactSourceRef(),
  };
}

function createCommittedArtifactMessage(
  artifact: ThreadArtifactVersion,
  overrides: Partial<{
    content: string;
    timestamp: string;
    sourceFile: string;
    sourceRunId: string;
  }> = {},
): ThreadMessage {
  const sourceFile =
    overrides.sourceFile ?? artifact.sourceRef?.filePath ?? undefined;
  const sourceRunId =
    overrides.sourceRunId ?? artifact.sourceRef?.runId ?? undefined;
  return {
    role: 'assistant' as const,
    content: overrides.content ?? '',
    timestamp: overrides.timestamp ?? '2026-03-24T00:00:01.000Z',
    metadata: {
      phase: 'final_answer',
      ...(sourceFile !== undefined ? { sourceFile } : {}),
      ...(sourceRunId !== undefined ? { sourceRunId } : {}),
      artifactRefs: [
        { artifactId: artifact.artifactId, version: artifact.version },
      ],
      activeArtifactRef: {
        artifactId: artifact.artifactId,
        version: artifact.version,
      },
    },
  };
}

void test('background notifications render after transcript content so auto-scroll keeps them visible', () => {
  const html = renderToStaticMarkup(
    <Assistant
      messages={[
        {
          role: 'user',
          content: 'prompt',
          timestamp: '2026-03-24T00:00:00.000Z',
        },
        {
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
  const artifact: ThreadArtifactVersion = {
    artifactId: 'art_1',
    version: 1,
    parentVersion: null,
    baseVersion: null,
    renderer: 'markdown',
    payload: '# title',
    digest: '요약',
    contentHash: 'hash',
    createdAt: '2026-03-24T00:00:01.000Z',
    createdByRunId: 'run-1',
    previewValidation: { ok: true },
    title: null,
    persistenceEpoch: 0,
    sourceRef: createCommittedArtifactSourceRef(),
  };

  const html = renderToStaticMarkup(
    <Assistant
      messages={[
        {
          role: 'assistant',
          content: '',
          timestamp: '2026-03-24T00:00:01.000Z',
          metadata: {
            sourceFile: 'episodes/ch01.md',
            sourceRunId: 'run-1',
            phase: 'final_answer',
            artifactRefs: [{ artifactId: 'art_1', version: 1 }],
            activeArtifactRef: { artifactId: 'art_1', version: 1 },
          },
        },
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

  assert.match(html, /Show/);
  assert.match(html, /Apply/);
  assert.match(html, /Export/);
  assert.match(html, /title/);
  assert.doesNotMatch(html, /요약/);
});

void test('assistant keeps assistant prose visible when a committed artifact ref is present', () => {
  const artifact: ThreadArtifactVersion = {
    artifactId: 'art_backfilled_1',
    version: 1,
    parentVersion: null,
    baseVersion: null,
    renderer: 'markdown',
    payload: '# normalized title',
    digest: 'normalized-digest',
    contentHash: 'hash',
    createdAt: '2026-03-24T00:00:01.000Z',
    createdByRunId: 'run-1',
    previewValidation: { ok: true },
    title: null,
    persistenceEpoch: 0,
    sourceRef: createCommittedArtifactSourceRef(),
  };

  const html = renderToStaticMarkup(
    <Assistant
      messages={[
        {
          role: 'assistant',
          content: 'Here is the normalized artifact.',
          timestamp: '2026-03-24T00:00:01.000Z',
          metadata: {
            sourceFile: 'episodes/ch01.md',
            sourceRunId: 'run-1',
            phase: 'final_answer',
            artifactRefs: [{ artifactId: 'art_backfilled_1', version: 1 }],
            activeArtifactRef: { artifactId: 'art_backfilled_1', version: 1 },
          },
        },
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
  const artifact: ThreadArtifactVersion = {
    artifactId: 'art_live_1',
    version: 1,
    parentVersion: null,
    baseVersion: null,
    renderer: 'markdown',
    payload: '# live title',
    digest: 'live-digest',
    contentHash: 'hash',
    createdAt: '2026-03-24T00:00:01.000Z',
    createdByRunId: 'run-1',
    previewValidation: { ok: true },
    title: null,
    persistenceEpoch: 0,
    sourceRef: createCommittedArtifactSourceRef(),
  };

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

void test('assistant renders code artifact preview through the static preview registry', () => {
  const artifact = createCommittedArtifact({
    artifactId: 'art_code_1',
    renderer: 'code',
    payload: 'const value = 1;',
    digest: 'snippet',
    sourceRef: createCommittedArtifactSourceRef({
      filePath: 'episodes/ch01.ts',
    }),
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

  assert.match(html, /const value = 1;/);
  assert.doesNotMatch(html, />Apply</);
  assert.doesNotMatch(html, />Export</);
  assert.doesNotMatch(html, /snippet/);
});

void test('assistant renders diff artifact preview through the static preview registry', () => {
  const artifact = createCommittedArtifact({
    artifactId: 'art_diff_1',
    renderer: 'diff',
    payload: '@@ -1 +1 @@\n-old\n+new',
    digest: 'patch',
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

  assert.match(html, /@@ -1 \+1 @@/);
  assert.match(html, /-old/);
  assert.match(html, /\+new/);
  assert.doesNotMatch(html, />Apply</);
  assert.doesNotMatch(html, />Export</);
  assert.doesNotMatch(html, /patch/);
});

void test('assistant renders table artifact preview through the static preview registry', () => {
  const artifact = createCommittedArtifact({
    artifactId: 'art_table_1',
    renderer: 'table',
    payload: '| name | score |\n| --- | --- |\n| sample | 10 |\n| mari | 9 |',
    digest: 'hidden-table-token-123',
    sourceRef: createCommittedArtifactSourceRef({
      filePath: 'notes/scores.md',
    }),
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

  assert.match(html, /<table/);
  assert.match(html, /name/);
  assert.match(html, /score/);
  assert.match(html, /sample/);
  assert.match(html, /mari/);
  assert.doesNotMatch(html, />Apply</);
  assert.doesNotMatch(html, />Export</);
  assert.doesNotMatch(html, /hidden-table-token-123/);
});

void test('assistant renders html5 artifact inside a sandboxed iframe', () => {
  const artifact = createCommittedArtifact({
    artifactId: 'art_html5_1',
    renderer: 'html5',
    payload: '<section><h1>Hello</h1><a href="#footnote">Jump</a></section>',
    digest: 'hidden-page-token',
    sourceRef: createCommittedArtifactSourceRef({
      filePath: 'notes/preview.html',
    }),
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

  assert.match(html, /<iframe/);
  assert.match(html, /sandbox="allow-scripts allow-forms allow-same-origin"/);
  assert.match(
    html,
    /src="http:\/\/127\.0\.0\.1:3456\/artifact-runtime\/host\?[^"]*rev=/,
  );
  assert.doesNotMatch(html, />Apply</);
  assert.doesNotMatch(html, />Export</);
  assert.doesNotMatch(html, /hidden-page-token/);
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

void test('assistant renders js artifact inside a download-capable sandboxed iframe', () => {
  const artifact = createCommittedArtifact({
    artifactId: 'art_js_1',
    renderer: 'js',
    payload:
      'const root = document.getElementById("geulbat-js-root"); if (root) root.textContent = "hello";',
    digest: 'hidden-js-token',
    sourceRef: createCommittedArtifactSourceRef({
      filePath: 'notes/preview.js',
    }),
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

  assert.match(html, /<iframe/);
  assert.match(
    html,
    /sandbox="allow-scripts allow-forms allow-same-origin allow-downloads"/,
  );
  assert.match(
    html,
    /src="http:\/\/127\.0\.0\.1:3456\/artifact-runtime\/host\?[^"]*rev=/,
  );
  assert.doesNotMatch(html, />Apply</);
  assert.doesNotMatch(html, />Export</);
  assert.doesNotMatch(html, /hidden-js-token/);
});

void test('assistant renders react_bundle artifact inside a sandboxed iframe', () => {
  const artifact = createCommittedArtifact({
    artifactId: 'art_react_bundle_1',
    renderer: 'react_bundle',
    payload:
      '{"entryUrl":"https://fixtures.geulbat.local/public-web/react-bundle-counter/entry.js"}',
    digest: 'hidden-react-token',
    sourceRef: createCommittedArtifactSourceRef({
      filePath: 'notes/react-preview.js',
    }),
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

  assert.match(html, /<iframe/);
  assert.match(html, /sandbox="allow-scripts allow-forms allow-same-origin"/);
  assert.match(
    html,
    /src="http:\/\/127\.0\.0\.1:3456\/artifact-runtime\/host\?[^"]*rev=/,
  );
  assert.doesNotMatch(html, />Apply</);
  assert.doesNotMatch(html, />Export</);
  assert.doesNotMatch(html, /hidden-react-token/);
});

void test('assistant shows a user-facing unavailable state for disallowed html5 boundary URLs', () => {
  const artifact = createCommittedArtifact({
    artifactId: 'art_html5_disallowed_1',
    renderer: 'html5',
    payload: '<section><a href="javascript:alert(1)">Hello</a></section>',
    digest: 'hidden-page-token',
    sourceRef: createCommittedArtifactSourceRef({
      filePath: 'notes/preview.html',
    }),
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

  assert.match(
    html,
    /이 캔버스는 현재 웹쉘 경계를 넘는 링크나 리소스 때문에 바로 열 수 없습니다\./,
  );
  assert.match(html, /Raw<\/strong> 탭에서 원본을 확인할 수 있습니다\./);
  assert.doesNotMatch(html, /<iframe/);
  assert.doesNotMatch(html, /sanitize_rejected/);
});

void test('assistant shows a user-facing boot failure for empty js payloads', () => {
  const artifact = createCommittedArtifact({
    artifactId: 'art_js_empty_1',
    renderer: 'js',
    payload: '   ',
    digest: 'hidden-js-token',
    sourceRef: createCommittedArtifactSourceRef({
      filePath: 'notes/preview.js',
    }),
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

  assert.match(
    html,
    /캔버스를 시작하지 못했습니다\. js artifact payload is empty/,
  );
  assert.match(html, /Raw<\/strong> 탭에서 원본을 확인할 수 있습니다\./);
  assert.match(html, /js artifact payload is empty/);
  assert.doesNotMatch(html, /<iframe/);
  assert.doesNotMatch(html, /boot_failed/);
});

void test('assistant shows pending preview state for inline react bundle source manifests during SSR', () => {
  const artifact = createCommittedArtifact({
    artifactId: 'art_react_bundle_inline_1',
    renderer: 'react_bundle',
    payload: JSON.stringify({
      files: {
        'App.jsx': 'export default function App() { return null; }',
        'styles.css': 'body { margin: 0; }',
      },
      entry: 'App.jsx',
    }),
    digest: 'hidden-inline-react-token',
    sourceRef: createCommittedArtifactSourceRef({
      filePath: 'notes/react-inline-preview.json',
    }),
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

  assert.match(html, /캔버스 미리보기 준비 중/);
  assert.match(html, /리액트 번들을 준비하고 있습니다\.\.\./);
  assert.doesNotMatch(html, /Raw<\/strong> 탭에서 원본을 확인할 수 있습니다\./);
  assert.doesNotMatch(
    html,
    /react bundle inline source manifests with files\/entry are unsupported/,
  );
  assert.doesNotMatch(html, /hidden-inline-react-token/);
});

void test('assistant disables artifact apply and export actions while a run is active', () => {
  const artifact = createCommittedArtifact({
    artifactId: 'art_markdown_running_1',
    renderer: 'markdown',
    payload: '# title',
    digest: '요약',
    sourceRef: createCommittedArtifactSourceRef({
      filePath: 'episodes/ch01.md',
    }),
  });
  const html = renderToStaticMarkup(
    <Assistant
      messages={[createCommittedArtifactMessage(artifact)]}
      artifacts={[artifact]}
      backgroundNotifications={[]}
      transcriptEntries={[]}
      finalAnswerText=""
      streamError={null}
      isRunning={true}
      onOpenSource={() => {}}
      onSend={() => {}}
      onStartArtifactRun={() => {}}
      onCancel={() => {}}
    />,
  );

  assert.match(html, /<button[^>]*disabled=""[^>]*>Apply<\/button>/);
  assert.match(html, /<button[^>]*disabled=""[^>]*>Export<\/button>/);
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
