import { definedPtcProps } from '../../shared/record-shape.js';

export const PTC_LAB_NETWORK_POLICY_VERSION =
  'ptc_lab_network_policy_v1' as const;
export const PTC_LAB_NETWORK_DISABLED_POLICY_ID =
  'ptc_lab_network_disabled_v1' as const;
export const PTC_LAB_DOCKER_NETWORK_NONE_POLICY_ID =
  'ptc_lab_docker_network_none_v1' as const;
export const PTC_LAB_NETWORK_TELEMETRY_DISABLED_POLICY_ID =
  'ptc_lab_network_telemetry_disabled_v1' as const;
export const PTC_LAB_OPEN_EGRESS_LOCAL_POLICY_ID =
  'ptc_lab_open_egress_local_v1' as const;
export const PTC_LAB_OPEN_EGRESS_BOUNDARY_CLAIM = 'docker_containment' as const;
export const PTC_LAB_OPEN_EGRESS_EXPLICIT_LOCAL_POLICY_ID =
  'ptc_lab_open_egress_explicit_local_v1' as const;
export const PTC_LAB_DOCKER_BRIDGE_OPEN_POLICY_ID =
  'ptc_lab_docker_bridge_open_v1' as const;
export const PTC_LAB_DOCKER_BRIDGE_OPEN_NETWORK_NAME =
  'geulbat-ptc-lab-open-v1' as const;
export const PTC_LAB_NETWORK_TELEMETRY_OPEN_POLICY_ID =
  'ptc_lab_network_telemetry_open_v1' as const;

type PtcLabNetworkMetricsCoverage =
  | 'policy_only'
  | 'owner_outcome_only'
  | 'runtime_observed';

type PtcLabNetworkOwnerKind =
  | 'network_smoke'
  | 'batch_command'
  | 'package_install'
  | 'crawler'
  | 'browser'
  | 'execute_code';

type PtcLabNetworkOutcome =
  | 'not_opened'
  | 'completed'
  | 'failed'
  | 'timeout'
  | 'cancelled';

export type PtcLabNetworkPolicy =
  | {
      mode: 'disabled';
      networkPolicyId: typeof PTC_LAB_NETWORK_DISABLED_POLICY_ID;
      policyVersion: typeof PTC_LAB_NETWORK_POLICY_VERSION;
      dockerNetworkPolicyId: typeof PTC_LAB_DOCKER_NETWORK_NONE_POLICY_ID;
      telemetryPolicyId: typeof PTC_LAB_NETWORK_TELEMETRY_DISABLED_POLICY_ID;
    }
  | {
      mode: 'open';
      networkPolicyId: typeof PTC_LAB_OPEN_EGRESS_LOCAL_POLICY_ID;
      explicitOptInPolicyId: string;
      boundaryClaim: typeof PTC_LAB_OPEN_EGRESS_BOUNDARY_CLAIM;
      policyVersion: typeof PTC_LAB_NETWORK_POLICY_VERSION;
      dockerNetworkPolicyId: typeof PTC_LAB_DOCKER_BRIDGE_OPEN_POLICY_ID;
      dockerNetworkName: typeof PTC_LAB_DOCKER_BRIDGE_OPEN_NETWORK_NAME;
      telemetryPolicyId: typeof PTC_LAB_NETWORK_TELEMETRY_OPEN_POLICY_ID;
      metricsCoverage: PtcLabNetworkMetricsCoverage;
    };

interface CreatePtcLabOpenEgressLocalPolicyArgs {
  explicitOptInPolicyId?: string;
  metricsCoverage?: PtcLabNetworkMetricsCoverage;
}

export interface PtcLabNetworkTelemetrySummary {
  networkMode: PtcLabNetworkPolicy['mode'];
  networkPolicyId: string;
  telemetryPolicyId: string;
  boundaryClaim?: typeof PTC_LAB_OPEN_EGRESS_BOUNDARY_CLAIM;
  ownerKind: PtcLabNetworkOwnerKind;
  outcome: PtcLabNetworkOutcome;
  networkOpened: boolean;
  durationMs: number;
  metricsCoverage: PtcLabNetworkMetricsCoverage;
  requestCount?: number;
  hostnameCount?: number;
  byteCount?: number;
}

type PtcLabDisabledNetworkPolicy = Extract<
  PtcLabNetworkPolicy,
  { mode: 'disabled' }
