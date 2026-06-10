import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import {
  PTC_BROWSER_NAVIGATE_LAB_POLICY_ID,
  PTC_BROWSER_NAVIGATE_TOOL_NAME,
} from '../daemon-runtime-contract.js';
import {
  PTC_LAB_BROWSER_USER_URL_NAVIGATION_RUNTIME_SCRIPT,
  type PtcLabBrowserUserUrlNavigationChecks,
} from './lab-browser-user-url-navigation-contract.js';
import { PTC_LAB_BROWSER_USER_URL_NAVIGATION_CAPABILITY } from './lab-browser-url-navigation.js';
import { PTC_LAB_BROWSER_USER_URL_NAVIGATION_POLICY_ID } from './lab-browser-policy.js';
import { PTC_LAB_OPEN_EGRESS_LOCAL_POLICY_ID } from './lab-network-policy.js';
import { PTC_SESSION_DOCKER_CALLBACK_CONTAINER_ROOT } from './session-docker-contract.js';
import {
  browserUserUrlNavigationStdout,
  type BrowserUserUrlNavigationExecInput,
} from '../../test-support/ptc-browser-user-url-navigation.js';
import {
  createPtcSessionDockerCommandFixture,
  readPtcSessionDockerBindMountHostPath,
} from '../../test-support/ptc-session-docker.js';
import { makeRunWorkspaceContext } from '../../test-support/run-workspace-context.js';
import { testProjectId } from '../../test-support/project-id.js';
import { testThreadId } from '../../test-support/thread-id.js';
import {
  createPtcBrowserNavigateLabPolicyProjection,
  createPtcBrowserNavigateRuntime,
  createPtcBrowserNavigateSessionDockerPolicy,
} from './browser-navigate-runtime.js';

void test('createPtcBrowserNavigateRuntime wires user URL browser policy without raw URL command leaks', async () => {
  const runtimeRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-browser-navigate-'),
  );
  const labPolicy = createPtcBrowserNavigateLabPolicyProjection();
  const dockerPolicy = createPtcBrowserNavigateSessionDockerPolicy(labPolicy);
  let callbackRootHostPath = '';
  let observedInput: BrowserUserUrlNavigationExecInput | undefined;

  const fixture = createPtcSessionDockerCommandFixture({
    policy: dockerPolicy,
    commandResult: async (invocation) => {
      if (invocation.args[0] === 'create') {
        callbackRootHostPath = readPtcSessionDockerBindMountHostPath(
          invocation,
          PTC_SESSION_DOCKER_CALLBACK_CONTAINER_ROOT,
        );
        assert.equal(
          invocation.args.includes(
            `geulbat.browserPolicyId=${PTC_LAB_BROWSER_USER_URL_NAVIGATION_POLICY_ID}`,
          ),
          true,
        );
        assert.equal(
          invocation.args.includes(
            `geulbat.networkPolicyId=${PTC_LAB_OPEN_EGRESS_LOCAL_POLICY_ID}`,
          ),
          true,
        );
        return undefined;
      }

      if (invocation.args[0] !== 'exec') {
        return undefined;
      }

      assert.equal(
        invocation.args.some((arg) =>
          /https?:\/\/|example\.com|access_token|id_token|secret/u.test(arg),
        ),
        false,
      );
      assert.deepEqual(invocation.args.slice(2, -1), [
        'node',
        '-e',
        PTC_LAB_BROWSER_USER_URL_NAVIGATION_RUNTIME_SCRIPT,
      ]);

      const inputContainerPath = invocation.args.at(-1);
      assert.ok(inputContainerPath);
      observedInput = JSON.parse(
        await readFile(
          join(callbackRootHostPath, basename(inputContainerPath)),
          'utf8',
        ),
      ) as BrowserUserUrlNavigationExecInput;
      return {
        kind: 'exit',
        exitCode: 0,
        stdout: browserUserUrlNavigationStdout({
          ok: true,
          checks: SUCCESS_CHECKS,
        }),
        stderr: '',
      };
    },
  });

  try {
    const runtime = createPtcBrowserNavigateRuntime({
      commandRunner: fixture.runner,
      realpathWorkspaceRoot: async () => '/real/workspace/browser-navigate',
      runtimeRootForWorkspace: () => runtimeRoot,
      now: (() => {
        let value = 100;
        return () => {
          value += 11;
          return value;
        };
      })(),
    });

    const result = await runtime.navigate({
      runContext: makeRunWorkspaceContext({
        threadId: testThreadId(940),
        projectId: testProjectId('project'),
        workspaceRoot: '/workspace/project',
      }),
      request: {
        url: 'https://example.com/private?access_token=secret#id_token=secret',
        timeoutMs: 1000,
      },
    });

    assert.equal(result.ok, true);
    assert.deepEqual(observedInput, {
      targetUrl:
        'https://example.com/private?access_token=secret#id_token=secret',
      timeoutMs: 1000,
      loadWaitState: 'domcontentloaded',
    });
    assert.equal(
      result.ok ? result.value.capability : '',
      PTC_LAB_BROWSER_USER_URL_NAVIGATION_CAPABILITY,
    );
    assert.equal(
      result.ok ? result.value.browserPolicyId : '',
      PTC_LAB_BROWSER_USER_URL_NAVIGATION_POLICY_ID,
    );
    assert.equal(result.ok ? result.value.durationMs : 0, 11);
    assert.equal(dockerPolicy.labPolicyId, PTC_BROWSER_NAVIGATE_LAB_POLICY_ID);
    assert.equal(labPolicy.policyId, PTC_BROWSER_NAVIGATE_LAB_POLICY_ID);
    assert.equal(PTC_BROWSER_NAVIGATE_TOOL_NAME, 'browser_navigate');
  } finally {
    await rm(runtimeRoot, { recursive: true, force: true });
  }
});

const SUCCESS_CHECKS: Omit<
  PtcLabBrowserUserUrlNavigationChecks,
  'targetVerified'
> = Object.freeze({
  engineAvailable: true,
  contextCreated: true,
  navigationStarted: true,
  navigationSettled: true,
  redirectPolicyEnforced: true,
  downloadPolicyEnforced: true,
  cleanupCompleted: true,
});
