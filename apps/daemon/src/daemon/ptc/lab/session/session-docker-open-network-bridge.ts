import { PTC_LAB_DOCKER_BRIDGE_OPEN_POLICY_ID } from '../network/lab-network-policy.js';
import { sanitizePtcPrivateMarkers } from '../../shared/output-redaction.js';
import type { PtcSessionDockerCommandResult } from './session-docker-contract.js';

export const PTC_SESSION_DOCKER_OPEN_NETWORK_BRIDGE_MANAGED_LABEL =
  'geulbat.ptc.managedBridge=v1' as const;
const PTC_SESSION_DOCKER_OPEN_NETWORK_BRIDGE_POLICY_LABEL =
  `geulbat.ptc.bridgePolicyId=${PTC_LAB_DOCKER_BRIDGE_OPEN_POLICY_ID}` as const;

type PtcOpenNetworkBridgeDockerExecutor = (
  dockerArgs: string[],
  signal?: AbortSignal,
) => Promise<PtcSessionDockerCommandResult>;

type PtcOpenNetworkBridgeEnsureResult =
  | { ok: true; outcome: 'adopted' | 'created' }
  | {
      ok: false;
      reasonCode: 'network_backend_unavailable';
      message: string;
      diagnostics: Record<string, string | number | boolean>;
    };

// Slice 1b: daemon-owned inspect → adopt → create for the named local open
// egress bridge. Adoption accepts an operator-provisioned bridge unchanged, so
// the former manual-prerequisite workflow keeps working; creation is labeled so
// daemon-managed bridges are identifiable. Never inspects, creates, or adopts
// any network other than the exact expected name.
export async function ensurePtcOpenNetworkBridge(args: {
  networkName: string;
  runDocker: PtcOpenNetworkBridgeDockerExecutor;
  signal?: AbortSignal;
}): Promise<PtcOpenNetworkBridgeEnsureResult> {
  const existing = await inspectBridge(args);
  if (existing.present) {
    return { ok: true, outcome: 'adopted' };
  }

  const create = await args.runDocker(
    [
      'network',
      'create',
      '--label',
      PTC_SESSION_DOCKER_OPEN_NETWORK_BRIDGE_MANAGED_LABEL,
      '--label',
      PTC_SESSION_DOCKER_OPEN_NETWORK_BRIDGE_POLICY_LABEL,
      args.networkName,
    ],
    args.signal,
  );
  if (isSuccessfulExit(create)) {
    return { ok: true, outcome: 'created' };
  }

  // Concurrent launches under different session identities can race on the
  // single shared bridge. A create that lost the race must adopt the winner's
  // bridge instead of failing closed.
  if (isBridgeAlreadyExists(create)) {
    const raced = await inspectBridge(args);
    if (raced.present) {
      return { ok: true, outcome: 'adopted' };
    }
  }

  return {
    ok: false,
    reasonCode: 'network_backend_unavailable',
    message: 'PTC lab open egress Docker network could not be ensured',
    diagnostics: {
      networkName: args.networkName,
      createResultKind: create.kind,
      stderr: sanitizeBridgeDiagnostic(create.stderr),
    },
  };
}

async function inspectBridge(args: {
  networkName: string;
  runDocker: PtcOpenNetworkBridgeDockerExecutor;
  signal?: AbortSignal;
}): Promise<{ present: boolean }> {
  const inspect = await args.runDocker(
    ['network', 'inspect', args.networkName],
    args.signal,
  );
  return { present: isSuccessfulExit(inspect) };
}

function isSuccessfulExit(result: PtcSessionDockerCommandResult): boolean {
  return result.kind === 'exit' && result.exitCode === 0;
}

function isBridgeAlreadyExists(result: PtcSessionDockerCommandResult): boolean {
  return /already exists/iu.test(result.stderr);
}

function sanitizeBridgeDiagnostic(value: string): string {
  return sanitizePtcPrivateMarkers(value).slice(0, 512);
}