>;

type PtcLabOpenNetworkPolicy = Extract<PtcLabNetworkPolicy, { mode: 'open' }>;

export type PtcLabNetworkIdentitySnapshot =
  | (Pick<
      PtcLabDisabledNetworkPolicy,
      'mode' | 'networkPolicyId' | 'dockerNetworkPolicyId'
    > & {
      networkTelemetryPolicyId: PtcLabDisabledNetworkPolicy['telemetryPolicyId'];
    })
  | (Pick<
      PtcLabOpenNetworkPolicy,
      | 'mode'
      | 'networkPolicyId'
      | 'dockerNetworkPolicyId'
      | 'explicitOptInPolicyId'
      | 'boundaryClaim'
    > & {
      networkTelemetryPolicyId: PtcLabOpenNetworkPolicy['telemetryPolicyId'];
    });

interface BuildPtcLabNetworkTelemetrySummaryArgs {
  policy: PtcLabNetworkPolicy;
  ownerKind: PtcLabNetworkOwnerKind;
  outcome: PtcLabNetworkOutcome;
  networkOpened: boolean;
  durationMs: number;
  metricsCoverage?: PtcLabNetworkMetricsCoverage;
  requestCount?: number;
  hostnameCount?: number;
  byteCount?: number;
}

interface PtcLabNetworkSessionIdentitySource {
  reuseKey: {
    labPolicyId: string;
    network: PtcLabNetworkIdentitySnapshot;
  };
}

export function createPtcLabNetworkDisabledPolicy(): PtcLabNetworkPolicy {
  return {
    mode: 'disabled',
    networkPolicyId: PTC_LAB_NETWORK_DISABLED_POLICY_ID,
    policyVersion: PTC_LAB_NETWORK_POLICY_VERSION,
    dockerNetworkPolicyId: PTC_LAB_DOCKER_NETWORK_NONE_POLICY_ID,
    telemetryPolicyId: PTC_LAB_NETWORK_TELEMETRY_DISABLED_POLICY_ID,
  };
}

export function createPtcLabOpenEgressLocalPolicy(
  args: CreatePtcLabOpenEgressLocalPolicyArgs = {},
): PtcLabNetworkPolicy {
  const explicitOptInPolicyId =
    args.explicitOptInPolicyId ?? PTC_LAB_OPEN_EGRESS_EXPLICIT_LOCAL_POLICY_ID;
  if (!isSafeExplicitOptInPolicyId(explicitOptInPolicyId)) {
    throw new Error('PTC lab open egress explicit opt-in policy id is invalid');
  }

  return {
    mode: 'open',
    networkPolicyId: PTC_LAB_OPEN_EGRESS_LOCAL_POLICY_ID,
    explicitOptInPolicyId,
    boundaryClaim: PTC_LAB_OPEN_EGRESS_BOUNDARY_CLAIM,
    policyVersion: PTC_LAB_NETWORK_POLICY_VERSION,
    dockerNetworkPolicyId: PTC_LAB_DOCKER_BRIDGE_OPEN_POLICY_ID,
    dockerNetworkName: PTC_LAB_DOCKER_BRIDGE_OPEN_NETWORK_NAME,
    telemetryPolicyId: PTC_LAB_NETWORK_TELEMETRY_OPEN_POLICY_ID,
    metricsCoverage: args.metricsCoverage ?? 'policy_only',
  };
}

export function buildPtcLabDockerNetworkArgs(
  policy: PtcLabNetworkPolicy,
): string[] {
  return buildPtcLabDockerNetworkIdentityArgs(
    toPtcLabNetworkIdentitySnapshot(policy),
  );
}

export function buildPtcLabDockerNetworkIdentityArgs(
  identity: PtcLabNetworkIdentitySnapshot,
): string[] {
  return identity.mode === 'open'
    ? ['--network', PTC_LAB_DOCKER_BRIDGE_OPEN_NETWORK_NAME]
    : ['--network', 'none'];
}

export function buildPtcLabDockerNetworkLabels(
  policy: PtcLabNetworkPolicy,
): string[] {
  return buildPtcLabDockerNetworkIdentityLabels(
    toPtcLabNetworkIdentitySnapshot(policy),
  );
}

