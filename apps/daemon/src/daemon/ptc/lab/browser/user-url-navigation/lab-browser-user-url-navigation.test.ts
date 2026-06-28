import assert from 'node:assert/strict';
import {
  PTC_LAB_BROWSER_DOWNLOADS_DISABLED_POLICY_ID,
  PTC_LAB_BROWSER_NAVIGATION_SUMMARY_ONLY_POLICY_ID,
  PTC_LAB_BROWSER_PERMISSIONS_DENIED_POLICY_ID,
  PTC_LAB_BROWSER_POPUPS_DISABLED_POLICY_ID,
  PTC_LAB_BROWSER_PROFILE_FRESH_PER_ATTEMPT_POLICY_ID,
  PTC_LAB_BROWSER_REDIRECT_REVALIDATED_POLICY_ID,
  PTC_LAB_BROWSER_RUNTIME_ENGINE_CHROMIUM_POLICY_ID,
  PTC_LAB_BROWSER_URL_ECHO_DIGEST_ONLY_POLICY_ID,
  PTC_LAB_BROWSER_USER_URL_NAVIGATION_POLICY_ID,
} from '../core/lab-browser-policy-ids.js';
import { access } from 'node:fs/promises';
import test from 'node:test';
import {
  createPtcLabBrowserDisabledPolicy,
  createPtcLabBrowserPageLoadEvidencePolicy,
  createPtcLabBrowserTextEvidencePolicy,
} from '../core/lab-browser-policy.js';
import {
  PTC_LAB_BROWSER_USER_URL_NAVIGATION_CAPABILITY,
  normalizePtcLabBrowserUserUrlNavigationTarget,
} from '../core/lab-browser-url-navigation.js';
import { runPtcLabBrowserUserUrlNavigation } from './lab-browser-user-url-navigation.js';
import { buildPtcLabBrowserUserUrlNavigationExecutionIdentity } from './lab-browser-user-url-navigation-contract.js';
import { PTC_LAB_BROWSER_USER_URL_NAVIGATION_RUNTIME_SCRIPT } from '../core/lab-browser-runtime-script.js';
import {
  readBrowserUserUrlNavigationPolicy,
  validateBrowserUserUrlNavigationRequest,
} from './lab-browser-user-url-navigation-policy.js';
import {
  PTC_LAB_OPEN_EGRESS_LOCAL_POLICY_ID,
  createPtcLabOpenEgressLocalPolicy,
} from '../../network/lab-network-policy.js';
import { admitPtcExecutionProfile } from '../../profile/lab-profile.js';
import type { PtcSessionDockerPolicy } from '../../session/session-docker-contract.js';
import {
  browserUserUrlNavigationRequest,
  createBrowserUserUrlNavigationLab,
  PTC_BROWSER_USER_URL_NAVIGATION_TEST_IDENTITY,
  PTC_BROWSER_USER_URL_NAVIGATION_TEST_SUCCESS_CHECKS,
  withBrowserUserUrlNavigationSessionManager,
} from '../../../../../test-support/ptc-browser-user-url-navigation.js';
import {
  PTC_BROWSER_RUNTIME_SCRIPT_FAKE_PLAYWRIGHT_MODULE,
  runPtcBrowserRuntimeScript,
} from '../../../../../test-support/ptc-browser-runtime-script.js';
import {
  collectPtcStaticImportGraph,
  ptcSourceUrl,
  readPtcStaticImportSpecifiers,
} from '../../../../../test-support/ptc-static-import-graph.js';

void test('user URL navigation runtime script emits a data envelope without leaking the URL', async () => {
  const run = await runPtcBrowserRuntimeScript({
    script: PTC_LAB_BROWSER_USER_URL_NAVIGATION_RUNTIME_SCRIPT,
    input: {
      targetUrl:
        'https://example.com/private?access_token=secret#id_token=secret',
      timeoutMs: 1_000,
      loadWaitState: 'domcontentloaded',
    },
    playwrightModuleSource: PTC_BROWSER_RUNTIME_SCRIPT_FAKE_PLAYWRIGHT_MODULE,
  });

  assert.equal(run.exitCode, 0);
  assert.equal(run.stderr, '');
  assert.deepEqual(run.jsonLines, [
    {
      capability: PTC_LAB_BROWSER_USER_URL_NAVIGATION_CAPABILITY,
      checks: {
        engineAvailable: true,
        contextCreated: true,
        navigationStarted: true,
        navigationSettled: true,
        redirectPolicyEnforced: true,
        downloadPolicyEnforced: true,
        cleanupCompleted: true,
      },
      ok: true,
    },
  ]);
  assert.doesNotMatch(
    JSON.stringify(run.jsonLines),
    /example\.com|access_token|id_token|secret/u,
  );
});

