import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import {
  PTC_BROWSER_NAVIGATE_LAB_POLICY_ID,
  PTC_BROWSER_NAVIGATE_TOOL_NAME,
} from './browser-navigate-runtime-contract.js';
import { createPtcBrowserNavigateRuntime } from './browser-navigate-runtime.js';
import {
  PTC_BROWSER_PAGE_LOAD_EVIDENCE_LAB_POLICY_ID,
  PTC_BROWSER_PAGE_LOAD_EVIDENCE_TOOL_NAME,
} from './browser-page-load-evidence-runtime-contract.js';
import { createPtcBrowserPageLoadEvidenceRuntime } from './browser-page-load-evidence-runtime.js';
import {
  PTC_BROWSER_TEXT_EVIDENCE_LAB_POLICY_ID,
  PTC_BROWSER_TEXT_EVIDENCE_TOOL_NAME,
} from './browser-text-evidence-runtime-contract.js';
import { createPtcBrowserTextEvidenceRuntime } from './browser-text-evidence-runtime.js';
import {
  PTC_LAB_BROWSER_PAGE_LOAD_EVIDENCE_RUNTIME_SCRIPT,
  PTC_LAB_BROWSER_TEXT_EVIDENCE_RUNTIME_SCRIPT,
  PTC_LAB_BROWSER_USER_URL_NAVIGATION_RUNTIME_SCRIPT,
} from '../../lab/browser/core/lab-browser-runtime-script.js';
import {
  PTC_LAB_BROWSER_DOM_TEXT_EVIDENCE_POLICY_ID,
  PTC_LAB_BROWSER_PAGE_LOAD_EVIDENCE_POLICY_ID,
  PTC_LAB_BROWSER_USER_URL_NAVIGATION_POLICY_ID,
} from '../../lab/browser/core/lab-browser-policy-ids.js';
import { PTC_LAB_BROWSER_USER_URL_NAVIGATION_CAPABILITY } from '../../lab/browser/core/lab-browser-url-navigation.js';
import { PTC_LAB_BROWSER_PAGE_LOAD_EVIDENCE_CAPABILITY } from '../../lab/browser/page-load-evidence/lab-browser-page-load-evidence-contract.js';
import { PTC_LAB_BROWSER_TEXT_EVIDENCE_CAPABILITY } from '../../lab/browser/text-evidence/lab-browser-text-evidence-contract.js';
import { PTC_LAB_OPEN_EGRESS_LOCAL_POLICY_ID } from '../../lab/network/lab-network-policy.js';
import { PTC_SESSION_DOCKER_CALLBACK_CONTAINER_ROOT } from '../../lab/session/session-docker-contract.js';
import {
  PTC_BROWSER_PAGE_LOAD_EVIDENCE_TEST_SUCCESS_CHECKS,
  browserPageLoadEvidenceStdout,
} from '../../../../test-support/ptc-browser-page-load-evidence.js';
import {
  PTC_BROWSER_TEXT_EVIDENCE_TEST_SUCCESS_CHECKS,
  browserTextEvidenceStdout,
} from '../../../../test-support/ptc-browser-text-evidence.js';
import {
  PTC_BROWSER_USER_URL_NAVIGATION_TEST_SUCCESS_CHECKS,
  browserUserUrlNavigationStdout,
} from '../../../../test-support/ptc-browser-user-url-navigation.js';
import {
  PTC_TEST_SESSION_DOCKER_CONTAINER_ID,
  createPtcSessionDockerCommandFixture,
  readPtcSessionDockerBindMountHostPath,
} from '../../../../test-support/ptc-session-docker.js';
import { makeRunWorkspaceContext } from '../../../../test-support/run-workspace-context.js';
import { testProjectId } from '../../../../test-support/project-id.js';
import { testThreadId } from '../../../../test-support/thread-id.js';
import type {
  PtcSessionDockerCommandInvocation,
  PtcSessionDockerCommandResult,
} from '../../lab/session/session-docker-contract.js';

const TARGET_URL =
  'https://example.test/private/path?token=e2e-secret-token&api_key=e2e-api-key';
const TARGET_SECRET_PATTERN = /example\.test|e2e-secret-token|e2e-api-key/u;
const TEST_PROCESS_UID = 1000;
const TEST_PROCESS_GID = 1000;

const restoreTestProcessUserIds = installTestProcessUserIds();
test.after(() => {
  restoreTestProcessUserIds();
});