export function buildPtcLabDockerNetworkIdentityLabels(
  identity: PtcLabNetworkIdentitySnapshot,
): string[] {
  const labels = [
    `geulbat.networkMode=${identity.mode}`,
    `geulbat.networkPolicyId=${identity.networkPolicyId}`,
    `geulbat.dockerNetworkPolicyId=${identity.dockerNetworkPolicyId}`,
    `geulbat.networkTelemetryPolicyId=${identity.networkTelemetryPolicyId}`,
  ];

  return identity.mode === 'open'
    ? [
        ...labels,
        `geulbat.networkExplicitOptInPolicyId=${identity.explicitOptInPolicyId}`,
        `geulbat.boundaryClaim=${identity.boundaryClaim}`,
      ]
    : labels;
}

export function toPtcLabNetworkIdentitySnapshot(
  policy: PtcLabNetworkPolicy,
): PtcLabNetworkIdentitySnapshot {
  if (policy.mode === 'open') {
    return {
      mode: 'open',
      networkPolicyId: policy.networkPolicyId,
      dockerNetworkPolicyId: policy.dockerNetworkPolicyId,
      networkTelemetryPolicyId: policy.telemetryPolicyId,
      explicitOptInPolicyId: policy.explicitOptInPolicyId,
      boundaryClaim: policy.boundaryClaim,
    } satisfies PtcLabNetworkIdentitySnapshot;
  }
  return {
    mode: 'disabled',
    networkPolicyId: policy.networkPolicyId,
    dockerNetworkPolicyId: policy.dockerNetworkPolicyId,
    networkTelemetryPolicyId: policy.telemetryPolicyId,
  } satisfies PtcLabNetworkIdentitySnapshot;
}

export function doesPtcLabOpenNetworkSessionMatchPolicy(args: {
  handle: PtcLabNetworkSessionIdentitySource;
  policyId: string;
  network: Extract<PtcLabNetworkPolicy, { mode: 'open' }>;
}): boolean {
  const reuseKey = args.handle.reuseKey;
  const expectedNetwork = toPtcLabNetworkIdentitySnapshot(args.network);
  return (
    reuseKey.labPolicyId === args.policyId &&
    arePtcLabNetworkIdentitySnapshotsEqual(reuseKey.network, expectedNetwork)
  );
}

function arePtcLabNetworkIdentitySnapshotsEqual(
  left: PtcLabNetworkIdentitySnapshot,
  right: PtcLabNetworkIdentitySnapshot,
): boolean {
  const leftRecord = left as Record<string, string>;
  const rightRecord = right as Record<string, string>;
  const leftKeys = Object.keys(leftRecord);
  return (
    leftKeys.length === Object.keys(rightRecord).length &&
    leftKeys.every((key) => leftRecord[key] === rightRecord[key])
  );
}

export function buildPtcLabNetworkTelemetrySummary(
  args: BuildPtcLabNetworkTelemetrySummaryArgs,
): PtcLabNetworkTelemetrySummary {
  const metricsCoverage =
    args.metricsCoverage ??
    (args.policy.mode === 'open' ? args.policy.metricsCoverage : 'policy_only');
  if (metricsCoverage === 'runtime_observed') {
    throw new Error(
      'PTC lab runtime-observed network telemetry is not supported in this slice',
    );
  }
  if (!Number.isInteger(args.durationMs) || args.durationMs < 0) {
    throw new Error('PTC lab network telemetry duration is invalid');
  }
  if (
    metricsCoverage === 'policy_only' &&
    (args.requestCount !== undefined ||
      args.hostnameCount !== undefined ||
      args.byteCount !== undefined)
  ) {
    throw new Error(
      'PTC lab policy-only network telemetry cannot include counts',
    );
  }

  return {
    networkMode: args.policy.mode,
    networkPolicyId: args.policy.networkPolicyId,
    telemetryPolicyId: args.policy.telemetryPolicyId,
    ...(args.policy.mode === 'open'
      ? { boundaryClaim: args.policy.boundaryClaim }
      : {}),
    ownerKind: args.ownerKind,
    outcome: args.outcome,
    networkOpened: args.networkOpened,
    durationMs: args.durationMs,
    metricsCoverage,
    ...definedPtcProps({
      requestCount: args.requestCount,
      hostnameCount: args.hostnameCount,
      byteCount: args.byteCount,
    }),
  };
}

function isSafeExplicitOptInPolicyId(value: string): boolean {
  return /^[a-z0-9][a-z0-9_-]{0,127}$/u.test(value);
}