void test('user URL navigation contract does not import the runtime script owner', async () => {
  const sourceUrl = ptcSourceUrl(
    'lab/browser/user-url-navigation/lab-browser-user-url-navigation-contract.ts',
  );
  const graph = await collectPtcStaticImportGraph(sourceUrl);

  assert.equal(
    readPtcStaticImportSpecifiers(graph, sourceUrl).includes(
      '../core/lab-browser-runtime-script.js',
    ),
    false,
  );
});

void test('readBrowserUserUrlNavigationPolicy rejects missing, wrong, and incompatible policy identities', () => {
  const missingAdmission = readBrowserUserUrlNavigationPolicy(undefined);
  assert.ok(!missingAdmission.ok);
  assert.equal(
    missingAdmission.reasonCode,
    'ptc_lab_browser_admission_required',
  );

  const disabledNetwork = readBrowserUserUrlNavigationPolicy(
    createBrowserUserUrlNavigationLab({ networkMode: 'disabled' }).admission,
  );
  assert.ok(!disabledNetwork.ok);
  assert.equal(disabledNetwork.reasonCode, 'ptc_lab_browser_network_disabled');

  const { labPolicy } = createBrowserUserUrlNavigationLab();
  const wrongBrowserAdmission = admitPtcExecutionProfile({
    requestedProfile: 'lab',
    labEnabled: true,
    reason: 'explicit_user_request',
    labPolicy: {
      ...labPolicy,
      browser: createPtcLabBrowserPageLoadEvidencePolicy({
        maxNavigationMs: 5000,
      }),
    },
  });
  assert.ok(wrongBrowserAdmission.ok);
  const wrongBrowser = readBrowserUserUrlNavigationPolicy(
    wrongBrowserAdmission.value,
  );
  assert.ok(!wrongBrowser.ok);
  assert.equal(wrongBrowser.reasonCode, 'ptc_lab_browser_policy_mismatch');

  const runtimeObservedAdmission = admitPtcExecutionProfile({
    requestedProfile: 'lab',
    labEnabled: true,
    reason: 'explicit_user_request',
    labPolicy: {
      ...labPolicy,
      network: createPtcLabOpenEgressLocalPolicy({
        metricsCoverage: 'runtime_observed',
      }),
    },
  });
  assert.ok(runtimeObservedAdmission.ok);
  const incompatibleNetwork = readBrowserUserUrlNavigationPolicy(
    runtimeObservedAdmission.value,
  );
  assert.ok(!incompatibleNetwork.ok);
  assert.equal(
    incompatibleNetwork.reasonCode,
    'ptc_lab_browser_policy_mismatch',
  );
});

void test('validateBrowserUserUrlNavigationRequest rejects malformed request and invalid timeout', () => {
  const nonObjectRequest = validateBrowserUserUrlNavigationRequest({
    request: 'https://example.com',
    maxTimeoutMs: 10_000,
  });
  assert.ok(!nonObjectRequest.ok);
  assert.equal(
    nonObjectRequest.reasonCode,
    'ptc_lab_browser_url_admission_failed',
  );

  const fractionalTimeout = validateBrowserUserUrlNavigationRequest({
    request: browserUserUrlNavigationRequest({ timeoutMs: 1.5 }),
    maxTimeoutMs: 1000,
  });
  assert.ok(!fractionalTimeout.ok);
  assert.equal(fractionalTimeout.reasonCode, 'ptc_lab_browser_request_invalid');
});

void test('runPtcLabBrowserUserUrlNavigation rejects invalid admission before session acquisition', async () => {
  const { admission } = createBrowserUserUrlNavigationLab();
  const cases = [
    {
      name: 'invalid timeout',
      request: browserUserUrlNavigationRequest({ timeoutMs: 0 }),
      reasonCode: 'ptc_lab_browser_request_invalid',
    },
    {
      name: 'malformed URL',
      request: browserUserUrlNavigationRequest({ url: 'example.com' }),
      reasonCode: 'ptc_lab_browser_url_admission_failed',
    },
    {
      name: 'later owner field',
      request: {
        ...browserUserUrlNavigationRequest(),
        screenshot: true,
      },
      reasonCode: 'ptc_lab_browser_url_admission_failed',
    },
  ];

  for (const item of cases) {
    await withBrowserUserUrlNavigationSessionManager(
      {},
      async ({ manager, runner, invocations }) => {
        const result = await runPtcLabBrowserUserUrlNavigation({
          admission,
          identity: PTC_BROWSER_USER_URL_NAVIGATION_TEST_IDENTITY,
          sessionManager: manager,
          request: item.request,
          commandRunner: runner,
        });

        assert.equal(result.ok, false, item.name);
        assert.equal(result.ok ? '' : result.reasonCode, item.reasonCode);
        assert.deepEqual(invocations, []);
        assert.doesNotMatch(
          JSON.stringify(result),
          /example\.com|access_token|id_token|secret/u,
        );
      },
    );
  }
});