interface BrowserRuntimeExecInput {
  targetUrl: string;
  timeoutMs: number;
  loadWaitState: 'domcontentloaded';
}

function installTestProcessUserIds(): () => void {
  const originalGetUid = Object.getOwnPropertyDescriptor(process, 'getuid');
  const originalGetGid = Object.getOwnPropertyDescriptor(process, 'getgid');
  Object.defineProperty(process, 'getuid', {
    configurable: true,
    value: () => TEST_PROCESS_UID,
  });
  Object.defineProperty(process, 'getgid', {
    configurable: true,
    value: () => TEST_PROCESS_GID,
  });

  return () => {
    restoreProcessDescriptor('getuid', originalGetUid);
    restoreProcessDescriptor('getgid', originalGetGid);
  };
}

function restoreProcessDescriptor(
  name: 'getuid' | 'getgid',
  descriptor: PropertyDescriptor | undefined,
): void {
  if (descriptor === undefined) {
    Reflect.deleteProperty(process, name);
    return;
  }
  Object.defineProperty(process, name, descriptor);
}

interface BrowserRuntimeBoundaryFixtureArgs {
  labPolicyId: string;
  browserPolicyId: string;
  runtimeScript: string;
  stdout: string;
  rmResult?: PtcSessionDockerCommandResult;
}

function createBrowserRuntimeBoundaryFixture(
  args: BrowserRuntimeBoundaryFixtureArgs,
): {
  fixture: ReturnType<typeof createPtcSessionDockerCommandFixture>;
  getObservedInput: () => BrowserRuntimeExecInput | undefined;
  getRmInvocationCount: () => number;
} {
  let callbackRootHostPath = '';
  let observedInput: BrowserRuntimeExecInput | undefined;
  const fixture = createPtcSessionDockerCommandFixture({
    commandResult: async (invocation) => {
      if (invocation.args[0] === 'create') {
        callbackRootHostPath = readPtcSessionDockerBindMountHostPath(
          invocation,
          PTC_SESSION_DOCKER_CALLBACK_CONTAINER_ROOT,
        );
        assertDockerCreatePolicyLabels(invocation, args);
        return {
          kind: 'exit',
          exitCode: 0,
          stdout: `${PTC_TEST_SESSION_DOCKER_CONTAINER_ID}\n`,
          stderr: '',
        };
      }
      if (invocation.args[0] === 'exec') {
        const inputContainerPath = assertDockerExecRuntimeCommand(
          invocation,
          args.runtimeScript,
        );
        observedInput = JSON.parse(
          await readFile(
            join(callbackRootHostPath, basename(inputContainerPath)),
            'utf8',
          ),
        ) as BrowserRuntimeExecInput;
        return {
          kind: 'exit',
          exitCode: 0,
          stdout: args.stdout,
          stderr: '',
        };
      }
      if (invocation.args[0] === 'rm' && args.rmResult !== undefined) {
        return args.rmResult;
      }
      return undefined;
    },
  });

  return {
    fixture,
    getObservedInput: () => observedInput,
    getRmInvocationCount: () =>
      fixture.invocations.filter((invocation) => invocation.args[0] === 'rm')
        .length,
  };
}

function assertDockerCreatePolicyLabels(
  invocation: PtcSessionDockerCommandInvocation,
  expected: { labPolicyId: string; browserPolicyId: string },
): void {
  assert.equal(
    invocation.args.includes(`geulbat.labPolicyId=${expected.labPolicyId}`),
    true,
  );
  assert.equal(
    invocation.args.includes(
      `geulbat.browserPolicyId=${expected.browserPolicyId}`,
    ),
    true,
  );
  assert.equal(
    invocation.args.includes(
      `geulbat.networkPolicyId=${PTC_LAB_OPEN_EGRESS_LOCAL_POLICY_ID}`,
    ),
    true,
  );
}

function assertDockerExecRuntimeCommand(
  invocation: PtcSessionDockerCommandInvocation,
  runtimeScript: string,
): string {
  assert.equal(invocation.args[1], PTC_TEST_SESSION_DOCKER_CONTAINER_ID);
  assert.equal(
    invocation.args.some((arg) => TARGET_SECRET_PATTERN.test(arg)),
    false,
  );
  assert.deepEqual(invocation.args.slice(2, -1), ['node', '-e', runtimeScript]);
  const inputContainerPath = invocation.args.at(-1);
  assert.ok(inputContainerPath);
  assert.notEqual(inputContainerPath, runtimeScript);
  return inputContainerPath;
}

