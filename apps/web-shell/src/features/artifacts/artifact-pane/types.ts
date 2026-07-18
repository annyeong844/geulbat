// 작가-facing 탭 2개: 보기(렌더된 미리보기) / 원문(아티팩트 소스 텍스트).
// 구 Write/Raw는 payload/envelope 구분이었으나 작가에게 같은 화면이라 통합 (§8.7 해소).
export type ArtifactTab = 'show' | 'source';

export interface ArtifactSurfaceStateBadge {
  label: string;
  tone: 'info' | 'warn';
}
