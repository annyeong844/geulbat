import { randomUUID } from 'node:crypto';
import { link, mkdir, open, unlink } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { sha256StableJson } from '@geulbat/content-identity/stable-json';
import {
  isRunStartRequest,
  resolveRunModelDescriptor,
} from '@geulbat/protocol/run-contract';
import { isRunChannelServerMessage } from '@geulbat/protocol/run-channel';
import { SHELL_ACCESS_TOKEN_META_NAME } from '@geulbat/protocol/shell-auth';
import WebSocket from 'ws';

import {
  createAgentAutonomyWorkloadDeclaration,
  evaluateAgentAutonomyWorkload,
} from '../../../scripts/evaluate-agent-autonomy.mjs';

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const REPO_ROOT = resolve(dirname(SCRIPT_PATH), '../../..');
const LIVE_OPT_IN_ENV = 'GEULBAT_AGENT_AUTONOMY_LIVE';
const OUTPUT_ROOT = '.audit/agent-autonomy-live';

// 첫 vertical은 정확한 외부 oracle을 가진 실제 repo read다. 더 넓은 workload를
// 대표한다고 주장하지 않고, live timeline 경로가 증명된 뒤 다음 task를 등록한다.
const TASK = Object.freeze({
  kind: 'repo_package_name_exact_answer_v1',
  prompt:
    'Read the root package.json and reply with exactly its top-level name value. Do not add quotes, markdown, or explanation.',
  expectedAnswer: 'geulbat-cli2',
  eligibilityReason: 'deterministic_repo_read_exact_answer',
  allowedPublicToolNames: Object.freeze(['read_file']),
  permissionMode: 'basic',
  reasoningEffort: 'medium',
  serviceTier: 'standard',
  interventionRules: Object.freeze([
    Object.freeze({
      reason: 'approval_or_authority',
      necessity: 'avoidable',
    }),
  ]),
});

class ProbeInputError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ProbeInputError';
  }
}

function digest(value) {
  return `sha256:${sha256StableJson(value)}`;
}

function parseArgs(argv) {
  const parsed = { preflight: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--preflight') {
      parsed.preflight = true;
      continue;
    }
    if (
      argument !== '--base-url' &&
      argument !== '--model-id' &&
      argument !== '--output' &&
      argument !== '--timeout-ms'
    ) {
      throw new ProbeInputError(`unsupported argument: ${argument}`);
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) {
      throw new ProbeInputError(`${argument} requires a value`);
    }
    index += 1;
    const key = argument.slice(2).replaceAll('-', '_');
    if (parsed[key] !== undefined) {
      throw new ProbeInputError(`${argument} may only be provided once`);
    }
    parsed[key] = value;
  }
  for (const key of ['base_url', 'model_id', 'output', 'timeout_ms']) {
    if (parsed[key] === undefined) {
      throw new ProbeInputError(`--${key.replaceAll('_', '-')} is required`);
    }
  }
  const timeoutMs = Number(parsed.timeout_ms);
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
    throw new ProbeInputError('--timeout-ms must be a positive integer');
  }
  return {
    baseUrl: parsed.base_url,
    modelId: parsed.model_id,
    output: parsed.output,
    preflight: parsed.preflight,
    timeoutMs,
  };
}

function resolveBaseUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new ProbeInputError('--base-url must be a valid URL');
  }
  if (
    url.protocol !== 'http:' ||
    !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
    url.username !== '' ||
    url.password !== ''
  ) {
    throw new ProbeInputError(
      '--base-url must be an uncredentialed loopback http URL',
    );
  }
  return new URL('/', url);
}

function resolveOutput(repoRoot, value) {
  if (isAbsolute(value)) {
    throw new ProbeInputError('--output must be repository-relative');
  }
  const output = resolve(repoRoot, value);
  const outputRoot = resolve(repoRoot, OUTPUT_ROOT);
  const relativePath = relative(outputRoot, output);
  if (
    relativePath === '' ||
    relativePath.startsWith('..') ||
    isAbsolute(relativePath)
  ) {
    throw new ProbeInputError(`--output must stay below ${OUTPUT_ROOT}`);
  }
  return output;
}

