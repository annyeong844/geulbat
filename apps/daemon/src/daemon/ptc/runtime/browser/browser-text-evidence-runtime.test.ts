import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import {
  PTC_BROWSER_TEXT_EVIDENCE_LAB_POLICY_ID,
  PTC_BROWSER_TEXT_EVIDENCE_TOOL_NAME,
} from './browser-text-evidence-runtime-contract.js';
import { PTC_LAB_BROWSER_TEXT_EVIDENCE_RUNTIME_SCRIPT } from '../../lab/browser/core/lab-browser-runtime-script.js';
import { PTC_LAB_BROWSER_TEXT_EVIDENCE_CAPABILITY } from '../../lab/browser/text-evidence/lab-browser-text-evidence-contract.js';
import { PTC_LAB_BROWSER_DOM_TEXT_EVIDENCE_POLICY_ID } from '../../lab/browser/core/lab-browser-policy-ids.js';
import { PTC_LAB_OPEN_EGRESS_LOCAL_POLICY_ID } from '../../lab/network/lab-network-policy.js';
import { PTC_SESSION_DOCKER_CALLBACK_CONTAINER_ROOT } from '../../lab/session/session-docker-contract.js';
import {
  browserTextEvidenceStdout,
  PTC_BROWSER_TEXT_EVIDENCE_TEST_SUCCESS_CHECKS,
  type BrowserTextEvidenceExecInput,
} from '../../../../test-support/ptc-browser-text-evidence.js';
import {
  PTC_TEST_SESSION_DOCKER_CONTAINER_ID,
  createPtcSessionDockerCommandFixture,
  readPtcSessionDockerBindMountHostPath,
} from '../../../../test-support/ptc-session-docker.js';
import { makeRunWorkspaceContext } from '../../../../test-support/run-workspace-context.js';
import { testProjectId } from '../../../../test-support/project-id.js';
import { testThreadId } from '../../../../test-support/thread-id.js';
import { createPtcBrowserTextEvidenceRuntime } from './browser-text-evidence-runtime.js';

void test('createPtcBrowserTextEvidenceRuntime wires text evidence policy without raw URL command leaks', async () => {
  const runtimeRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-browser-text-evidence-'),
  );
  let callbackRootHostPath = '';
  let observedInput: BrowserTextEvidenceExecInput | undefined;

  const fixture = createPtcSessionDockerCommandFixture({
    commandResult: async (invocation) => {
      if (invocation.args[0] === 'create') {
        callbackRootHostPath = readPtcSessionDockerBindMountHostPath(
          invocation,
          PTC_SESSION_DOCKER_CALLBACK_CONTAINER_ROOT,
        );
        assert.equal(
          invocation.args.includes(
            `geulbat.labPolicyId=${PTC_BROWSER_TEXT_EVIDENCE_LAB_POLICY_ID}`,
          ),
          true,
        );
        assert.equal(
          invocation.args.includes(
            `geulbat.browserPolicyId=${PTC_LAB_BROWSER_DOM_TEXT_EVIDENCE_POLICY_ID}`,
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
        PTC_LAB_BROWSER_TEXT_EVIDENCE_RUNTIME_SCRIPT,
      ]);

      const inputContainerPath = invocation.args.at(-1);
      assert.ok(inputContainerPath);
      observedInput = JSON.parse(
        await readFile(
          join(callbackRootHostPath, basename(inputContainerPath)),
          'utf8',
        ),
      ) as BrowserTextEvidenceExecInput;
      return {
        kind: 'exit',
        exitCode: 0,
        stdout: browserTextEvidenceStdout({
          ok: true,
          checks: PTC_BROWSER_TEXT_EVIDENCE_TEST_SUCCESS_CHECKS,
          visibleText: 'Example Domain Visible Text',
          redirectCount: 1,
          navigationDurationMs: 37,
        }),
        stderr: '',
      };
    },
  });

  try {
    const runtime = createPtcBrowserTextEvidenceRuntime({
      commandRunner: fixture.runner,
      realpathWorkspaceRoot: async () =>
        '/real/workspace/browser-text-evidence',
      runtimeRootForWorkspace: () => runtimeRoot,
      now: (() => {
        let value = 100;
        return () => {
          value += 11;
          return value;
        };
      })(),
    });

    const result = await runtime.collectEvidence({
      runContext: makeRunWorkspaceContext({
        threadId: testThreadId(951),
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
      PTC_LAB_BROWSER_TEXT_EVIDENCE_CAPABILITY,
    );
    assert.equal(
      result.ok ? result.value.browserPolicyId : '',
      PTC_LAB_BROWSER_DOM_TEXT_EVIDENCE_POLICY_ID,
    );
    assert.equal(result.ok ? result.value.timing.ownerDurationMs : 0, 11);
    assert.equal(
      result.ok ? result.value.visibleText : '',
      'Example Domain Visible Text',
    );
    assert.equal(PTC_BROWSER_TEXT_EVIDENCE_TOOL_NAME, 'browser_text_evidence');
  } finally {
    await rm(runtimeRoot, { recursive: true, force: true });
  }
});
