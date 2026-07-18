import type { ThreadArtifactVersion } from '@geulbat/protocol/artifacts';

// 채팅 컬럼에는 아티팩트 본문을 그리지 않는다 — 대화에는 참조 칩만 남기고
// 실제 렌더는 중앙 아티팩트 패널이 맡는다. 칩을 누르면 그 아티팩트가
// 중앙 넓은 화면으로 열린다.
export function ArtifactReferenceChip(props: {
  artifact: ThreadArtifactVersion;
  isStreaming?: boolean;
  onOpen: (artifact: ThreadArtifactVersion) => void;
}) {
  const { artifact, isStreaming = false, onOpen } = props;
  const title =
    artifact.title !== null && artifact.title.trim() !== ''
      ? artifact.title
      : '아티팩트';
  const meta = [
    artifact.renderer,
    `v${artifact.version}`,
    ...(isStreaming ? ['생성 중…'] : []),
  ].join(' · ');

  return (
    <button
      type="button"
      className="artifact-reference-chip"
      aria-label={`${title} 아티팩트를 중앙 화면에서 열기`}
      onClick={() => onOpen(artifact)}
    >
      <span className="artifact-reference-icon" aria-hidden="true">
        ▦
      </span>
      <span className="artifact-reference-main">
        <span className="artifact-reference-title">{title}</span>
        <span className="artifact-reference-meta">{meta}</span>
      </span>
      <span className="artifact-reference-open" aria-hidden="true">
        펼치기 ↗
      </span>
    </button>
  );
}