async function readShellToken(baseUrl, fetchImpl, timeoutMs) {
  const response = await fetchImpl(baseUrl, {
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) {
    throw new Error(`shell_http_${response.status}`);
  }
  const html = await response.text();
  const match = new RegExp(
    `<meta name="${SHELL_ACCESS_TOKEN_META_NAME}" content="([0-9a-f]+)">`,
    'u',
  ).exec(html);
  if (match === null) {
    throw new Error('shell_access_token_missing');
  }
  return match[1];
}

async function writeJsonNoReplace(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  let file;
  try {
    file = await open(temporaryPath, 'wx', 0o600);
    await file.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
    await file.sync();
    await file.close();
    file = undefined;
    await link(temporaryPath, path);
  } finally {
    await file?.close().catch(() => {});
    await unlink(temporaryPath).catch(() => {});
  }
}

function runChannelUrl(baseUrl) {
  const url = new URL('/api/ws', baseUrl);
  url.protocol = 'ws:';
  return url;
}

function collectAttempt(args) {
  const expectedThreadId = args.request.threadId;
  if (expectedThreadId === undefined) {
    throw new Error('probe_thread_identity_missing');
  }
  const socket = args.createWebSocket(runChannelUrl(args.baseUrl), {
    origin: args.baseUrl.origin,
  });
  const authRequestId = randomUUID();
  let terminalAckRequestId;
  let cancelSent = false;
  let lastSeq = 0;
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
    const cleanup = () => {
      clearTimeout(timeout);
      socket.removeAllListeners();
      socket.close();
    };
    const fail = (error) => {
      if (!settled) {
        settled = true;
        cleanup();
        rejectAttempt(error);
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
      resolveAttempt({
        interventions,
        lastSeq,
        runId,
        startedAt,
        terminal,
        threadId,
        toolDurationMs,
        toolFailureCount,
        toolInvocationCount,
        usage,
        usageAt,
      });
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
      fail(new Error('run_channel_timeout'));
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
          throw new Error('invalid_run_channel_message');
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
          throw new Error(`run_channel_${message.code}`);
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
        // Authentication can replay other durable runs before this probe starts.
        // The probe owns a fresh thread identity so those frames are unrelated
        // evidence, not a sequence or identity failure for this attempt.
        if (event.threadId !== expectedThreadId) {
          return;
        }
        if (event.seq <= lastSeq) {
          throw new Error('run_channel_event_sequence_regressed');
        }
        lastSeq = event.seq;
        if (event.type === 'run_ack') {
          if (
            runId !== undefined ||
            event.payload.runId !== event.runId ||
            event.payload.threadId !== event.threadId
          ) {
            throw new Error('run_channel_ack_identity_mismatch');
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
          throw new Error('run_channel_event_identity_mismatch');
        }
        if (event.type === 'tool_call') {
          if (openTools.has(event.payload.callId)) {
            throw new Error('run_channel_tool_call_repeated');
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
            interventionReferenceId: digest({
              runId,
              callId: approval.callId,
            }),
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
        const answer =
          event.type === 'done' && event.payload.ok
            ? event.payload.answer.trim()
            : '';
        terminal = {
          answerMatched:
            event.type === 'done' &&
            event.payload.ok &&
            answer === TASK.expectedAnswer,
          at: event.ts,
          observedAnswerReferenceId: digest(answer),
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
    socket.once('error', () => fail(new Error('run_channel_socket_error')));
    socket.once('close', () => {
      if (!settled) {
        fail(new Error('run_channel_closed_before_ack'));
      }
    });
  });
}

function buildWorkload({ attemptReference, declaration, providerId, run }) {
  const taskReferenceId = declaration.tasks[0].taskReferenceId;
  const oracleEvidenceReferenceId = digest({
    oracleKind: 'exact_answer',
    attemptReference,
    runId: run.runId,
    threadId: run.threadId,
    expectedAnswerReferenceId: digest(TASK.expectedAnswer),
    observedAnswerReferenceId: run.terminal.observedAnswerReferenceId,
    answerMatched: run.terminal.answerMatched,
    terminalOutcome: run.terminal.outcome,
  });
  const observations = [
    { kind: 'run_started', at: run.startedAt },
    ...run.interventions,
    ...(run.usage === undefined
      ? []
      : [
          {
            kind: 'provider_usage',
            at: run.usageAt,
            providerReferenceId: providerId,
            inputTokens: run.usage.inputTokens,
            cachedInputTokens: run.usage.cachedInputTokens,
            outputTokens: run.usage.outputTokens,
            costMicrousd: null,
          },
        ]),
    ...(run.toolInvocationCount === 0
      ? []
      : [
          {
            kind: 'tool_usage',
            at: run.terminal.at,
            toolInvocationCount: run.toolInvocationCount,
            toolFailureCount: run.toolFailureCount,
            observedDurationMs: run.toolDurationMs,
          },
        ]),
    ...(run.terminal.answerMatched
      ? [
          {
            kind: 'progress_verified',
            at: run.terminal.at,
            evidenceReferenceId: oracleEvidenceReferenceId,
          },
        ]
      : []),
  ].sort((left, right) => Date.parse(left.at) - Date.parse(right.at));
  observations.push({
    kind: 'run_terminal',
    at: run.terminal.at,
    outcome: run.terminal.outcome,
  });
  return {
    schemaVersion: 1,
    workloadKind: 'agent_autonomy_workload',
    workloadReferenceId: declaration.workloadReferenceId,
    registeredAt: declaration.registeredAt,
    tasks: declaration.tasks,
    attempts: [
      {
        attemptReference,
        taskReferenceId,
        oracle: {
          outcome: run.terminal.answerMatched
            ? 'verified_completed'
            : 'verified_failed',
          evidenceReferenceId: oracleEvidenceReferenceId,
        },
        observations,
      },
    ],
  };
}

export async function runAgentAutonomyRunChannelProbe(options = {}) {
  const parsed = parseArgs(options.argv ?? process.argv.slice(2));
  const env = options.env ?? process.env;
  const repoRoot = options.repoRoot ?? REPO_ROOT;
  const baseUrl = resolveBaseUrl(parsed.baseUrl);
  const output = resolveOutput(repoRoot, parsed.output);
  const model = resolveRunModelDescriptor(parsed.modelId);
  const requestedThreadId = randomUUID();
  const request = {
    prompt: TASK.prompt,
    threadId: requestedThreadId,
    workingDirectory: repoRoot,
    modelId: model.id,
    allowedPublicToolNames: [...TASK.allowedPublicToolNames],
    permissionMode: TASK.permissionMode,
    reasoningEffort: TASK.reasoningEffort,
    serviceTier: TASK.serviceTier,
  };
  if (!isRunStartRequest(request)) {
    throw new ProbeInputError('probe task does not form a valid run request');
  }
  const fetchImpl = options.fetchImpl ?? fetch;
  const shellToken = await readShellToken(baseUrl, fetchImpl, parsed.timeoutMs);
  const preflight = {
    schemaVersion: 1,
    kind: 'agent_autonomy_run_channel_preflight',
    endpointScopeReferenceId: digest(baseUrl.origin),
    modelId: model.id,
    providerId: model.providerId,
    liveOptInPresent: env[LIVE_OPT_IN_ENV] === '1',
    shellAccessTokenPresent: shellToken !== '',
  };
  if (parsed.preflight) {
    (options.log ?? console.log)(JSON.stringify(preflight));
    return { exitCode: 0, preflight };
  }
  if (!preflight.liveOptInPresent) {
    throw new ProbeInputError(`live execution requires ${LIVE_OPT_IN_ENV}=1`);
  }

  const now = options.now ?? (() => new Date());
  const registeredAt = now().toISOString();
  const taskReferenceId = digest({
    taskKind: TASK.kind,
    promptReferenceId: digest(TASK.prompt),
    expectedAnswerReferenceId: digest(TASK.expectedAnswer),
    workingDirectoryReferenceId: digest(repoRoot),
    endpointScopeReferenceId: preflight.endpointScopeReferenceId,
    modelId: model.id,
    providerId: model.providerId,
    allowedPublicToolNames: TASK.allowedPublicToolNames,
    permissionMode: TASK.permissionMode,
    reasoningEffort: TASK.reasoningEffort,
    serviceTier: TASK.serviceTier,
  });
  const attemptReference = digest({ taskReferenceId, registeredAt });
  const declaration = createAgentAutonomyWorkloadDeclaration({
    schemaVersion: 1,
    workloadKind: 'agent_autonomy_workload_declaration',
    registeredAt,
    tasks: [
      {
        taskReferenceId,
        eligibility: 'eligible',
        eligibilityReason: TASK.eligibilityReason,
        attemptReferences: [attemptReference],
        interventionRules: TASK.interventionRules,
      },
    ],
  });
  await writeJsonNoReplace(resolve(output, 'declaration.json'), declaration);

  const createWebSocket =
    options.createWebSocket ??
    ((url, socketOptions) => new WebSocket(url, socketOptions));
  const run = await collectAttempt({
    baseUrl,
    createWebSocket,
    request,
    shellToken,
    timeoutMs: parsed.timeoutMs,
  });
  const workload = buildWorkload({
    attemptReference,
    declaration,
    providerId: model.providerId,
    run,
  });
  const report = evaluateAgentAutonomyWorkload(workload);
  const receipt = {
    schemaVersion: 1,
    kind: 'agent_autonomy_run_channel_probe_receipt',
    capturedAt: now().toISOString(),
    workloadReferenceId: declaration.workloadReferenceId,
    taskReferenceId,
    attemptReference,
    endpointScopeReferenceId: preflight.endpointScopeReferenceId,
    modelId: model.id,
    providerId: model.providerId,
    runId: run.runId,
    threadId: run.threadId,
    lastEventSeq: run.lastSeq,
    answerMatched: run.terminal.answerMatched,
    terminalOutcome: run.terminal.outcome,
  };
  await writeJsonNoReplace(resolve(output, 'workload.json'), workload);
  await writeJsonNoReplace(resolve(output, 'report.json'), report);
  await writeJsonNoReplace(resolve(output, 'receipt.json'), receipt);
  (options.log ?? console.log)(
    JSON.stringify({
      kind: 'agent_autonomy_run_channel_probe_completed',
      output: relative(repoRoot, output),
      passed: report.primary.passedTaskCount === 1,
      answerMatched: receipt.answerMatched,
      terminalOutcome: receipt.terminalOutcome,
    }),
  );
  return {
    exitCode: report.primary.passedTaskCount === 1 ? 0 : 1,
    declaration,
    report,
    receipt,
    workload,
  };
}

function safeError(error) {
  if (error instanceof ProbeInputError) {
    return error.message;
  }
  const code =
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof error.code === 'string'
      ? error.code
      : 'unexpected_error';
  return `agent autonomy run-channel probe failed (${code})`;
}

const isMain =
  process.argv[1] !== undefined && SCRIPT_PATH === resolve(process.argv[1]);

if (isMain) {
  runAgentAutonomyRunChannelProbe()
    .then(({ exitCode }) => {
      process.exitCode = exitCode;
    })
    .catch((error) => {
      process.stderr.write(`${safeError(error)}\n`);
      process.exitCode = 1;
    });
}
