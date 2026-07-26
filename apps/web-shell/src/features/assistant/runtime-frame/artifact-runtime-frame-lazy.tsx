import { lazy, Suspense, type ComponentProps } from 'react';

import type { ArtifactRuntimeFrame as ArtifactRuntimeFrameComponent } from './artifact-runtime-frame.js';

// 런타임 프레임은 아티팩트/visualize를 열 때만 마운트된다. 프레임 사슬이
// 끌고 오는 런타임 문서 소스 문자열(~90KB)을 초기 번들에서 떼어내기 위해
// 지연 로딩한다 — 사용처는 이 래퍼만 import한다.
const LazyArtifactRuntimeFrame = lazy(async () => {
  const module = await import('./artifact-runtime-frame.js');
  return { default: module.ArtifactRuntimeFrame };
});

type ArtifactRuntimeFrameProps = ComponentProps<
  typeof ArtifactRuntimeFrameComponent
>;

export function ArtifactRuntimeFrame(props: ArtifactRuntimeFrameProps) {
  // fallback은 비워 둔다 — 프레임 내부 iframe도 비동기로 채워지므로
  // 청크 로딩 수 ms가 기존 로딩 경험과 구분되지 않는다.
  return (
    <Suspense fallback={null}>
      <LazyArtifactRuntimeFrame {...props} />
    </Suspense>
  );
}
