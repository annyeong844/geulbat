import assert from 'node:assert/strict';
import test from 'node:test';
import {
  PTC_LAB_BROWSER_FIXED_RUNTIME_PROBE_POLICY_ID,
  PTC_LAB_BROWSER_RUNTIME_ENGINE_CHROMIUM_POLICY_ID,
  PTC_LAB_BROWSER_TELEMETRY_OWNER_OUTCOME_POLICY_ID,
} from './lab-browser-policy.js';
import { runPtcLabBrowserFixedRuntimeProbe } from './lab-browser-runtime.js';
import {
  PTC_LAB_BROWSER_FIXED_RUNTIME_PROBE_SCRIPT,
  PTC_LAB_BROWSER_RUNTIME_CONTROLLED_READY_MARKER,
} from './lab-browser-runtime-contract.js';
import { PTC_LAB_OPEN_EGRESS_LOCAL_POLICY_ID } from './lab-network-policy.js';
import {
  browserRuntimeRequest,
  createBrowserRuntimeLab,
  createDisabledBrowserAdmission,
  PTC_BROWSER_RUNTIME_TEST_IDENTITY,
  PTC_BROWSER_RUNTIME_TEST_SUCCESS_CHECKS,
  withBrowserRuntimeSessionManager,
} from '../../test-support/ptc-browser-runtime.js';

void test('fixed runtime probe script stays daemon-authored and URL-free', () => {
  assert.match(
    PTC_LAB_BROWSER_FIXED_RUNTIME_PROBE_SCRIPT,
    new RegExp(PTC_LAB_BROWSER_RUNTIME_CONTROLLED_READY_MARKER, 'u'),
  );
  assert.match(PTC_LAB_BROWSER_FIXED_RUNTIME_PROBE_SCRIPT, /setContent/u);
  assert.match(
    PTC_LAB_BROWSER_FIXED_RUNTIME_PROBE_SCRIPT,
    /require\('playwright'\)/u,
  );
  assert.doesNotMatch(
    PTC_LAB_BROWSER_FIXED_RUNTIME_PROBE_SCRIPT,
    /npm install|pip install|playwright install|https?:\/\/|userDataDir|storageState|cookieJar|cookies:/iu,
  );
});

void test('runPtcLabBrowserFixedRuntimeProbe rejects disabled browser or network policy before session acquisition', async () => {
  const disabledNetwork = createBrowserRuntimeLab({ networkMode: 'disabled' });
  const cases = [
    {
      name: 'disabled browser',
      admission: createDisabledBrowserAdmission(),
    },
    {
      name: 'disabled network',
      admission: disabledNetwork.admission,
    },
  ];

  for (const item of cases) {
    await withBrowserRuntimeSessionManager(
      {},
      async ({ manager, runner, invocations }) => {
        const result = await runPtcLabBrowserFixedRuntimeProbe({
          admission: item.admission,
          identity: PTC_BROWSER_RUNTIME_TEST_IDENTITY,
          sessionManager: manager,
          request: browserRuntimeRequest(),
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

void test('runPtcLabBrowserFixedRuntimeProbe rejects URL-shaped requests before session acquisition', async () => {
  const { admission } = createBrowserRuntimeLab();
  const urlRequest = {
    probeId: 'browser-runtime-probe-1',
    url: 'https://example.com/private',
    selector: '#secret',
  };

  await withBrowserRuntimeSessionManager(
    {},
    async ({ manager, runner, invocations }) => {
      const result = await runPtcLabBrowserFixedRuntimeProbe({
        admission,
        identity: PTC_BROWSER_RUNTIME_TEST_IDENTITY,
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

void test('runPtcLabBrowserFixedRuntimeProbe runs a bounded fixed probe through the real session manager', async () => {
  const { admission, dockerPolicy } = createBrowserRuntimeLab({
    browserMaxActionMs: 1200,
  });

  await withBrowserRuntimeSessionManager(
    { policy: dockerPolicy },
    async ({ manager, runner, invocations, runtimeRoot }) => {
      const result = await runPtcLabBrowserFixedRuntimeProbe({
        admission,
        identity: PTC_BROWSER_RUNTIME_TEST_IDENTITY,
        sessionManager: manager,
        request: browserRuntimeRequest({ timeoutMs: 1000 }),
        now: (() => {
          let value = 300;
          return () => {
            value += 19;
            return value;
          };
        })(),
        commandRunner: runner,
      });

      assert.equal(result.ok, true);
      assert.equal(result.ok ? result.value.durationMs : 0, 19);
      assert.equal(
        result.ok ? result.value.browserPolicyId : '',
        PTC_LAB_BROWSER_FIXED_RUNTIME_PROBE_POLICY_ID,
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
        result.ok ? result.value.browserTelemetryPolicyId : '',
        PTC_LAB_BROWSER_TELEMETRY_OWNER_OUTCOME_POLICY_ID,
      );
      assert.equal(
        result.ok ? result.value.browserOutputPolicy : '',
        'summary_only',
      );
      assert.equal(result.ok ? result.value.browserProfile : '', 'none');
      assert.equal(result.ok ? result.value.browserCookies : '', 'none');
      assert.equal(result.ok ? result.value.artifactExported : true, false);
      assert.deepEqual(
        result.ok ? result.value.checks : undefined,
        PTC_BROWSER_RUNTIME_TEST_SUCCESS_CHECKS,
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
          `geulbat.browserPolicyId=${PTC_LAB_BROWSER_FIXED_RUNTIME_PROBE_POLICY_ID}`,
        ),
        true,
      );
      assert.equal(
        createInvocation.args.includes(
          `geulbat.browserRuntimeEnginePolicyId=${PTC_LAB_BROWSER_RUNTIME_ENGINE_CHROMIUM_POLICY_ID}`,
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
        /Bearer|oauth|cookie=|refresh[_-]?token|console|<html/iu,
      );
      assert.equal(serialized.includes(runtimeRoot), false);
      assert.equal(
        Object.hasOwn(result.ok ? result.value : {}, 'artifactCandidate'),
        false,
      );
    },
  );
});
