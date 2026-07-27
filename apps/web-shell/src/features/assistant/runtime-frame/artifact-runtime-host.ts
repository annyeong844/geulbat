import { DEFAULT_ARTIFACT_RUNTIME_HOST_ORIGIN } from '@geulbat/protocol/artifact-runtime-host';

export {
  ARTIFACT_RUNTIME_HOST_BOOT_ACTION,
  ARTIFACT_RUNTIME_HOST_MESSAGE_KIND,
  ARTIFACT_RUNTIME_HOST_READY_ACTION,
  ARTIFACT_RUNTIME_HOST_RESIZE_ACTION,
  createArtifactRuntimeHostBootMessage,
} from '@geulbat/protocol/artifact-runtime-host';
export { DEFAULT_ARTIFACT_RUNTIME_HOST_ORIGIN };

const ARTIFACT_RUNTIME_HOST_PATH = '/artifact-runtime/host';

/**
 * 데몬이 화면을 서빙하므로 아티팩트 런타임 호스트는 언제나 same-origin이다.
 * 개발과 제품이 같은 위상을 쓰기 때문에 고를 것이 없다 — 포트를 비교하거나
 * 빌드 모드를 보는 분기는 위상이 둘일 때만 필요했다.
 *
 * `locationOrigin`이 없는 경우는 `window`가 없는 실행(Node)뿐이고, 거기에는
 * 프레임을 띄울 문서가 아예 없다. 그때 문서화된 기본 origin을 돌려주는 것은
 * 어느 데몬인지 추측해서가 아니라 이 정체성 값이 실제로 쓰이지 않기 때문이다.
 */
export function resolveArtifactRuntimeHostOrigin(
  locationOrigin?: string,
): string {
  if (typeof locationOrigin !== 'string' || locationOrigin.trim() === '') {
    return DEFAULT_ARTIFACT_RUNTIME_HOST_ORIGIN;
  }

  return new URL(locationOrigin).origin;
}

export function resolveArtifactRuntimeHostUrl(locationOrigin?: string): string {
  return new URL(
    ARTIFACT_RUNTIME_HOST_PATH,
    `${resolveArtifactRuntimeHostOrigin(locationOrigin)}/`,
  ).toString();
}
