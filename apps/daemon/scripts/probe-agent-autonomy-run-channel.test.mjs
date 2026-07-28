import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { runAgentAutonomyRunChannelProbe } from './probe-agent-autonomy-run-channel.mjs';

const RUN_ID = 'run-autonomy-probe';
const EXPECTED_ANSWER = 'geulbat-cli2';

class FakeRunChannelSocket {
  constructor({
    declarationPath,
    approval = false,
    socketError = false,
    socketErrorAfterAck = false,
  }) {
    this.declarationPath = declarationPath;
    this.approval = approval;
    this.socketError = socketError;
    this.socketErrorAfterAck = socketErrorAfterAck;
    this.listeners = new Map();
    this.sent = [];
    queueMicrotask(() => this.emit('open'));
  }

  on(name, listener) {
    const listeners = this.listeners.get(name) ?? [];
    listeners.push(listener);
    this.listeners.set(name, listeners);
    return this;
  }

  once(name, listener) {
    const onceListener = (...args) => {
      this.listeners.set(
        name,
        (this.listeners.get(name) ?? []).filter(
          (candidate) => candidate !== onceListener,
        ),
      );
      listener(...args);
    };
    return this.on(name, onceListener);
  }

  removeAllListeners() {
    this.listeners.clear();
  }

  close() {}

  send(raw) {
    const message = JSON.parse(String(raw));
    this.sent.push(message);
    if (message.type === 'run.auth') {
      if (this.socketError) {
        queueMicrotask(() => this.emit('error'));
        return;
      }
      this.reply({
        type: 'run.event',
        event: {
          runId: 'run-recovered',
          threadId: '3fba1cf0-684e-4e77-846d-b4a6fca9b721',
          seq: 99,
          type: 'error',
          ts: '2026-07-28T00:59:59.000Z',
          payload: { code: 'internal', message: 'unrelated recovered run' },
        },
      });
      this.reply({
        type: 'run.auth.ok',
        requestId: message.requestId,
        ok: true,
        computerSessionId: 'computer-session-probe',
      });
    } else if (message.type === 'run.start') {
      assert.equal(existsSync(this.declarationPath), true);
      assert.equal(typeof message.request.threadId, 'string');
      assert.deepEqual(message.request.allowedPublicToolNames, ['read_file']);
      this.threadId = message.request.threadId;
      this.event(0, 'run_ack', {
        runId: RUN_ID,
        threadId: this.threadId,
      });
      if (this.socketErrorAfterAck) {
        queueMicrotask(() => this.emit('error'));
        return;
      }
      if (this.approval) {
        this.event(1, 'approval_required', {
          callId: 'approval-call',
          runId: RUN_ID,
          threadId: this.threadId,
          toolName: 'exec_command',
          approvalClass: 'exec_command',
          permissionMode: 'basic',
          argumentsPreview: { command: 'content must not persist' },
          sideEffectLevel: 'write',
        });
      } else {
        this.event(1, 'usage_updated', {
          inputTokens: 120,
          cachedInputTokens: 100,
          outputTokens: 8,
        });
        this.event(2, 'done', { answer: EXPECTED_ANSWER, ok: true });
      }
    } else if (message.type === 'run.cancel') {
      this.event(2, 'error', { code: 'internal', message: 'cancelled' });
    } else if (message.type === 'run.event.ack') {
      this.reply({
        type: 'run.control',
        requestId: message.requestId,
        action: 'run.event.ack',
        ok: true,
        seq: message.request.seq,
      });
    }
  }

  event(seq, type, payload) {
    this.reply({
      type: 'run.event',
      event: {
        runId: RUN_ID,
        threadId: this.threadId,
        seq,
        type,
        ts: `2026-07-28T01:00:0${seq}.000Z`,
        payload,
      },
    });
  }

  reply(message) {
    queueMicrotask(() => this.emit('message', JSON.stringify(message)));
  }

  emit(name, ...args) {
    for (const listener of [...(this.listeners.get(name) ?? [])]) {
      listener(...args);
    }
  }
}