void test('runPtcLabBrowserUserUrlNavigation executes normalized target without public URL/session leaks', async () => {
  const { admission, dockerPolicy } = createBrowserUserUrlNavigationLab({
    browserMaxActionMs: 1200,
  });
  let inputHostPath = '';

  await withBrowserUserUrlNavigationSessionManager(
    {
      policy: dockerPolicy,
      onExec: ({ invocation, input, inputHostPath: nextInputHostPath }) => {
        inputHostPath = nextInputHostPath;
        assert.equal(
          input.targetUrl,
          'https://example.com/private?access_token=secret#id_token=secret',
        );
        assert.equal(input.timeoutMs, 1000);
        assert.equal(input.loadWaitState, 'domcontentloaded');
        assert.deepEqual(invocation.outputBufferPolicy, {
          maxBufferedBytesPerStream:
            admission.labPolicy?.shell.maxBufferedBytesPerStream,
        });
        assert.equal(
          invocation.args.some((arg) =>
            /https?:\/\/|example\.com|access_token|id_token|secret/u.test(arg),
          ),
          false,
        );
      },
    },
    async ({ manager, runner, invocations, runtimeRoot }) => {
      const result = await runPtcLabBrowserUserUrlNavigation({
        admission,
        identity: PTC_BROWSER_USER_URL_NAVIGATION_TEST_IDENTITY,
        sessionManager: manager,
        request: browserUserUrlNavigationRequest({ timeoutMs: 1000 }),
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
      assert.equal(
        result.ok ? result.value.kind : '',
        'ptc_lab_browser_user_url_navigation_result',
      );
      assert.equal(result.ok ? result.value.durationMs : 0, 23);
      assert.equal(
        result.ok ? result.value.browserPolicyId : '',
        PTC_LAB_BROWSER_USER_URL_NAVIGATION_POLICY_ID,
      );
      assert.equal(
        result.ok ? result.value.browserEnginePolicyId : '',
        PTC_LAB_BROWSER_RUNTIME_ENGINE_CHROMIUM_POLICY_ID,
      );
      assert.equal(
        result.ok ? result.value.browserNetworkPolicyId : '',
        PTC_LAB_OPEN_EGRESS_LOCAL_POLICY_ID,
      );
      assert.equal(
        result.ok ? result.value.browserRedirectPolicyId : '',
        PTC_LAB_BROWSER_REDIRECT_REVALIDATED_POLICY_ID,
      );
      assert.equal(
        result.ok ? result.value.browserEvidencePolicyId : '',
        PTC_LAB_BROWSER_NAVIGATION_SUMMARY_ONLY_POLICY_ID,
      );
      assert.equal(
        result.ok ? result.value.browserUrlEchoPolicyId : '',
        PTC_LAB_BROWSER_URL_ECHO_DIGEST_ONLY_POLICY_ID,
      );
      assert.equal(
        result.ok ? result.value.browserPopupPolicyId : '',
        PTC_LAB_BROWSER_POPUPS_DISABLED_POLICY_ID,
      );
      assert.equal(
        result.ok ? result.value.browserPermissionPolicyId : '',
        PTC_LAB_BROWSER_PERMISSIONS_DENIED_POLICY_ID,
      );
      assert.equal(
        result.ok ? result.value.browserProfilePolicyId : '',
        PTC_LAB_BROWSER_PROFILE_FRESH_PER_ATTEMPT_POLICY_ID,
      );
      assert.equal(
        result.ok ? result.value.browserDownloadPolicyId : '',
        PTC_LAB_BROWSER_DOWNLOADS_DISABLED_POLICY_ID,
      );
      assert.equal(result.ok ? result.value.requestedUrlRedacted : false, true);
      assert.equal(result.ok ? result.value.finalUrlRedacted : false, true);
      assert.equal(
        Object.hasOwn(result.ok ? result.value : {}, 'requestedUrlEcho'),
        false,
      );
      assert.equal(
        Object.hasOwn(result.ok ? result.value : {}, 'labSessionId'),
        false,
      );
      assert.equal(
        Object.hasOwn(result.ok ? result.value : {}, 'containerId'),
        false,
      );
      assert.deepEqual(result.ok ? result.value.checks : undefined, {
        targetVerified: true,
        ...PTC_BROWSER_USER_URL_NAVIGATION_TEST_SUCCESS_CHECKS,
      });

      const createInvocation = invocations.find(
        (invocation) => invocation.args[0] === 'create',
      );
      assert.ok(createInvocation);
      assert.equal(
        createInvocation.args.includes(
          `geulbat.browserPolicyId=${PTC_LAB_BROWSER_USER_URL_NAVIGATION_POLICY_ID}`,
        ),
        true,
      );
      assert.equal(
        createInvocation.args.includes(
          `geulbat.browserEnginePolicyId=${PTC_LAB_BROWSER_RUNTIME_ENGINE_CHROMIUM_POLICY_ID}`,
        ),
        true,
      );
      assert.equal(
        createInvocation.args.includes(
          `geulbat.browserUrlEchoPolicyId=${PTC_LAB_BROWSER_URL_ECHO_DIGEST_ONLY_POLICY_ID}`,
        ),
        true,
      );
      assert.equal(
        createInvocation.args.some((arg) =>
          /https?:\/\/|example\.com|access_token|id_token|secret/u.test(arg),
        ),
        false,
      );
      await assert.rejects(() => access(inputHostPath));

      const serialized = JSON.stringify(result);
      assert.match(
        result.ok ? result.value.targetDigest : '',
        /^sha256:[0-9a-f]{64}$/u,
      );
      assert.match(
        result.ok ? result.value.navigationAttemptDigest : '',
        /^sha256:[0-9a-f]{64}$/u,
      );
      assert.doesNotMatch(
        serialized,
        /https?:\/\/|example\.com|access_token|id_token|secret|statusCode|responseHeaders|<html|browserConsole|downloadPath|downloadUrl|screenshot/iu,
      );
      assert.equal(serialized.includes(runtimeRoot), false);
    },
  );
});

void test('user URL navigation attempt digest changes with runtime policy while target digest does not', () => {
  const { labPolicy } = createBrowserUserUrlNavigationLab();
  if (
    !labPolicy.browser.enabled ||
    labPolicy.browser.mode !== 'user_url_navigation'
  ) {
    throw new Error('expected user URL browser policy');
  }
  const target = normalizePtcLabBrowserUserUrlNavigationTarget(
    browserUserUrlNavigationRequest(),
  );
  assert.equal(target.ok, true);

  const first = buildPtcLabBrowserUserUrlNavigationExecutionIdentity({
    browser: labPolicy.browser,
    effectiveTimeoutMs: 1000,
    targetDigest: target.value.targetDigest,
  });
  const second = buildPtcLabBrowserUserUrlNavigationExecutionIdentity({
    browser: labPolicy.browser,
    effectiveTimeoutMs: 2000,
    targetDigest: target.value.targetDigest,
  });

  assert.equal(first.targetDigest, second.targetDigest);
  assert.notEqual(
    first.navigationAttemptDigest,
    second.navigationAttemptDigest,
  );
});

void test('runPtcLabBrowserUserUrlNavigation rejects non-navigation and package-only sessions before browser exec', async () => {
  const { admission, dockerPolicy } = createBrowserUserUrlNavigationLab();
  const policies: PtcSessionDockerPolicy[] = [
    {
      ...dockerPolicy,
      browser: createPtcLabBrowserPageLoadEvidencePolicy({
        maxNavigationMs: 5000,
      }),
    },
    {
      ...dockerPolicy,
      browser: createPtcLabBrowserTextEvidencePolicy({
        maxNavigationMs: 5000,
      }),
    },
    {
      ...dockerPolicy,
      packageManagerFamilies: ['npm'],
      networkInstallPolicyId: PTC_LAB_OPEN_EGRESS_LOCAL_POLICY_ID,
      browser: createPtcLabBrowserDisabledPolicy(),
    },
  ];

  for (const policy of policies) {
    await withBrowserUserUrlNavigationSessionManager(
      { policy },
      async ({ manager, runner, invocations }) => {
        const result = await runPtcLabBrowserUserUrlNavigation({
          admission,
          identity: PTC_BROWSER_USER_URL_NAVIGATION_TEST_IDENTITY,
          sessionManager: manager,
          request: browserUserUrlNavigationRequest(),
          commandRunner: runner,
        });

        assert.equal(result.ok, false);
        assert.equal(
          result.ok ? '' : result.reasonCode,
          'ptc_lab_browser_policy_mismatch',
        );
        assert.equal(
          invocations.some((invocation) => invocation.args[0] === 'exec'),
          false,
        );
      },
    );
  }
});
