import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  createPtcLabBrowserPageLoadEvidencePolicy,
  createPtcLabBrowserTextEvidencePolicy,
} from '../../lab/browser/core/lab-browser-policy.js';
import type { PtcLabPolicyId } from '../../lab/profile/lab-profile-contract.js';
import type { PtcLabPolicyProjection } from '../../lab/profile/lab-profile.js';
import {
  PTC_SESSION_DOCKER_DEFAULT_POLICY,
  type PtcSessionDockerManager,
  type PtcSessionDockerPolicy,
} from '../../lab/session/session-docker-contract.js';
import { createPtcBrowserStateRuntimeOwner } from './browser-state-runtime.js';

const FAKE_SESSION_MANAGER: PtcSessionDockerManager = {
  getOrCreate: async () => ({
    ok: false,
    reasonCode: 'docker_unavailable',
    message: 'fake session manager is capture-only',
  }),
  close: async () => ({ ok: true, value: undefined }),
  closeAll: async () => ({ ok: true, value: undefined }),
};

async function captureLaneDockerPolicy(args: {
  labPolicyId: PtcLabPolicyId;
  createBrowserPolicy: () => PtcLabPolicyProjection['browser'];
}): Promise<PtcSessionDockerPolicy> {
  const captured: Array<PtcSessionDockerPolicy | undefined> = [];
  const owner = createPtcBrowserStateRuntimeOwner({
    options: {
      createSessionManager: (managerArgs) => {
        captured.push(managerArgs.policy);
        return FAKE_SESSION_MANAGER;
      },
      realpathStateRoot: async (stateRoot) => stateRoot,
      runtimeRootForState: () => '/runtime/browser-state-runtime-test',
    },
    labPolicyId: args.labPolicyId,
    createBrowserPolicy: args.createBrowserPolicy,
    stateRuntimeUnavailable: (diagnostics) => ({
      ok: false as const,
      diagnostics,
    }),
    cleanupFailureReasonCode: 'browser_state_runtime_test_cleanup_failed',
    cleanupFailureMessage: 'browser state runtime test cleanup failed',
  });

  const runtime = await owner.getStateRuntime(
    '/state/browser-state-runtime-test',
  );
  assert.equal(runtime.ok, true);
  assert.equal(captured.length, 1);
  const policy = captured[0];
  assert.notEqual(policy, undefined);
  if (policy === undefined) {
    throw new Error('expected a captured session docker policy');
  }
  return policy;
}

void test('non-live browser lanes keep the untouched default image and budget', async () => {
  const policy = await captureLaneDockerPolicy({
    labPolicyId: 'ptc_lab_browser_state_runtime_evidence_test_v1',
    createBrowserPolicy: () =>
      createPtcLabBrowserPageLoadEvidencePolicy({ maxNavigationMs: 1200 }),
  });

  assert.equal(policy.imageRef, PTC_SESSION_DOCKER_DEFAULT_POLICY.imageRef);
  assert.equal(policy.cpus, PTC_SESSION_DOCKER_DEFAULT_POLICY.cpus);
  assert.equal(policy.memory, PTC_SESSION_DOCKER_DEFAULT_POLICY.memory);
  assert.equal(policy.pidsLimit, PTC_SESSION_DOCKER_DEFAULT_POLICY.pidsLimit);
});

void test('text evidence lane keeps base image with warm CDP browser budget', async () => {
  const policy = await captureLaneDockerPolicy({
    labPolicyId: 'ptc_lab_browser_state_runtime_text_evidence_test_v1',
    createBrowserPolicy: createPtcLabBrowserTextEvidencePolicy,
  });

  assert.equal(policy.imageRef, PTC_SESSION_DOCKER_DEFAULT_POLICY.imageRef);
  assert.equal(policy.cpus, '2');
  assert.equal(policy.memory, '1g');
  assert.equal(policy.pidsLimit, '512');
  assert.equal(
    policy.scratchTmpfs,
    '/geulbat/scratch:rw,noexec,nosuid,nodev,size=512m',
  );
  assert.equal(policy.tmpTmpfs, '/tmp:rw,nosuid,nodev,size=512m');
});

void test('default session docker policy pins the untouched base image', () => {
  assert.equal(
    PTC_SESSION_DOCKER_DEFAULT_POLICY.imageRef,
    'local/geulbat-ptc-session:2026-05-31',
  );
  assert.equal(PTC_SESSION_DOCKER_DEFAULT_POLICY.cpus, '1');
  assert.equal(PTC_SESSION_DOCKER_DEFAULT_POLICY.memory, '512m');
  assert.equal(PTC_SESSION_DOCKER_DEFAULT_POLICY.pidsLimit, '128');
});
