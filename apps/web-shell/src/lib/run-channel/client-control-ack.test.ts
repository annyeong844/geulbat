import test from 'node:test';
import assert from 'node:assert/strict';

import type {
  RunChannelClientMessage,
  RunChannelServerMessage,
} from '@geulbat/protocol/run-channel';

import { brandRunId, brandThreadId } from '../id-brand-helpers.js';
import {
  connectAuthenticatedClient,
  createClientHarness,
  getSocket,
} from '../../test-support/run-channel-client-harness.js';

void test('RunChannelClient waits for the correlated run.approve acknowledgement', async () => {
  const harness = createClientHarness();
  const socket = await connectAuthenticatedClient(harness);

  const approvalPromise = harness.client.approve({
    callId: 'call-approve-ack',
    runId: brandRunId('run-approve-ack'),
    threadId: brandThreadId('123e4567-e89b-42d3-a456-426614174000'),
    approved: true,
    grantScope: 'once',
  });
  await Promise.resolve();

  const message = JSON.parse(
    socket.sent[1] ?? 'null',
  ) as RunChannelClientMessage;
  assert.equal(message.type, 'run.approve');
  if (message.type !== 'run.approve') {
    return;
  }

  let settled = false;
  void approvalPromise.then(() => {
    settled = true;
  });
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
  assert.equal(settled, false);

  socket.emitMessage({
    type: 'run.control',
    requestId: message.requestId,
    action: 'run.approve',
    ok: true,
  });

  assert.equal(await approvalPromise, message.requestId);
});

void test('RunChannelClient waits for explicit provider outcome-unknown recovery', async () => {
  const harness = createClientHarness();
  const socket = await connectAuthenticatedClient(harness);
  const request = {
    threadId: brandThreadId('123e4567-e89b-42d3-a456-426614174091'),
    acknowledgePossibleDuplicateProviderWork: true as const,
  };

  const recoveryPromise =
    harness.client.recoverProviderRequestOutcomeUnknown(request);
  await Promise.resolve();

  const message = JSON.parse(
    socket.sent[1] ?? 'null',
  ) as RunChannelClientMessage;
  assert.equal(message.type, 'run.provider_request.recover');
  if (message.type !== 'run.provider_request.recover') {
    return;
  }
  assert.deepEqual(message.request, request);

  socket.emitMessage({
    type: 'run.control',
    requestId: message.requestId,
    action: 'run.provider_request.recover',
    ok: true,
    disposition: 'terminal_available',
  });

  assert.equal(await recoveryPromise, 'terminal_available');
});

void test('RunChannelClient correlates a trusted planning command acknowledgement', async () => {
  const harness = createClientHarness();
  const socket = await connectAuthenticatedClient(harness);
  const request = {
    kind: 'approve' as const,
    threadId: brandThreadId('123e4567-e89b-42d3-a456-426614174000'),
    workflowId: 'workflow-trusted',
    planId: 'plan-trusted',
    revision: 2,
    digest:
      'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' as const,
  };

  const commandPromise = harness.client.planCommand(request);
  await Promise.resolve();

  const message = JSON.parse(
    socket.sent[1] ?? 'null',
  ) as RunChannelClientMessage;
  assert.equal(message.type, 'plan.command');
  if (message.type !== 'plan.command') {
    return;
  }
  assert.deepEqual(message.request, request);

  let settled = false;
  void commandPromise.then(() => {
    settled = true;
  });
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
  assert.equal(settled, false);

  socket.emitMessage({
    type: 'run.control',
    requestId: message.requestId,
    action: 'plan.command',
    ok: true,
    commandKind: 'approve',
    snapshot: null,
    approvedPlanRef: {
      workflowId: request.workflowId,
      planId: request.planId,
      revision: request.revision,
      digest: request.digest,
    },
  });

  assert.deepEqual(await commandPromise, {
    type: 'run.control',
    requestId: message.requestId,
    action: 'plan.command',
    ok: true,
    commandKind: 'approve',
    snapshot: null,
    approvedPlanRef: {
      workflowId: request.workflowId,
      planId: request.planId,
      revision: request.revision,
      digest: request.digest,
    },
  });
});

