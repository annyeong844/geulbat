import test from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';

import {
  createCommittedArtifact,
  createCommittedArtifactMessage,
  createCommittedArtifactSourceRef,
} from '../../test-support/thread-artifact-fixtures.js';
import { STATIC_ARTIFACT_PREVIEW_RESOURCE_POLICY } from '../artifacts/artifact-static-preview-registry.js';
import { Assistant } from './Assistant.js';

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

void test('assistant falls back to raw access copy for oversized static artifact previews', () => {
  const hiddenTail = 'STATIC_PREVIEW_RESOURCE_TAIL_TOKEN';
  const artifact = createCommittedArtifact({
    artifactId: 'art_large_markdown_1',
    renderer: 'markdown',
    payload: `${Array.from(
      {
        length: STATIC_ARTIFACT_PREVIEW_RESOURCE_POLICY.maxMarkdownLines + 1,
      },
      (_, index) => `# heading ${index}`,
    ).join('\n')}\n${hiddenTail}`,
    digest: 'hidden-large-static-token',
    sourceRef: createCommittedArtifactSourceRef({
      filePath: 'notes/large-preview.md',
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
    /이 미리보기는 너무 커서 바로 렌더링하지 않았습니다\. Raw 탭에서 원본을 확인해 주세요\./,
  );
  assert.match(html, /Raw<\/strong> 탭에서 원본을 확인할 수 있습니다\./);
  assert.doesNotMatch(html, /<h1/);
  assert.doesNotMatch(html, /STATIC_PREVIEW_RESOURCE_TAIL_TOKEN/);
  assert.doesNotMatch(html, /hidden-large-static-token/);
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