function assertObservedInput(
  observedInput: BrowserRuntimeExecInput | undefined,
): void {
  assert.deepEqual(observedInput, {
    targetUrl: TARGET_URL,
    timeoutMs: 1000,
    loadWaitState: 'domcontentloaded',
  });
}

function fixedNow(): () => number {
  let value = 100;
  return () => {
    value += 11;
    return value;
  };
}

async function withRuntimeRoot<T>(
  label: string,
  fn: (runtimeRoot: string) => Promise<T>,
): Promise<T> {
  const runtimeRoot = await mkdtemp(join(tmpdir(), `geulbat-${label}-`));
  try {
    return await fn(runtimeRoot);
  } finally {
    await rm(runtimeRoot, { recursive: true, force: true });
  }
}

void test('PTC browser runtimes execute through deterministic Docker session boundary without command-arg URL leaks', async () => {
  await withRuntimeRoot('browser-navigate-e2e', async (runtimeRoot) => {
    const boundary = createBrowserRuntimeBoundaryFixture({
      labPolicyId: PTC_BROWSER_NAVIGATE_LAB_POLICY_ID,
      browserPolicyId: PTC_LAB_BROWSER_USER_URL_NAVIGATION_POLICY_ID,
      runtimeScript: PTC_LAB_BROWSER_USER_URL_NAVIGATION_RUNTIME_SCRIPT,
      stdout: browserUserUrlNavigationStdout({
        ok: true,
        checks: PTC_BROWSER_USER_URL_NAVIGATION_TEST_SUCCESS_CHECKS,
      }),
    });
    const runtime = createPtcBrowserNavigateRuntime({
      commandRunner: boundary.fixture.runner,
      realpathWorkspaceRoot: async () => '/real/workspace/browser-e2e',
      runtimeRootForWorkspace: () => runtimeRoot,
      now: fixedNow(),
    });

    const result = await runtime.navigate({
      runContext: makeRunWorkspaceContext({
        threadId: testThreadId(960),
        projectId: testProjectId('project'),
        workspaceRoot: '/workspace/project',
      }),
      request: { url: TARGET_URL, timeoutMs: 1000 },
    });

    assert.equal(result.ok, true);
    assertObservedInput(boundary.getObservedInput());
    assert.equal(
      result.ok ? result.value.capability : '',
      PTC_LAB_BROWSER_USER_URL_NAVIGATION_CAPABILITY,
    );
    assert.equal(
      result.ok ? result.value.browserPolicyId : '',
      PTC_LAB_BROWSER_USER_URL_NAVIGATION_POLICY_ID,
    );
    assert.equal(PTC_BROWSER_NAVIGATE_TOOL_NAME, 'browser_navigate');
    assert.deepEqual(await runtime.closeAll(), { ok: true });
  });

  await withRuntimeRoot('browser-page-load-e2e', async (runtimeRoot) => {
    const boundary = createBrowserRuntimeBoundaryFixture({
      labPolicyId: PTC_BROWSER_PAGE_LOAD_EVIDENCE_LAB_POLICY_ID,
      browserPolicyId: PTC_LAB_BROWSER_PAGE_LOAD_EVIDENCE_POLICY_ID,
      runtimeScript: PTC_LAB_BROWSER_PAGE_LOAD_EVIDENCE_RUNTIME_SCRIPT,
      stdout: browserPageLoadEvidenceStdout({
        ok: true,
        checks: PTC_BROWSER_PAGE_LOAD_EVIDENCE_TEST_SUCCESS_CHECKS,
        statusCode: 200,
        title: 'Example Domain',
      }),
    });
    const runtime = createPtcBrowserPageLoadEvidenceRuntime({
      commandRunner: boundary.fixture.runner,
      realpathWorkspaceRoot: async () => '/real/workspace/browser-e2e',
      runtimeRootForWorkspace: () => runtimeRoot,
      now: fixedNow(),
    });

    const result = await runtime.collectEvidence({
      runContext: makeRunWorkspaceContext({
        threadId: testThreadId(961),
        projectId: testProjectId('project'),
        workspaceRoot: '/workspace/project',
      }),
      request: { url: TARGET_URL, timeoutMs: 1000 },
    });

    assert.equal(result.ok, true);
    assertObservedInput(boundary.getObservedInput());
    assert.equal(
      result.ok ? result.value.capability : '',
      PTC_LAB_BROWSER_PAGE_LOAD_EVIDENCE_CAPABILITY,
    );
    assert.equal(
      result.ok ? result.value.browserPolicyId : '',
      PTC_LAB_BROWSER_PAGE_LOAD_EVIDENCE_POLICY_ID,
    );
    assert.equal(
      PTC_BROWSER_PAGE_LOAD_EVIDENCE_TOOL_NAME,
      'browser_page_load_evidence',
    );
    assert.deepEqual(await runtime.closeAll(), { ok: true });
  });

  await withRuntimeRoot('browser-text-evidence-e2e', async (runtimeRoot) => {
    const boundary = createBrowserRuntimeBoundaryFixture({
      labPolicyId: PTC_BROWSER_TEXT_EVIDENCE_LAB_POLICY_ID,
      browserPolicyId: PTC_LAB_BROWSER_DOM_TEXT_EVIDENCE_POLICY_ID,
      runtimeScript: PTC_LAB_BROWSER_TEXT_EVIDENCE_RUNTIME_SCRIPT,
      stdout: browserTextEvidenceStdout({
        ok: true,
        checks: PTC_BROWSER_TEXT_EVIDENCE_TEST_SUCCESS_CHECKS,
        visibleText: 'Example Domain Visible Text',
      }),
    });
    const runtime = createPtcBrowserTextEvidenceRuntime({
      commandRunner: boundary.fixture.runner,
      realpathWorkspaceRoot: async () => '/real/workspace/browser-e2e',
      runtimeRootForWorkspace: () => runtimeRoot,
      now: fixedNow(),
    });

    const result = await runtime.collectEvidence({
      runContext: makeRunWorkspaceContext({
        threadId: testThreadId(962),
        projectId: testProjectId('project'),
        workspaceRoot: '/workspace/project',
      }),
      request: { url: TARGET_URL, timeoutMs: 1000 },
    });

    assert.equal(result.ok, true);
    assertObservedInput(boundary.getObservedInput());
    assert.equal(
      result.ok ? result.value.capability : '',
      PTC_LAB_BROWSER_TEXT_EVIDENCE_CAPABILITY,
    );
    assert.equal(
      result.ok ? result.value.browserPolicyId : '',
      PTC_LAB_BROWSER_DOM_TEXT_EVIDENCE_POLICY_ID,
    );
    assert.equal(PTC_BROWSER_TEXT_EVIDENCE_TOOL_NAME, 'browser_text_evidence');
    assert.deepEqual(await runtime.closeAll(), { ok: true });
  });
});

