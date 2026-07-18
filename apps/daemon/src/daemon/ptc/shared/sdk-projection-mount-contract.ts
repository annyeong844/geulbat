export const PTC_SESSION_DOCKER_SDK_CONTAINER_ROOT = '/geulbat/sdk' as const;
export const PTC_SESSION_DOCKER_SDK_PROJECTION_MOUNT_POLICY_ID =
  'ptc_session_sdk_projection_read_only_mount_v1' as const;

export interface PtcSessionDockerSdkProjectionMount {
  hostRootPath: string;
  containerRootPath: typeof PTC_SESSION_DOCKER_SDK_CONTAINER_ROOT;
  mountPolicyId: typeof PTC_SESSION_DOCKER_SDK_PROJECTION_MOUNT_POLICY_ID;
  sdkVersion: string;
  sdkProjectionHash: `sha256:${string}`;
  policyId: string;
  importSpecifier: string;
}
