import assert from 'node:assert/strict';
import test from 'node:test';

import { toApprovalClass } from '@geulbat/protocol/run-approval';

import {
  createApprovalGrantStore,
  type ApprovalGrantContext,
} from './approval-grants.js';

const COMPUTER_SESSION = 'computer-session-1';
const RUN = 'run-1';

function grantContext(
  overrides: Partial<ApprovalGrantContext> = {},
): ApprovalGrantContext {
  return {
    runId: RUN,
    computerSessionId: COMPUTER_SESSION,
    approvalClass: toApprovalClass('manage_files:delete'),
    sideEffectLevel: 'write',
    permissionMode: 'basic',
    ...overrides,
  };
}

void test('a session pass is reused for the same class and side-effect level', () => {
  const store = createApprovalGrantStore();
  store.registerApprovalGrant(grantContext(), 'session');

  assert.equal(store.hasApprovalGrant(grantContext()), true);
  // A different run in the same computer session still reuses a session pass.
  assert.equal(store.hasApprovalGrant(grantContext({ runId: 'run-2' })), true);
});

void test('a session pass granted for a write call does not cover a destructive call', () => {
  const store = createApprovalGrantStore();
  store.registerApprovalGrant(
    grantContext({ sideEffectLevel: 'write' }),
    'session',
  );

  // The user approved what the prompt labelled `write`. The same class arriving
  // as `destructive` is a different decision and must prompt again.
  assert.equal(
    store.hasApprovalGrant(grantContext({ sideEffectLevel: 'destructive' })),
    false,
  );
});

void test('a run pass granted for a write call does not cover a destructive call', () => {
  const store = createApprovalGrantStore();
  store.registerApprovalGrant(
    grantContext({ sideEffectLevel: 'write' }),
    'run',
  );

  assert.equal(
    store.hasApprovalGrant(grantContext({ sideEffectLevel: 'write' })),
    true,
  );
  assert.equal(
    store.hasApprovalGrant(grantContext({ sideEffectLevel: 'destructive' })),
    false,
  );
});

void test('a pass for one approval class never covers another class', () => {
  const store = createApprovalGrantStore();
  store.registerApprovalGrant(
    grantContext({ approvalClass: toApprovalClass('manage_files') }),
    'session',
  );

  // Matching is exact, so the parent fallback class does not open the narrowed
  // per-operation classes.
  assert.equal(
    store.hasApprovalGrant(
      grantContext({ approvalClass: toApprovalClass('manage_files:delete') }),
    ),
    false,
  );
});

void test('a once decision is never stored as a reusable pass', () => {
  const store = createApprovalGrantStore();
  store.registerApprovalGrant(grantContext(), 'once');

  assert.equal(store.hasApprovalGrant(grantContext()), false);
});

void test('run passes are dropped per run while session passes survive', () => {
  const store = createApprovalGrantStore();
  store.registerApprovalGrant(grantContext(), 'run');
  store.registerApprovalGrant(
    grantContext({ approvalClass: toApprovalClass('write_file') }),
    'session',
  );

  store.clearRun(COMPUTER_SESSION, RUN);

  assert.equal(store.hasApprovalGrant(grantContext()), false);
  assert.equal(
    store.hasApprovalGrant(
      grantContext({ approvalClass: toApprovalClass('write_file') }),
    ),
    true,
  );
});

void test('rebinding a run moves only its run grants to the next computer session', () => {
  const store = createApprovalGrantStore();
  const nextComputerSessionId = 'computer-session-2';
  store.registerApprovalGrant(grantContext(), 'run');
  store.registerApprovalGrant(
    grantContext({ approvalClass: toApprovalClass('write_file') }),
    'session',
  );

  store.rebindRun(COMPUTER_SESSION, nextComputerSessionId, RUN);

  assert.equal(store.hasApprovalGrant(grantContext()), false);
  assert.equal(
    store.hasApprovalGrant(
      grantContext({ computerSessionId: nextComputerSessionId }),
    ),
    true,
  );
  assert.equal(
    store.hasApprovalGrant(
      grantContext({ approvalClass: toApprovalClass('write_file') }),
    ),
    true,
  );
  assert.equal(
    store.hasApprovalGrant(
      grantContext({
        computerSessionId: nextComputerSessionId,
        approvalClass: toApprovalClass('write_file'),
      }),
    ),
    false,
  );
});

void test('clearing a computer session drops both scopes', () => {
  const store = createApprovalGrantStore();
  store.registerApprovalGrant(grantContext(), 'run');
  store.registerApprovalGrant(grantContext(), 'session');

  store.clearComputerSession(COMPUTER_SESSION);

  assert.equal(store.hasApprovalGrant(grantContext()), false);
});

void test('passes never leak across computer sessions', () => {
  const store = createApprovalGrantStore();
  store.registerApprovalGrant(grantContext(), 'session');

  assert.equal(
    store.hasApprovalGrant(
      grantContext({ computerSessionId: 'computer-session-2' }),
    ),
    false,
  );
});
