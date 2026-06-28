import assert from 'node:assert/strict';
import test from 'node:test';
import {
  collectPtcStaticImportGraph,
  ptcSourceUrl,
  readPtcStaticImportSpecifiers,
} from '../../../../test-support/ptc-static-import-graph.js';
import {
  closeTaintedPtcDockerSession,
  shouldCloseTaintedPtcDockerSessionForCommandResult,
  toPtcSessionTaintCloseDiagnostics,
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
  const sourceUrl = ptcSourceUrl('lab/session/session-taint-close.ts');
  const graph = await collectPtcStaticImportGraph(sourceUrl);

  assert.deepEqual(readPtcStaticImportSpecifiers(graph, sourceUrl), [
    './session-docker-contract.js',
  ]);
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

void test('toPtcSessionTaintCloseDiagnostics uses one taint close failure shape', () => {
  assert.deepEqual(
    toPtcSessionTaintCloseDiagnostics({
      closeAttempted: true,
      closeProven: false,
      closeStatus: 'failed_result',
      reuseAllowed: false,
      sessionReasonCode: 'container_remove_failed',
      sessionTainted: true,
    }),
    {
      sessionCloseFailed: true,
      sessionReasonCode: 'container_remove_failed',
      sessionTainted: true,
    },
  );

  assert.deepEqual(
    toPtcSessionTaintCloseDiagnostics({
      closeAttempted: true,
      closeProven: false,
      closeStatus: 'threw',
      reuseAllowed: false,
      sessionTainted: true,
    }),
    {
      sessionCloseFailed: true,
      sessionTainted: true,
    },
  );
});

void test('toPtcSessionTaintCloseDiagnostics omits proven close diagnostics', () => {
  assert.equal(
    toPtcSessionTaintCloseDiagnostics({
      closeAttempted: true,
      closeProven: true,
      closeStatus: 'succeeded',
      reuseAllowed: false,
      sessionTainted: true,
    }),
    undefined,
  );
});

void test('shouldCloseTaintedPtcDockerSessionForCommandResult owns non-exit taint decisions', () => {
  assert.equal(
    shouldCloseTaintedPtcDockerSessionForCommandResult({ kind: 'exit' }),
    false,
  );
  assert.equal(
    shouldCloseTaintedPtcDockerSessionForCommandResult({
      kind: 'timeout',
      processTerminated: true,
    }),
    false,
  );
  assert.equal(
    shouldCloseTaintedPtcDockerSessionForCommandResult({
      kind: 'cancelled',
      processTerminated: false,
    }),
    true,
  );
  assert.equal(
    shouldCloseTaintedPtcDockerSessionForCommandResult({
      kind: 'output_limit_exceeded',
      processTerminated: false,
    }),
    true,
  );
  assert.equal(
    shouldCloseTaintedPtcDockerSessionForCommandResult({ kind: 'crash' }),
    true,
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
