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
 * 데몬이 같은 URL origin에서 런타임 호스트 문서를 서빙하지만, iframe은
 * `allow-same-origin` 없이 mount되어 실제 document origin이 opaque(`null`)다.
 * 호스트 URL을 별도 포트로 추측하지 않고 현재 데몬에 고정하는 함수다.
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
