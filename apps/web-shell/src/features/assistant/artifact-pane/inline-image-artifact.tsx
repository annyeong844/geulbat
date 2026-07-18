import type { CSSProperties } from 'react';
import {
  parseImageArtifactPayload,
  type ThreadArtifactVersion,
} from '@geulbat/protocol/artifacts';

// 이미지 아티팩트는 문서형 아티팩트와 달리 채팅 흐름 속 삽화다 —
// 참조 칩/중앙 패널 경로를 타지 않고 visualize 위젯처럼 투명하게 대화에
// 인라인 렌더한다. 매니페스트가 읽히지 않으면 호출부가 칩 경로로 폴백한다.
export function canRenderInlineImageArtifact(
  artifact: ThreadArtifactVersion,
): boolean {
  if (artifact.renderer !== 'image') {
    return false;
  }
  const manifest = parseImageArtifactPayload(artifact.payload);
  if (manifest === null) {
    return false;
  }
  return (
    manifest.source.type === 'inline_base64' ||
    artifact.sourceRef?.threadId != null
  );
}

export function InlineImageArtifactMessage(props: {
  artifact: ThreadArtifactVersion;
}) {
  const { artifact } = props;
  const manifest = parseImageArtifactPayload(artifact.payload);
  if (manifest === null) {
    return null;
  }
  const threadId = artifact.sourceRef?.threadId ?? undefined;
  const src =
    manifest.source.type === 'inline_base64'
      ? `data:${manifest.mimeType};base64,${manifest.source.dataBase64}`
      : threadId !== undefined
        ? `/api/threads/${encodeURIComponent(threadId)}/media/${encodeURIComponent(manifest.source.mediaRef)}`
        : null;
  if (src === null) {
    return null;
  }
  const caption =
    manifest.provenance.revisedPrompt ?? manifest.provenance.prompt;

  return (
    <figure style={inlineImageStyles.wrap}>
      <img
        style={inlineImageStyles.image}
        src={src}
        alt={manifest.provenance.prompt}
      />
      <figcaption style={inlineImageStyles.caption}>{caption}</figcaption>
    </figure>
  );
}

// 카드 배경/그림자 없이 대화에 녹아드는 투명 표면
const inlineImageStyles = {
  wrap: {
    display: 'flex',
    flexDirection: 'column',
    gap: 6,
    margin: 0,
  },
  image: {
    maxWidth: '100%',
    height: 'auto',
    borderRadius: 8,
    alignSelf: 'flex-start',
  },
  caption: {
    fontSize: 12,
    lineHeight: 1.5,
    color: 'var(--on-surface-muted)',
    fontFamily: 'var(--font-ui-label)',
    wordBreak: 'break-word',
  },
} satisfies Record<string, CSSProperties>;
