import { randomUUID } from 'node:crypto';

import { isRunChannelServerMessage } from '@geulbat/protocol/run-channel';
import { SHELL_ACCESS_TOKEN_META_NAME } from '@geulbat/protocol/shell-auth';
import WebSocket from 'ws';

export class RunChannelProbeError extends Error {
  constructor(code, attemptState) {
    super(code);
    this.name = 'RunChannelProbeError';
    this.code = code;
    this.attemptState = attemptState;
  }
}

export async function readRunChannelProbeShellToken(
  baseUrl,
  fetchImpl,
  timeoutMs,
) {
  let response;
  try {
    response = await fetchImpl(baseUrl, {
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    throw new RunChannelProbeError('shell_http_unavailable');
  }
  if (!response.ok) {
    throw new RunChannelProbeError(`shell_http_${response.status}`);
  }
  const html = await response.text();
  const match = new RegExp(
    `<meta name="${SHELL_ACCESS_TOKEN_META_NAME}" content="([0-9a-f]+)">`,
    'u',
  ).exec(html);
  if (match === null) {
    throw new RunChannelProbeError('shell_access_token_missing');
  }
  return match[1];
}

function runChannelUrl(baseUrl) {
  const url = new URL('/api/ws', baseUrl);
  url.protocol = 'ws:';
  return url;
}

export function collectRunChannelProbeAttempt(args) {
  const expectedThreadId = args.request.threadId;
  if (expectedThreadId === undefined) {
    throw new RunChannelProbeError('probe_thread_identity_missing');
  }
  const createWebSocket =
    args.createWebSocket ??
    ((url, socketOptions) => new WebSocket(url, socketOptions));
  const socket = createWebSocket(runChannelUrl(args.baseUrl), {
    origin: args.baseUrl.origin,
  });
  const authRequestId = randomUUID();
  let terminalAckRequestId;
  let cancelSent = false;
  let lastSeq = -1;
  let runId;
  let threadId;
  let startedAt;
  let terminal;
  let usage;
  let usageAt;
  let toolInvocationCount = 0;
  let toolFailureCount = 0;
  let toolDurationMs = 0;
  const openTools = new Map();
  const interventions = [];

  return new Promise((resolveAttempt, rejectAttempt) => {
    let settled = false;
    const snapshotAttempt = () => ({
      interventions: [...interventions],
      lastSeq,
      runId,
      startedAt,
      threadId,
      toolDurationMs,
      toolFailureCount,
      toolInvocationCount,
      usage,
      usageAt,
    });
    const cleanup = () => {
      clearTimeout(timeout);
      socket.removeAllListeners();
      socket.close();
    };
    const fail = (error) => {
      if (!settled) {
        settled = true;
        cleanup();
        rejectAttempt(
          error instanceof RunChannelProbeError
            ? new RunChannelProbeError(error.code, snapshotAttempt())
            : new RunChannelProbeError('unexpected_error', snapshotAttempt()),
        );
      }
    };
    const finish = () => {
      if (
        settled ||
        terminal === undefined ||
        startedAt === undefined ||
        runId === undefined ||
        threadId === undefined
      ) {
        return;
      }
      settled = true;
      cleanup();
      resolveAttempt({ ...snapshotAttempt(), terminal });
    };
    const timeout = setTimeout(() => {
      if (runId !== undefined && !cancelSent) {
        socket.send(
          JSON.stringify({
            type: 'run.cancel',
            requestId: randomUUID(),
            request: { runId },
          }),
        );
      }
      fail(new RunChannelProbeError('run_channel_timeout'));
    }, args.timeoutMs);

    socket.once('open', () => {
      socket.send(
        JSON.stringify({
          type: 'run.auth',
          requestId: authRequestId,
          token: args.shellToken,
        }),
      );
    });
    socket.on('message', (raw) => {
      try {
        const message = JSON.parse(String(raw));
        if (!isRunChannelServerMessage(message)) {
          throw new RunChannelProbeError('invalid_run_channel_message');
        }
        if (
          message.type === 'run.auth.ok' &&
          message.requestId === authRequestId
        ) {
          socket.send(
            JSON.stringify({
              type: 'run.start',
              requestId: randomUUID(),
              request: args.request,
            }),
          );
          return;
        }
        if (message.type === 'run.error') {
          throw new RunChannelProbeError(`run_channel_${message.code}`);
        }
        if (
          message.type === 'run.control' &&
          message.requestId === terminalAckRequestId &&
          message.action === 'run.event.ack'
        ) {
          finish();
          return;
        }
        if (message.type !== 'run.event') {
          return;
        }
        const { event } = message;
        if (event.threadId !== expectedThreadId) {
          return;
        }
        if (event.seq <= lastSeq) {
          throw new RunChannelProbeError(
            'run_channel_event_sequence_regressed',
          );
        }
        lastSeq = event.seq;
        if (event.type === 'run_ack') {
          if (
            runId !== undefined ||
            event.payload.runId !== event.runId ||
            event.payload.threadId !== event.threadId
          ) {
            throw new RunChannelProbeError('run_channel_ack_identity_mismatch');
          }
          runId = event.runId;
          threadId = event.threadId;
          startedAt = event.ts;
          return;
        }
        if (
          runId === undefined ||
          event.runId !== runId ||
          event.threadId !== threadId
        ) {
          throw new RunChannelProbeError('run_channel_event_identity_mismatch');
        }
        if (event.type === 'tool_call') {
          if (openTools.has(event.payload.callId)) {
            throw new RunChannelProbeError('run_channel_tool_call_repeated');
          }
          openTools.set(event.payload.callId, Date.parse(event.ts));
          toolInvocationCount += 1;
          return;
        }
        if (event.type === 'tool_result') {
          const openedAt = openTools.get(event.payload.callId);
          if (openedAt !== undefined) {
            toolDurationMs += Math.max(0, Date.parse(event.ts) - openedAt);
            openTools.delete(event.payload.callId);
          }
          toolFailureCount += Number(!event.payload.ok);
          return;
        }
        if (event.type === 'usage_updated') {
          usage = event.payload;
          usageAt = event.ts;
          return;
        }
        if (
          event.type === 'approval_required' ||
          event.type === 'subagent_approval_required'
        ) {
          const approval =
            event.type === 'approval_required'
              ? event.payload
              : event.payload.approval;
          interventions.push({
            kind: 'intervention_required',
            at: event.ts,
            callId: approval.callId,
            reason: 'approval_or_authority',
          });
          if (!cancelSent) {
            cancelSent = true;
            socket.send(
              JSON.stringify({
                type: 'run.cancel',
                requestId: randomUUID(),
                request: { runId },
              }),
            );
          }
          return;
        }
        if (event.type !== 'done' && event.type !== 'error') {
          return;
        }
        terminal = {
          answer:
            event.type === 'done' && event.payload.ok
              ? event.payload.answer
              : '',
          at: event.ts,
          outcome:
            event.type === 'done' && event.payload.ok ? 'completed' : 'failed',
        };
        terminalAckRequestId = randomUUID();
        socket.send(
          JSON.stringify({
            type: 'run.event.ack',
            requestId: terminalAckRequestId,
            request: { runId, threadId, seq: event.seq },
          }),
        );
      } catch (error) {
        fail(error);
      }
    });
    socket.once('error', () =>
      fail(new RunChannelProbeError('run_channel_socket_error')),
    );
    socket.once('close', () => {
      if (!settled) {
        fail(new RunChannelProbeError('run_channel_closed_before_ack'));
      }
    });
  });
}
