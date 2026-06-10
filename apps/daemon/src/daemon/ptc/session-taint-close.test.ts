import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  closeTaintedPtcDockerSession,
  type PtcSessionTaintCloseInput,
} from './session-taint-close.js';
import type {
  PtcSessionDockerIdentity,
  PtcSessionDockerManager,
} from './session-docker-contract.js';

const IDENTITY: PtcSessionDockerIdentity = Object.freeze({
  threadId: 'thread-tainted-close',
  workspaceRoot: '/workspace/project-a',
  trustContextId: 'trust-local-v1',
});

void test('session taint close owner imports only the session Docker contract boundary', async () => {
  const source = await readFile(
    new URL('../../../src/daemon/ptc/session-taint-close.ts', import.meta.url),
    'utf8',
  );

  assert.match(source, /session-docker-contract\.js/u);
  assert.doesNotMatch(source, /session-docker\.js/u);
  assert.doesNotMatch(source, /lab-browser-[a-z-]+(?:-result|-policy)?\.js/u);
  assert.doesNotMatch(source, /lab-open-egress-smoke\.js/u);
  assert.doesNotMatch(source, /execute-code-runtime\.js/u);
  assert.doesNotMatch(
    source,
    /session-docker-(?:host-roots|command|create-args)\.js/u,
  );
  assert.doesNotMatch(source, /closeAll|getOrCreate/u);
});

void test('closeTaintedPtcDockerSession calls close exactly once with the provided identity', async () => {
  const calls: PtcSessionDockerIdentity[] = [];
  const outcome = await closeTaintedPtcDockerSession({
    identity: IDENTITY,
    sessionManager: {
      async close(identity) {
        calls.push(identity);
        return { ok: true, value: undefined };
      },
    },
  });

  assert.deepEqual(calls, [IDENTITY]);
  assert.deepEqual(outcome, {
    closeAttempted: true,
    closeProven: true,
    closeStatus: 'succeeded',
    reuseAllowed: false,
    sessionTainted: true,
  });
});

void test('closeTaintedPtcDockerSession preserves stable close failure reason only', async () => {
  const outcome = await closeTaintedPtcDockerSession({
    identity: IDENTITY,
    sessionManager: {
      async close() {
        return {
          ok: false,
          reasonCode: 'container_remove_failed',
          message: '/tmp/geulbat-private/.geulbat/secret should not leak',
          diagnostics: { containerId: 'container-secret' },
        };
      },
    },
  });

  assert.deepEqual(outcome, {
    closeAttempted: true,
    closeProven: false,
    closeStatus: 'failed_result',
    reuseAllowed: false,
    sessionReasonCode: 'container_remove_failed',
    sessionTainted: true,
  });
  assert.doesNotMatch(
    JSON.stringify(outcome),
    /geulbat-private|\.geulbat|container-secret|secret/u,
  );
});

void test('closeTaintedPtcDockerSession records throw without raw error data', async () => {
  const manager: Pick<PtcSessionDockerManager, 'close'> = {
    async close() {
      throw new Error(
        '/tmp/geulbat-private/.geulbat/secret callback.sock container-secret',
      );
    },
  };

  const outcome = await closeTaintedPtcDockerSession({
    identity: IDENTITY,
    sessionManager: manager,
  });

  assert.deepEqual(outcome, {
    closeAttempted: true,
    closeProven: false,
    closeStatus: 'threw',
    reuseAllowed: false,
    sessionTainted: true,
  });
  assert.doesNotMatch(
    JSON.stringify(outcome),
    /geulbat-private|\.geulbat|callback\.sock|container-secret|secret/u,
  );
});

void test('closeTaintedPtcDockerSession has no retry, closeAll, or fallback identity path', async () => {
  let closeCalls = 0;
  const fallbackIdentity: PtcSessionDockerIdentity = {
    ...IDENTITY,
    threadId: 'thread-fallback',
  };
  const args: PtcSessionTaintCloseInput = {
    identity: IDENTITY,
    sessionManager: {
      async close(identity) {
        closeCalls += 1;
        assert.notDeepEqual(identity, fallbackIdentity);
        return {
          ok: false,
          reasonCode: 'container_remove_failed',
          message: 'close failed',
        };
      },
    },
  };

  const outcome = await closeTaintedPtcDockerSession(args);

  assert.equal(closeCalls, 1);
  assert.equal(outcome.closeStatus, 'failed_result');
  assert.equal(outcome.closeProven, false);
});
