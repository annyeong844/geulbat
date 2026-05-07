import { DEFAULT_ARTIFACT_RUNTIME_HOST_ORIGIN } from '@geulbat/protocol/artifact-runtime-host';

export {
  ARTIFACT_RUNTIME_HOST_BOOT_ACTION,
  ARTIFACT_RUNTIME_HOST_MESSAGE_KIND,
  ARTIFACT_RUNTIME_HOST_READY_ACTION,
  ARTIFACT_RUNTIME_HOST_RESIZE_ACTION,
  createArtifactRuntimeHostBootMessage,
} from '@geulbat/protocol/artifact-runtime-host';
export { DEFAULT_ARTIFACT_RUNTIME_HOST_ORIGIN };

const LOOPBACK_ORIGIN_PATTERN =
  /^https?:\/\/(?:127\.0\.0\.1|localhost)(?::\d+)?$/;
const DAEMON_PORT_PATTERN = /^https?:\/\/(?:127\.0\.0\.1|localhost):3456$/;

const ARTIFACT_RUNTIME_HOST_PATH = '/artifact-runtime/host';

export function resolveArtifactRuntimeHostOrigin(
  locationOrigin?: string,
): string {
  if (typeof locationOrigin !== 'string' || locationOrigin.trim() === '') {
    return DEFAULT_ARTIFACT_RUNTIME_HOST_ORIGIN;
  }

  const normalizedOrigin = new URL(locationOrigin).origin;
  if (!LOOPBACK_ORIGIN_PATTERN.test(normalizedOrigin)) {
    return normalizedOrigin;
  }
  if (DAEMON_PORT_PATTERN.test(normalizedOrigin)) {
    return normalizedOrigin;
  }
  return DEFAULT_ARTIFACT_RUNTIME_HOST_ORIGIN;
}

export function resolveArtifactRuntimeHostUrl(locationOrigin?: string): string {
  return new URL(
    ARTIFACT_RUNTIME_HOST_PATH,
    `${resolveArtifactRuntimeHostOrigin(locationOrigin)}/`,
  ).toString();
}