void test('RunChannelClient correlates a Goal command acknowledgement', async () => {
  const harness = createClientHarness();
  const socket = await connectAuthenticatedClient(harness);
  const request = {
    kind: 'resume' as const,
    threadId: brandThreadId('123e4567-e89b-42d3-a456-426614174084'),
    goalId: 'goal-trusted',
  };

  const commandPromise = harness.client.goalCommand(request);
  await Promise.resolve();

  const message = JSON.parse(
    socket.sent[1] ?? 'null',
  ) as RunChannelClientMessage;
  assert.equal(message.type, 'goal.command');
  if (message.type !== 'goal.command') {
    return;
  }
  assert.deepEqual(message.request, request);

  socket.emitMessage({
    type: 'run.control',
    requestId: message.requestId,
    action: 'goal.command',
    ok: true,
    commandKind: 'resume',
    snapshot: null,
  });

  const control = await commandPromise;
  assert.equal(control.action, 'goal.command');
  assert.equal(control.commandKind, 'resume');
  assert.equal(control.snapshot, null);
});

void test('RunChannelClient waits for the correlated child cancel acknowledgement', async () => {
  const harness = createClientHarness();
  const socket = await connectAuthenticatedClient(harness);
  const request = {
    parentRunId: brandRunId('run-child-cancel-parent'),
    childRunId: brandRunId('run-child-cancel-target'),
  };

  const cancelPromise = harness.client.cancelChild(request);
  await Promise.resolve();

  const message = JSON.parse(
    socket.sent[1] ?? 'null',
  ) as RunChannelClientMessage;
  assert.equal(message.type, 'run.child.cancel');
  if (message.type !== 'run.child.cancel') {
    return;
  }
  assert.deepEqual(message.request, request);

  socket.emitMessage({
    type: 'run.control',
    requestId: message.requestId,
    action: 'run.child.cancel',
    ok: true,
  });

  assert.equal(await cancelPromise, message.requestId);
});

void test('RunChannelClient rejects an unacknowledged approval when the socket disconnects', async () => {
  const harness = createClientHarness();
  const socket = await connectAuthenticatedClient(harness);

  const approvalPromise = harness.client.approve({
    callId: 'call-approve-disconnect',
    runId: brandRunId('run-approve-disconnect'),
    threadId: brandThreadId('123e4567-e89b-42d3-a456-426614174000'),
    approved: true,
    grantScope: 'once',
  });
  await Promise.resolve();

  socket.close();

  await assert.rejects(approvalPromise, /run channel disconnected/u);
  assert.equal(harness.scheduler.size, 1);
});

void test('RunChannelClient closes an approval auth handshake without a dangling acknowledgement', async () => {
  const harness = createClientHarness();
  const approvalPromise = harness.client.approve({
    callId: 'call-approve-auth-close',
    runId: brandRunId('run-approve-auth-close'),
    threadId: brandThreadId('123e4567-e89b-42d3-a456-426614174000'),
    approved: true,
    grantScope: 'once',
  });
  const socket = getSocket(harness.sockets);

  harness.client.close();

  await assert.rejects(approvalPromise, /run channel closed/u);
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
  assert.equal(socket.readyState, 3);
  assert.equal(harness.scheduler.size, 0);
});

void test('RunChannelClient waits for run.interject acknowledgement', async () => {
  const harness = createClientHarness();
  const socket = await connectAuthenticatedClient(harness);

  const interjectPromise = harness.client.interject({
    runId: brandRunId('run-1'),
    text: 'steer',
  });
  await Promise.resolve();
  const interjectMessage = JSON.parse(
    socket.sent[1] ?? 'null',
  ) as RunChannelClientMessage;
  assert.equal(interjectMessage.type, 'run.interject');
  if (interjectMessage.type !== 'run.interject') {
    return;
  }

  let settled = false;
  void interjectPromise.then(() => {
    settled = true;
  });
  await Promise.resolve();
  assert.equal(settled, false);

  socket.emitMessage({
    type: 'run.control',
    requestId: interjectMessage.requestId,
    action: 'run.interject',
    ok: true,
    receivedSeq: 1,
    bufferDepth: 0,
  });

  assert.deepEqual(await interjectPromise, {
    requestId: interjectMessage.requestId,
    receivedSeq: 1,
  });
});

