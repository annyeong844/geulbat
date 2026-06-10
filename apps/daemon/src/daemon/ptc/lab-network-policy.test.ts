import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildPtcLabDockerNetworkArgs,
  buildPtcLabDockerNetworkLabels,
  buildPtcLabNetworkTelemetrySummary,
  createPtcLabNetworkDisabledPolicy,
  createPtcLabOpenEgressLocalPolicy,
  doesPtcLabOpenNetworkSessionMatchPolicy,
  PTC_LAB_DOCKER_BRIDGE_OPEN_NETWORK_NAME,
  PTC_LAB_DOCKER_BRIDGE_OPEN_POLICY_ID,
  PTC_LAB_DOCKER_NETWORK_NONE_POLICY_ID,
  PTC_LAB_NETWORK_DISABLED_POLICY_ID,
  PTC_LAB_NETWORK_POLICY_VERSION,
  PTC_LAB_NETWORK_TELEMETRY_DISABLED_POLICY_ID,
  PTC_LAB_NETWORK_TELEMETRY_OPEN_POLICY_ID,
  PTC_LAB_OPEN_EGRESS_BOUNDARY_CLAIM,
  PTC_LAB_OPEN_EGRESS_EXPLICIT_LOCAL_POLICY_ID,
  PTC_LAB_OPEN_EGRESS_LOCAL_POLICY_ID,
  toPtcLabNetworkIdentitySnapshot,
} from './lab-network-policy.js';

void test('createPtcLabNetworkDisabledPolicy returns stable disabled policy shape', () => {
  const policy = createPtcLabNetworkDisabledPolicy();

  assert.deepEqual(policy, {
    mode: 'disabled',
    networkPolicyId: PTC_LAB_NETWORK_DISABLED_POLICY_ID,
    policyVersion: PTC_LAB_NETWORK_POLICY_VERSION,
    dockerNetworkPolicyId: PTC_LAB_DOCKER_NETWORK_NONE_POLICY_ID,
    telemetryPolicyId: PTC_LAB_NETWORK_TELEMETRY_DISABLED_POLICY_ID,
  });
});

void test('createPtcLabOpenEgressLocalPolicy returns explicit local open policy shape', () => {
  const policy = createPtcLabOpenEgressLocalPolicy();

  assert.deepEqual(policy, {
    mode: 'open',
    networkPolicyId: PTC_LAB_OPEN_EGRESS_LOCAL_POLICY_ID,
    explicitOptInPolicyId: PTC_LAB_OPEN_EGRESS_EXPLICIT_LOCAL_POLICY_ID,
    boundaryClaim: PTC_LAB_OPEN_EGRESS_BOUNDARY_CLAIM,
    policyVersion: PTC_LAB_NETWORK_POLICY_VERSION,
    dockerNetworkPolicyId: PTC_LAB_DOCKER_BRIDGE_OPEN_POLICY_ID,
    dockerNetworkName: PTC_LAB_DOCKER_BRIDGE_OPEN_NETWORK_NAME,
    telemetryPolicyId: PTC_LAB_NETWORK_TELEMETRY_OPEN_POLICY_ID,
    metricsCoverage: 'policy_only',
  });
});

void test('createPtcLabOpenEgressLocalPolicy rejects unsafe explicit opt-in ids', () => {
  assert.throws(
    () =>
      createPtcLabOpenEgressLocalPolicy({
        explicitOptInPolicyId: '../unsafe',
      }),
    /explicit opt-in policy id/u,
  );
  assert.throws(
    () =>
      createPtcLabOpenEgressLocalPolicy({
        explicitOptInPolicyId: 'ptc_lab_open_egress\nbad',
      }),
    /explicit opt-in policy id/u,
  );
});

void test('buildPtcLabDockerNetworkArgs projects disabled and open network modes', () => {
  assert.deepEqual(
    buildPtcLabDockerNetworkArgs(createPtcLabNetworkDisabledPolicy()),
    ['--network', 'none'],
  );
  assert.deepEqual(
    buildPtcLabDockerNetworkArgs(createPtcLabOpenEgressLocalPolicy()),
    ['--network', PTC_LAB_DOCKER_BRIDGE_OPEN_NETWORK_NAME],
  );
});