void test('PTC browser runtime cleanup failure reports diagnostics and clears workspace runtime state', async () => {
  await withRuntimeRoot('browser-cleanup-e2e', async (runtimeRoot) => {
    const boundary = createBrowserRuntimeBoundaryFixture({
      labPolicyId: PTC_BROWSER_NAVIGATE_LAB_POLICY_ID,
      browserPolicyId: PTC_LAB_BROWSER_USER_URL_NAVIGATION_POLICY_ID,
      runtimeScript: PTC_LAB_BROWSER_USER_URL_NAVIGATION_RUNTIME_SCRIPT,
      stdout: browserUserUrlNavigationStdout({
        ok: true,
        checks: PTC_BROWSER_USER_URL_NAVIGATION_TEST_SUCCESS_CHECKS,
      }),
      rmResult: {
        kind: 'exit',
        exitCode: 1,
        stdout: '',
        stderr: 'remove failed',
      },
    });
    const runtime = createPtcBrowserNavigateRuntime({
      commandRunner: boundary.fixture.runner,
      realpathWorkspaceRoot: async () => '/real/workspace/browser-cleanup-e2e',
      runtimeRootForWorkspace: () => runtimeRoot,
    });

    const result = await runtime.navigate({
      runContext: makeRunWorkspaceContext({
        threadId: testThreadId(963),
        projectId: testProjectId('project'),
        workspaceRoot: '/workspace/project',
      }),
      request: { url: TARGET_URL, timeoutMs: 1000 },
    });

    assert.equal(result.ok, true);
    assert.deepEqual(await runtime.closeAll(), {
      ok: false,
      reasonCode: 'ptc_browser_navigate_session_cleanup_failed',
      message: 'PTC browser navigation session cleanup failed',
      diagnostics: {
        cleanupReasonCode: 'container_remove_failed',
        workspaceRuntimeCount: 1,
      },
    });
    const rmCountAfterFailure = boundary.getRmInvocationCount();
    assert.deepEqual(await runtime.closeAll(), { ok: true });
    assert.equal(boundary.getRmInvocationCount(), rmCountAfterFailure);
  });
});
