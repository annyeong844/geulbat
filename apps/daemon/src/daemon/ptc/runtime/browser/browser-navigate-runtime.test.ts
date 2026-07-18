import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import {
  PTC_BROWSER_NAVIGATE_LAB_POLICY_ID,
  PTC_BROWSER_NAVIGATE_TOOL_NAME,
} from './browser-navigate-runtime-contract.js';
import type { PtcLabBrowserUserUrlNavigationChecks } from '../../lab/browser/user-url-navigation/lab-browser-user-url-navigation-contract.js';
import { PTC_LAB_BROWSER_USER_URL_NAVIGATION_RUNTIME_SCRIPT } from '../../lab/browser/core/lab-browser-runtime-script.js';
import { PTC_LAB_BROWSER_USER_URL_NAVIGATION_CAPABILITY } from '../../lab/browser/core/lab-browser-url-navigation.js';
import { PTC_LAB_BROWSER_USER_URL_NAVIGATION_POLICY_ID } from '../../lab/browser/core/lab-browser-policy-ids.js';
import { PTC_LAB_OPEN_EGRESS_LOCAL_POLICY_ID } from '../../lab/network/lab-network-policy.js';
import { PTC_SESSION_DOCKER_CALLBACK_CONTAINER_ROOT } from '../../lab/session/session-docker-contract.js';
import {
  browserUserUrlNavigationStdout,
  type BrowserUserUrlNavigationExecInput,
} from '../../../../test-support/ptc-browser-user-url-navigation.js';
import {
  PTC_TEST_SESSION_DOCKER_CONTAINER_ID,
  createPtcSessionDockerCommandFixture,
  readPtcSessionDockerBindMountHostPath,
} from '../../../../test-support/ptc-session-docker.js';
import { makeRunContext } from '../../../../test-support/run-context.js';
import { testThreadId } from '../../../../test-support/thread-id.js';
import { createPtcBrowserNavigateRuntime } from './browser-navigate-runtime.js';

void test('createPtcBrowserNavigateRuntime wires user URL browser policy without raw URL command leaks', async () => {
  const runtimeRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-browser-navigate-'),
  );
  let callbackRootHostPath = '';
  let observedInput: BrowserUserUrlNavigationExecInput | undefined;

  const fixture = createPtcSessionDockerCommandFixture({
    commandResult: async (invocation) => {
      if (invocation.args[0] === 'create') {
        callbackRootHostPath = readPtcSessionDockerBindMountHostPath(
          invocation,
          PTC_SESSION_DOCKER_CALLBACK_CONTAINER_ROOT,
        );
        assert.equal(
          invocation.args.includes(
            `geulbat.labPolicyId=${PTC_BROWSER_NAVIGATE_LAB_POLICY_ID}`,
          ),
          true,
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
        return {
          kind: 'exit',
          exitCode: 0,
          stdout: `${PTC_TEST_SESSION_DOCKER_CONTAINER_ID}\n`,
          stderr: '',
        };
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
      realpathStateRoot: async () => '/real/workspace/browser-navigate',
      runtimeRootForState: () => runtimeRoot,
      now: (() => {
        let value = 100;
        return () => {
          value += 11;
          return value;
        };
      })(),
    });

    const result = await runtime.navigate({
      runContext: makeRunContext({
        threadId: testThreadId(940),
        stateRoot: '/workspace/project',
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
    assert.equal(PTC_BROWSER_NAVIGATE_TOOL_NAME, 'browser_navigate');
  } finally {
    await rm(runtimeRoot, { recursive: true, force: true });
  }
});

void test('createPtcBrowserNavigateRuntime reports state owner closeAll cleanup failure', async () => {
  const runtimeRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-browser-navigate-close-all-'),
  );
  const fixture = createPtcSessionDockerCommandFixture({
    commandResult: async (invocation) => {
      if (invocation.args[0] === 'create') {
        return {
          kind: 'exit',
          exitCode: 0,
          stdout: `${PTC_TEST_SESSION_DOCKER_CONTAINER_ID}\n`,
          stderr: '',
        };
      }
      if (invocation.args[0] === 'exec') {
        return {
          kind: 'exit',
          exitCode: 0,
          stdout: browserUserUrlNavigationStdout({
            ok: true,
            checks: SUCCESS_CHECKS,
          }),
          stderr: '',
        };
      }
      if (invocation.args[0] === 'rm') {
        return {
          kind: 'exit',
          exitCode: 1,
          stdout: '',
          stderr: 'remove failed',
        };
      }
      return undefined;
    },
  });

  try {
    const runtime = createPtcBrowserNavigateRuntime({
      commandRunner: fixture.runner,
      realpathStateRoot: async () => '/real/workspace/browser-navigate',
      runtimeRootForState: () => runtimeRoot,
    });
    const result = await runtime.navigate({
      runContext: makeRunContext({
        threadId: testThreadId(941),
        stateRoot: '/workspace/project',
      }),
      request: {
        url: 'https://example.com/',
        timeoutMs: 1000,
      },
    });

    assert.equal(result.ok, true);
    assert.deepEqual(await runtime.closeAll(), {
      ok: false,
      reasonCode: 'ptc_browser_navigate_session_cleanup_failed',
      message: 'PTC browser navigation session cleanup failed',
      diagnostics: {
        cleanupReasonCode: 'container_remove_failed',
        stateRuntimeCount: 1,
      },
    });
    assert.deepEqual(await runtime.closeAll(), { ok: true });
    assert.equal(
      fixture.invocations.filter((invocation) => invocation.args[0] === 'rm')
        .length,
      1,
    );
  } finally {
    await rm(runtimeRoot, { recursive: true, force: true });
  }
});

void test('createPtcBrowserNavigateRuntime reports state runtime admission failures without throwing', async () => {
  const cases = [
    {
      name: 'workspace-root-realpath',
      runtime: createPtcBrowserNavigateRuntime({
        realpathStateRoot: async () => {
          throw new Error('/private-geulbat/workspace secret');
        },
        runtimeRootForState: () => '/unused/runtime/root',
      }),
      diagnostics: { stateRootRealpathFailed: true },
    },
    {
      name: 'missing-runtime-root-resolver',
      runtime: createPtcBrowserNavigateRuntime({
        realpathStateRoot: async () => '/real/workspace/browser-navigate',
      }),
      diagnostics: { runtimeRootUnavailable: true },
    },
    {
      name: 'runtime-root-resolver-throws',
      runtime: createPtcBrowserNavigateRuntime({
        realpathStateRoot: async () => '/real/workspace/browser-navigate',
        runtimeRootForState: () => {
          throw new Error('/private-geulbat/runtime secret');
        },
      }),
      diagnostics: { runtimeRootUnavailable: true },
    },
  ];

  for (const item of cases) {
    const result = await item.runtime.navigate({
      runContext: makeRunContext({
        threadId: testThreadId(942),
        stateRoot: '/workspace/project',
      }),
      request: {
        url: 'https://example.com/private?access_token=secret#id_token=secret',
        timeoutMs: 1000,
      },
    });

    assert.equal(result.ok, false, item.name);
    assert.equal(
      result.ok ? '' : result.reasonCode,
      'ptc_lab_browser_session_unavailable',
      item.name,
    );
    assert.equal(
      result.ok ? '' : result.phase,
      'session_acquisition',
      item.name,
    );
    assert.deepEqual(
      result.ok ? undefined : result.diagnostics,
      item.diagnostics,
    );
    assert.doesNotMatch(
      JSON.stringify(result),
      /private-geulbat|secret|runtime root resolver is missing/u,
      item.name,
    );
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