async function runProbe(t, options = {}) {
  const repoRoot = await mkdtemp(join(tmpdir(), 'geulbat-autonomy-probe-'));
  t.after(() => rm(repoRoot, { recursive: true, force: true }));
  const output = '.audit/agent-autonomy-live/test-attempt';
  let socket;
  let nowCallCount = 0;
  let result;
  let error;
  try {
    result = await runAgentAutonomyRunChannelProbe({
      argv: [
        '--base-url',
        'http://127.0.0.1:3456',
        '--model-id',
        'gpt-5.6-sol',
        '--output',
        output,
        '--timeout-ms',
        '10000',
      ],
      env: { GEULBAT_AGENT_AUTONOMY_LIVE: '1' },
      repoRoot,
      fetchImpl: async () => ({
        ok: true,
        text: async () =>
          '<meta name="geulbat-shell-access-token" content="abcdef">',
      }),
      createWebSocket: () => {
        socket = new FakeRunChannelSocket({
          approval: options.approval,
          declarationPath: join(repoRoot, output, 'declaration.json'),
          socketError: options.socketError,
          socketErrorAfterAck: options.socketErrorAfterAck,
        });
        return socket;
      },
      now: () =>
        new Date(
          nowCallCount++ === 0
            ? '2026-07-28T01:00:00.000Z'
            : '2026-07-28T01:00:10.000Z',
        ),
      log: () => {},
    });
  } catch (caught) {
    error = caught;
  }
  return { error, output: join(repoRoot, output), result, socket };
}

void test('records a content-redacted exact-answer run-channel proof', async (t) => {
  const { output, result, socket } = await runProbe(t);

  assert.equal(result.exitCode, 0);
  assert.equal(result.report.primary.passedTaskCount, 1);
  assert.equal(result.receipt.lastEventSeq, 2);
  assert.equal(result.report.supporting.providerUsage[0].inputTokens, 120);
  assert.equal(
    socket.sent.some((message) => message.type === 'run.event.ack'),
    true,
  );
  const persisted = (
    await Promise.all(
      ['declaration.json', 'workload.json', 'report.json', 'receipt.json'].map(
        (name) => readFile(join(output, name), 'utf8'),
      ),
    )
  ).join('');
  assert.equal(persisted.includes('Read the root package.json'), false);
  assert.equal(persisted.includes(EXPECTED_ANSWER), false);
  assert.equal(persisted.includes('content must not persist'), false);
});

void test('cancels and fails closed on unexpected approval', async (t) => {
  const { result, socket } = await runProbe(t, { approval: true });

  assert.equal(result.exitCode, 1);
  assert.equal(result.report.primary.passedTaskCount, 0);
  assert.equal(result.report.supporting.interventions.avoidableCount, 1);
  assert.equal(
    socket.sent.some((message) => message.type === 'run.cancel'),
    true,
  );
});

void test('surfaces an owned safe code when the run socket disappears', async (t) => {
  const { error, output } = await runProbe(t, { socketError: true });

  assert.equal(
    error instanceof Error && Reflect.get(error, 'code'),
    'run_channel_socket_error',
  );
  const receipt = JSON.parse(
    await readFile(join(output, 'failure-receipt.json'), 'utf8'),
  );
  assert.equal(receipt.phase, 'pre_run');
  assert.equal(existsSync(join(output, 'report.json')), false);
});

void test('counts a socket loss after run_ack as a failed primary attempt', async (t) => {
  const { error, output } = await runProbe(t, {
    socketErrorAfterAck: true,
  });

  assert.equal(
    error instanceof Error && Reflect.get(error, 'code'),
    'run_channel_socket_error',
  );
  const [receipt, report] = await Promise.all(
    ['failure-receipt.json', 'report.json'].map(async (name) =>
      JSON.parse(await readFile(join(output, name), 'utf8')),
    ),
  );
  assert.equal(receipt.phase, 'run');
  assert.equal(report.primary.eligibleTaskCount, 1);
  assert.equal(report.primary.passedTaskCount, 0);
});