void test('buildPtcLabDockerNetworkLabels returns stable sanitized labels', () => {
  const labels = buildPtcLabDockerNetworkLabels(
    createPtcLabOpenEgressLocalPolicy(),
  );

  assert.deepEqual(labels, [
    'geulbat.networkMode=open',
    `geulbat.networkPolicyId=${PTC_LAB_OPEN_EGRESS_LOCAL_POLICY_ID}`,
    `geulbat.dockerNetworkPolicyId=${PTC_LAB_DOCKER_BRIDGE_OPEN_POLICY_ID}`,
    `geulbat.networkTelemetryPolicyId=${PTC_LAB_NETWORK_TELEMETRY_OPEN_POLICY_ID}`,
    `geulbat.networkExplicitOptInPolicyId=${PTC_LAB_OPEN_EGRESS_EXPLICIT_LOCAL_POLICY_ID}`,
    `geulbat.boundaryClaim=${PTC_LAB_OPEN_EGRESS_BOUNDARY_CLAIM}`,
  ]);
});

void test('doesPtcLabOpenNetworkSessionMatchPolicy rejects lab and network identity drift', () => {
  const policyId = 'ptc_lab_policy_for_network_session_test_v1';
  const network = createPtcLabOpenEgressLocalPolicy();
  if (network.mode !== 'open') {
    throw new Error('expected open network policy');
  }
  const differentExplicitOptInNetwork = createPtcLabOpenEgressLocalPolicy({
    explicitOptInPolicyId: 'different_explicit_opt_in_v1',
  });
  if (differentExplicitOptInNetwork.mode !== 'open') {
    throw new Error('expected open network policy');
  }
  const handle = {
    reuseKey: {
      labPolicyId: policyId,
      network: toPtcLabNetworkIdentitySnapshot(network),
    },
  };

  assert.equal(
    doesPtcLabOpenNetworkSessionMatchPolicy({
      handle,
      policyId,
      network,
    }),
    true,
  );
  assert.equal(
    doesPtcLabOpenNetworkSessionMatchPolicy({
      handle,
      policyId: 'different_lab_policy_v1',
      network,
    }),
    false,
  );
  assert.equal(
    doesPtcLabOpenNetworkSessionMatchPolicy({
      handle: {
        reuseKey: {
          ...handle.reuseKey,
          network: toPtcLabNetworkIdentitySnapshot(
            createPtcLabNetworkDisabledPolicy(),
          ),
        },
      },
      policyId,
      network,
    }),
    false,
  );
  assert.equal(
    doesPtcLabOpenNetworkSessionMatchPolicy({
      handle,
      policyId,
      network: differentExplicitOptInNetwork,
    }),
    false,
  );
});

void test('buildPtcLabNetworkTelemetrySummary records policy-only outcome without URLs or bodies', () => {
  const summary = buildPtcLabNetworkTelemetrySummary({
    policy: createPtcLabOpenEgressLocalPolicy(),
    ownerKind: 'package_install',
    outcome: 'completed',
    networkOpened: true,
    durationMs: 1234,
  });

  assert.deepEqual(summary, {
    networkMode: 'open',
    networkPolicyId: PTC_LAB_OPEN_EGRESS_LOCAL_POLICY_ID,
    telemetryPolicyId: PTC_LAB_NETWORK_TELEMETRY_OPEN_POLICY_ID,
    boundaryClaim: PTC_LAB_OPEN_EGRESS_BOUNDARY_CLAIM,
    ownerKind: 'package_install',
    outcome: 'completed',
    networkOpened: true,
    durationMs: 1234,
    metricsCoverage: 'policy_only',
  });

  const serialized = JSON.stringify(summary);
  assert.doesNotMatch(serialized, /https?:\/\//u);
  assert.doesNotMatch(serialized, /Bearer|oauth|session|cookie|token/iu);
});

void test('buildPtcLabNetworkTelemetrySummary rejects runtime metric counts for policy-only coverage', () => {
  assert.throws(
    () =>
      buildPtcLabNetworkTelemetrySummary({
        policy: createPtcLabOpenEgressLocalPolicy(),
        ownerKind: 'crawler',
        outcome: 'completed',
        networkOpened: true,
        durationMs: 1,
        requestCount: 2,
      }),
    /policy-only network telemetry/u,
  );
});

void test('buildPtcLabNetworkTelemetrySummary rejects runtime-observed metrics until a runtime observer lands', () => {
  assert.throws(
    () =>
      buildPtcLabNetworkTelemetrySummary({
        policy: createPtcLabOpenEgressLocalPolicy({
          metricsCoverage: 'runtime_observed',
        }),
        ownerKind: 'crawler',
        outcome: 'completed',
        networkOpened: true,
        durationMs: 1,
      }),
    /runtime-observed network telemetry is not supported/u,
  );
});
