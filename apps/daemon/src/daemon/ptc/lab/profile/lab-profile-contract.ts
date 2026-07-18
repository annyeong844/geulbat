export const PTC_SAFE_SUBSET_DEFAULT_POLICY_ID =
  'ptc_safe_subset_default_v1' as const;
export const PTC_LAB_LOCAL_DOCKER_POLICY_ID =
  'ptc_lab_local_docker_policy_v1' as const;
export const PTC_LAB_LOCAL_DOCKER_BATCH_COMMAND_POLICY_ID =
  'ptc_lab_local_docker_batch_command_v1' as const;
// Blatant-authority policy id (owner decision Q1): sessions under this policy
// run exec itself on the open network, not only install_packages.
export const PTC_LAB_OPEN_NETWORK_PACKAGE_INSTALL_POLICY_ID =
  'ptc_lab_execute_code_open_network_package_install_v1' as const;
export const PTC_LAB_LOCAL_DOCKER_BATCH_COMMAND_MAX_COMMAND_MS = 300_000;
export const PTC_LAB_LOCAL_DOCKER_BATCH_COMMAND_MAX_PROCESS_COUNT = 64;
export const PTC_LAB_LOCAL_DOCKER_BATCH_COMMAND_MAX_BUFFERED_BYTES_PER_STREAM =
  16 * 1024 * 1024;

export type PtcLabPolicyId = `ptc_lab_${string}_v1`;
export type PtcProfileAdmissionPolicyId =
  | typeof PTC_SAFE_SUBSET_DEFAULT_POLICY_ID
  | PtcLabPolicyId;
