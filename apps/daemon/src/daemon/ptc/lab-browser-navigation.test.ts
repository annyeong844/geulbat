import assert from 'node:assert/strict';
import test from 'node:test';
import {
  PTC_LAB_BROWSER_FIXED_NAVIGATION_PROBE_POLICY_ID,
  PTC_LAB_BROWSER_NAVIGATION_SUMMARY_ONLY_POLICY_ID,
  PTC_LAB_BROWSER_NAVIGATION_TARGET_FIXED_HTTPS_POLICY_ID,
  PTC_LAB_BROWSER_REDIRECT_DISABLED_POLICY_ID,
  PTC_LAB_BROWSER_RUNTIME_ENGINE_CHROMIUM_POLICY_ID,
  PTC_LAB_BROWSER_TELEMETRY_OWNER_OUTCOME_POLICY_ID,
  PTC_LAB_BROWSER_URL_GRAMMAR_POLICY_OWNED_TARGET_REF_POLICY_ID,
} from './lab-browser-policy.js';
import { runPtcLabBrowserFixedNavigationProbe } from './lab-browser-navigation.js';
import {
  PTC_LAB_BROWSER_FIXED_NAVIGATION_PROBE_SCRIPT,
  PTC_LAB_BROWSER_FIXED_NAVIGATION_TARGET,
  PTC_LAB_BROWSER_FIXED_NAVIGATION_TARGET_DIGEST,
  PTC_LAB_BROWSER_FIXED_NAVIGATION_TARGET_REF,
} from './lab-browser-navigation-contract.js';
import { PTC_LAB_OPEN_EGRESS_LOCAL_POLICY_ID } from './lab-network-policy.js';
import {
  browserNavigationRequest,
  createBrowserNavigationLab,
  createDisabledBrowserNavigationAdmission,
  PTC_BROWSER_NAVIGATION_TEST_IDENTITY,
  PTC_BROWSER_NAVIGATION_TEST_SUCCESS_CHECKS,
  withBrowserNavigationSessionManager,
} from '../../test-support/ptc-browser-navigation.js';

void test('fixed navigation probe script stays daemon-authored without install/profile inputs', () => {
  assert.match(PTC_LAB_BROWSER_FIXED_NAVIGATION_PROBE_SCRIPT, /page\.goto/u);
  assert.match(
    PTC_LAB_BROWSER_FIXED_NAVIGATION_PROBE_SCRIPT,
    /require\('playwright'\)/u,
  );
  assert.match(
    PTC_LAB_BROWSER_FIXED_NAVIGATION_PROBE_SCRIPT,
    new RegExp(PTC_LAB_BROWSER_FIXED_NAVIGATION_TARGET.url, 'u'),
  );
  assert.doesNotMatch(
    PTC_LAB_BROWSER_FIXED_NAVIGATION_PROBE_SCRIPT,
    /npm install|pip install|playwright install|userDataDir|storageState|cookieJar|cookies:/iu,
  );
});

void test('runPtcLabBrowserFixedNavigationProbe rejects disabled browser or network policy before session acquisition', async () => {
  const disabledNetwork = createBrowserNavigationLab({
    networkMode: 'disabled',
  });
  const cases = [
    {
      name: 'disabled browser',
      admission: createDisabledBrowserNavigationAdmission(),
    },
    {
      name: 'disabled network',
      admission: disabledNetwork.admission,
    },
  ];

  for (const item of cases) {
    await withBrowserNavigationSessionManager(
      {},
      async ({ manager, runner, invocations }) => {
        const result = await runPtcLabBrowserFixedNavigationProbe({
          admission: item.admission,
          identity: PTC_BROWSER_NAVIGATION_TEST_IDENTITY,
          sessionManager: manager,
          request: browserNavigationRequest(),
          commandRunner: runner,
        });

        assert.equal(result.ok, false, item.name);
        assert.equal(
          result.ok ? '' : result.reasonCode,
          'ptc_lab_browser_policy_disabled',
        );
        assert.deepEqual(invocations, []);
      },
    );
  }
});

void test('runPtcLabBrowserFixedNavigationProbe rejects URL-shaped requests before session acquisition', async () => {
  const { admission } = createBrowserNavigationLab();
  const urlRequest = {
    probeId: 'browser-navigation-probe-1',
    targetRef: PTC_LAB_BROWSER_FIXED_NAVIGATION_TARGET_REF,
    url: 'https://example.com/private',
    finalUrl: 'https://example.com/redirect',
    headers: { authorization: 'Bearer secret' },
  };

  await withBrowserNavigationSessionManager(
    {},
    async ({ manager, runner, invocations }) => {
      const result = await runPtcLabBrowserFixedNavigationProbe({
        admission,
        identity: PTC_BROWSER_NAVIGATION_TEST_IDENTITY,
        sessionManager: manager,
        request: urlRequest,
        commandRunner: runner,
      });

      assert.equal(result.ok, false);
      assert.equal(
        result.ok ? '' : result.reasonCode,
        'ptc_lab_browser_request_invalid',
      );
      assert.deepEqual(invocations, []);
    },
  );
});

