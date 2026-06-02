import assert from 'node:assert/strict';
import test from 'node:test';
import {
  admitPtcExecutionProfile,
  PTC_LAB_LOCAL_DOCKER_POLICY_ID,
} from './lab-profile.js';
import {
  runPtcLabSessionLaunchContract,
  type PtcLabSessionLaunchRunner,
} from './lab-session-launch.js';

const PRIVATE_TEST_PATH = ['', 'home', 'user', '.geulbat', 'private'].join(
  '/',
);

void test('runPtcLabSessionLaunchContract calls fake runner with admitted lab policy', async () => {
  const admission = admitPtcExecutionProfile({
    requestedProfile: 'lab',
    labEnabled: true,
    reason: 'explicit_user_request',
  });
  assert.equal(admission.ok, true);

  const invocations: string[] = [];
  const runner: PtcLabSessionLaunchRunner = async (request) => {
    invocations.push(request.policy.policyId);
    return {
      ok: true,
      value: {
        labSessionId: 'lab-session-1',
        launchClass: 'fake_runner',
      },
    };
  };

  const result = await runPtcLabSessionLaunchContract({
    admission: admission.ok ? admission.value : undefined,
    runner,
  });

  assert.equal(result.ok, true);
  assert.deepEqual(invocations, [PTC_LAB_LOCAL_DOCKER_POLICY_ID]);
  assert.equal(result.ok ? result.value.profile : '', 'lab');
  assert.equal(
    result.ok ? result.value.policyId : '',
    PTC_LAB_LOCAL_DOCKER_POLICY_ID,
  );
  assert.equal(result.ok ? result.value.launchClass : '', 'fake_runner');
  assert.equal(
    result.ok ? result.value.boundaryClaim : '',
    'docker_containment',
  );
  assert.equal(result.ok ? result.value.shellMode : '', 'disabled');
  assert.equal(result.ok ? result.value.packageManagerEnabled : true, false);
  assert.equal(result.ok ? result.value.packageCacheEnabled : false, true);
  assert.equal(result.ok ? result.value.egressMode : '', 'disabled');
  assert.equal(result.ok ? result.value.workspaceWriteEnabled : true, false);
  assert.equal(
    result.ok ? result.value.artifactImportExportEnabled : true,
    false,
  );
  assert.equal(result.ok ? result.value.browserEnabled : true, false);
});

void test('runPtcLabSessionLaunchContract derives boundary metadata from policy, not runner', async () => {
  const admission = admitPtcExecutionProfile({
    requestedProfile: 'lab',
    labEnabled: true,
    reason: 'explicit_user_request',
  });
  assert.equal(admission.ok, true);

  const runner: PtcLabSessionLaunchRunner = async () => ({
    ok: true,
    value: {
      labSessionId: 'lab-session-1',
      launchClass: 'fake_runner',
      boundaryKind: 'microvm',
      boundaryClaim: 'hostile_isolation',
    } as never,
  });

  const result = await runPtcLabSessionLaunchContract({
    admission: admission.ok ? admission.value : undefined,
    runner,
  });

  assert.equal(result.ok, true);
  assert.equal(result.ok ? result.value.boundaryKind : '', 'docker');
  assert.equal(
    result.ok ? result.value.boundaryClaim : '',
    'docker_containment',
  );
});

void test('runPtcLabSessionLaunchContract rejects safe_subset admission', async () => {
  const admission = admitPtcExecutionProfile({
    requestedProfile: 'default',
    labEnabled: false,
    reason: 'default_policy',
  });
  assert.equal(admission.ok, true);

  const result = await runPtcLabSessionLaunchContract({
    admission: admission.ok ? admission.value : undefined,
    runner: async () => {
      throw new Error('runner should not be called');
    },
  });

  assert.equal(result.ok, false);
  assert.equal(
    result.ok ? '' : result.reasonCode,
    'ptc_lab_admission_required',
  );
});

void test('runPtcLabSessionLaunchContract classifies fake runner failure without leaking raw error text', async () => {
  const admission = admitPtcExecutionProfile({
    requestedProfile: 'lab',
    labEnabled: true,
    reason: 'explicit_user_request',
  });
  assert.equal(admission.ok, true);

  const result = await runPtcLabSessionLaunchContract({
    admission: admission.ok ? admission.value : undefined,
    runner: async () => {
      throw new Error(`${PRIVATE_TEST_PATH} docker detail`);
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.ok ? '' : result.reasonCode, 'ptc_lab_launch_failed');
  assert.doesNotMatch(JSON.stringify(result), /user|\.geulbat|private/u);
});

void test('runPtcLabSessionLaunchContract rejects unsafe lab session ids without leaking them', async () => {
  const admission = admitPtcExecutionProfile({
    requestedProfile: 'lab',
    labEnabled: true,
    reason: 'explicit_user_request',
  });
  assert.equal(admission.ok, true);

  const result = await runPtcLabSessionLaunchContract({
    admission: admission.ok ? admission.value : undefined,
    runner: async () => ({
      ok: true,
      value: {
        labSessionId: PRIVATE_TEST_PATH,
        launchClass: 'fake_runner',
      },
    }),
  });

  assert.equal(result.ok, false);
  assert.equal(result.ok ? '' : result.reasonCode, 'ptc_lab_launch_failed');
  assert.doesNotMatch(JSON.stringify(result), /user|\.geulbat|private/u);
});
