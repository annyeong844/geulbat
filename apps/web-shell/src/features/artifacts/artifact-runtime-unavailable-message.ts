import type { ArtifactPreviewSurface } from './artifact-types.js';

export function describeArtifactRuntimeUnavailableMessage(
  surface: Extract<ArtifactPreviewSurface, { kind: 'unavailable' }>,
): string {
  switch (surface.code) {
    case 'sanitize_rejected':
      return '이 캔버스는 현재 웹쉘 경계를 넘는 링크나 리소스 때문에 바로 열 수 없습니다.';
    case 'policy_blocked':
      return '이 캔버스는 현재 웹쉘 경계를 넘는 동작 때문에 일부 기능을 실행하지 못했습니다.';
    case 'boot_failed':
      return describeArtifactBootFailureMessage(surface.detail);
    case 'runtime_crashed':
      return '캔버스가 실행 중 멈췄습니다. 다시 열어 보거나 원본을 확인해 주세요.';
  }
}

function describeArtifactBootFailureMessage(detail: string): string {
  const normalizedDetail = detail.trim();
  if (
    normalizedDetail.includes(
      'inline source manifests with files/entry are unsupported',
    )
  ) {
    return '이 react bundle은 inline source compile 단계에서 실패했습니다.';
  }
  if (normalizedDetail.length > 0) {
    return `캔버스를 시작하지 못했습니다. ${normalizedDetail}`;
  }
  return '캔버스를 시작하지 못했습니다. 원본을 확인한 뒤 다시 시도해 주세요.';
}