void test('RunChannelClient rejects run.interject on matching run.error', async () => {
  const harness = createClientHarness();
  const socket = await connectAuthenticatedClient(harness);

  const interjectPromise = harness.client.interject({
    runId: brandRunId('run-1'),
    text: 'steer',
  });
  await Promise.resolve();
  const interjectMessage = JSON.parse(
    socket.sent[1] ?? 'null',
  ) as RunChannelClientMessage;
  assert.equal(interjectMessage.type, 'run.interject');
  if (interjectMessage.type !== 'run.interject') {
    return;
  }

  socket.emitMessage({
    type: 'run.error',
    requestId: interjectMessage.requestId,
    code: 'bad_request',
    message: 'mid-run steer is not enabled',
    status: 503,
  });

  await assert.rejects(interjectPromise, /mid-run steer is not enabled/);
});

void test('RunChannelClient waits for run.interject.flush acknowledgement', async () => {
  const harness = createClientHarness();
  const socket = await connectAuthenticatedClient(harness);

  const flushPromise = harness.client.flushInterject({
    runId: brandRunId('run-1'),
  });
  await Promise.resolve();
  const flushMessage = JSON.parse(
    socket.sent[1] ?? 'null',
  ) as RunChannelClientMessage;
  assert.equal(flushMessage.type, 'run.interject.flush');
  if (flushMessage.type !== 'run.interject.flush') {
    return;
  }
  assert.deepEqual(flushMessage.request, { runId: 'run-1' });

  socket.emitMessage({
    type: 'run.control',
    requestId: flushMessage.requestId,
    action: 'run.interject.flush',
    ok: true,
    flushed: true,
  });

  assert.deepEqual(await flushPromise, { flushed: true });
});

void test('RunChannelClient keeps control-scoped run.error out of the session stream', async () => {
  const harness = createClientHarness();
  const socket = await connectAuthenticatedClient(harness);
  const received: RunChannelServerMessage[] = [];
  harness.client.subscribe((message) => {
    received.push(message);
  });

  const interjectPromise = harness.client.interject({
    runId: brandRunId('run-1'),
    text: 'steer',
  });
  await Promise.resolve();
  const interjectMessage = JSON.parse(
    socket.sent[1] ?? 'null',
  ) as RunChannelClientMessage;
  assert.equal(interjectMessage.type, 'run.interject');
  if (interjectMessage.type !== 'run.interject') {
    return;
  }

  socket.emitMessage({
    type: 'run.error',
    requestId: interjectMessage.requestId,
    code: 'bad_request',
    message: 'mid-run steer is not enabled',
    status: 503,
  });
  await assert.rejects(interjectPromise, /mid-run steer is not enabled/);
  // The awaiting caller owns this failure; the session stream must not see
  // it (it would flip the run view into the error phase mid-run).
  assert.equal(received.length, 0);

  socket.emitMessage({
    type: 'run.error',
    code: 'internal',
    message: 'transport broke',
    status: 500,
  });
  assert.equal(received.length, 1);
  assert.equal(received[0]?.type, 'run.error');
});

void test('RunChannelClient rejects malformed control responses without failing the active session', async () => {
  const harness = createClientHarness();
  const socket = await connectAuthenticatedClient(harness);
  const interjectPromise = harness.client.interject({
    runId: brandRunId('run-1'),
    text: 'steer',
  });
  await Promise.resolve();
  const interjectMessage = JSON.parse(
    socket.sent[1] ?? 'null',
  ) as RunChannelClientMessage;
  assert.equal(interjectMessage.type, 'run.interject');
  if (interjectMessage.type !== 'run.interject') {
    return;
  }

  socket.emitRawMessage(
    JSON.stringify({
      type: 'run.control',
      requestId: interjectMessage.requestId,
      action: 'run.interject',
      ok: true,
      receivedSeq: 'invalid',
      bufferDepth: 0,
    }),
  );

  await assert.rejects(interjectPromise, /invalid websocket payload/);
  assert.equal(socket.readyState, 1);
  assert.equal(harness.messages.length, 0);
  assert.equal(harness.scheduler.size, 0);
});