void test('runPtcLabBrowserFixedNavigationProbe runs a bounded fixed navigation through the real session manager', async () => {
  const { admission, dockerPolicy } = createBrowserNavigationLab({
    browserMaxActionMs: 1200,
  });

  await withBrowserNavigationSessionManager(
    { policy: dockerPolicy },
    async ({ manager, runner, invocations, runtimeRoot }) => {
      const result = await runPtcLabBrowserFixedNavigationProbe({
        admission,
        identity: PTC_BROWSER_NAVIGATION_TEST_IDENTITY,
        sessionManager: manager,
        request: browserNavigationRequest({ timeoutMs: 1000 }),
        now: (() => {
          let value = 300;
          return () => {
            value += 23;
            return value;
          };
        })(),
        commandRunner: runner,
      });

      assert.equal(result.ok, true);
      assert.equal(result.ok ? result.value.durationMs : 0, 23);
      assert.equal(
        result.ok ? result.value.browserPolicyId : '',
        PTC_LAB_BROWSER_FIXED_NAVIGATION_PROBE_POLICY_ID,
      );
      assert.equal(
        result.ok ? result.value.browserRuntimeEnginePolicyId : '',
        PTC_LAB_BROWSER_RUNTIME_ENGINE_CHROMIUM_POLICY_ID,
      );
      assert.equal(
        result.ok ? result.value.browserNetworkPolicyId : '',
        PTC_LAB_OPEN_EGRESS_LOCAL_POLICY_ID,
      );
      assert.equal(
        result.ok ? result.value.browserNavigationTargetPolicyId : '',
        PTC_LAB_BROWSER_NAVIGATION_TARGET_FIXED_HTTPS_POLICY_ID,
      );
      assert.equal(
        result.ok ? result.value.browserUrlGrammarPolicyId : '',
        PTC_LAB_BROWSER_URL_GRAMMAR_POLICY_OWNED_TARGET_REF_POLICY_ID,
      );
      assert.equal(
        result.ok ? result.value.browserRedirectPolicyId : '',
        PTC_LAB_BROWSER_REDIRECT_DISABLED_POLICY_ID,
      );
      assert.equal(
        result.ok ? result.value.browserTelemetryPolicyId : '',
        PTC_LAB_BROWSER_TELEMETRY_OWNER_OUTCOME_POLICY_ID,
      );
      assert.equal(
        result.ok ? result.value.browserEvidencePolicyId : '',
        PTC_LAB_BROWSER_NAVIGATION_SUMMARY_ONLY_POLICY_ID,
      );
      assert.equal(
        result.ok ? result.value.targetDigest : '',
        PTC_LAB_BROWSER_FIXED_NAVIGATION_TARGET_DIGEST,
      );
      assert.equal(result.ok ? result.value.navigationOutcome : '', 'loaded');
      assert.deepEqual(
        result.ok ? result.value.checks : undefined,
        PTC_BROWSER_NAVIGATION_TEST_SUCCESS_CHECKS,
      );
      assert.equal(
        Object.hasOwn(result.ok ? result.value : {}, 'networkTelemetry'),
        false,
      );

      const createInvocation = invocations.find(
        (invocation) => invocation.args[0] === 'create',
      );
      assert.ok(createInvocation);
      assert.equal(
        createInvocation.args.includes(
          `geulbat.browserPolicyId=${PTC_LAB_BROWSER_FIXED_NAVIGATION_PROBE_POLICY_ID}`,
        ),
        true,
      );
      assert.equal(
        createInvocation.args.includes(
          `geulbat.browserNavigationTargetPolicyId=${PTC_LAB_BROWSER_NAVIGATION_TARGET_FIXED_HTTPS_POLICY_ID}`,
        ),
        true,
      );
      const execInvocation = invocations.find(
        (invocation) => invocation.args[0] === 'exec',
      );
      assert.ok(execInvocation);
      assert.equal(execInvocation.timeoutMs, 1000);

      const serialized = JSON.stringify(result);
      assert.doesNotMatch(serialized, /https?:\/\/|example\.com/u);
      assert.doesNotMatch(
        serialized,
        /Bearer|oauth|cookie=|refresh[_-]?token|console|<html|statusCode|headers/iu,
      );
      assert.equal(serialized.includes(runtimeRoot), false);
      assert.equal(
        Object.hasOwn(result.ok ? result.value : {}, 'artifactCandidate'),
        false,
      );
    },
  );
});
