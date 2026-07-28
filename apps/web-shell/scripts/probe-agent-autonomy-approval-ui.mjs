import { createHash, randomUUID } from 'node:crypto';
import { link, mkdir, open, readFile, unlink } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

import { chromium } from 'playwright';

import {
  createAgentAutonomyWorkloadDeclaration,
  evaluateAgentAutonomyWorkload,
} from '../../../scripts/evaluate-agent-autonomy.mjs';

const LIVE_OPT_IN_ENV = 'GEULBAT_AGENT_AUTONOMY_APPROVAL_UI_LIVE';
const OUTPUT_ROOT = '.audit';
const EXPECTED_TOOL = 'write_file';
const EXPECTED_ANSWER = 'APPROVAL_UI_R2_COMPLETE';
const repoRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
);

export class ApprovalUiProbeInputError extends Error {}

function digest(value) {
  return `sha256:${createHash('sha256')
    .update(JSON.stringify(value))
    .digest('hex')}`;
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function parseFrame(payload) {
  try {
    const parsed = JSON.parse(
      typeof payload === 'string' ? payload : payload.toString('utf8'),
    );
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function canonicalTimestamp(value) {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.valueOf())) {
    throw new ApprovalUiProbeInputError(
      `invalid observation timestamp: ${value}`,
    );
  }
  return parsed.toISOString();
}

function terminalOutcome(event) {
  if (event.type === 'done') {
    return event.payload?.ok === true ? 'completed' : 'failed';
  }
  return 'failed';
}

function eventMatchesRun(event, state) {
  return (
    state.runId !== null &&
    event.runId === state.runId &&
    event.threadId === state.threadId
  );
}

/**
 * Observes the web-shell's actual run-channel frames. It never sends frames and
 * deliberately exposes no approval action.
 */
export function createApprovalUiFrameObserver(options) {
  const now = options.now ?? (() => new Date());
  const violations = [];
  const toolCalls = [];
  const toolResults = [];
  const sideEffects = [];
  const state = {
    armed: false,
    runStartObserved: false,
    startedAt: null,
    runId: null,
    threadId: null,
    lastSeq: -1,
    approvalRequiredAt: null,
    approvalResolvedAt: null,
    approvalReferenceId: null,
    approvalCallId: null,
    usage: null,
    usageAt: null,
    terminal: null,
  };
  let resolveTerminal;
  const terminalPromise = new Promise((resolvePromise) => {
    resolveTerminal = resolvePromise;
  });

  function at(value) {
    return canonicalTimestamp(value ?? now().toISOString());
  }

  function recordViolation(code) {
    if (!violations.includes(code)) {
      violations.push(code);
    }
  }

  function observeSent(payload, observedAt) {
    if (!state.armed) {
      return;
    }
    const message = parseFrame(payload);
    if (message === null) {
      return;
    }
    if (message.type === 'run.start') {
      if (state.runStartObserved) {
        recordViolation('multiple_run_start_frames');
        return;
      }
      if (
        !isRecord(message.request) ||
        message.request.prompt !== options.expectedPrompt ||
        message.request.modelId !== options.expectedModelId ||
        message.request.permissionMode !== 'basic' ||
        message.request.reasoningEffort !== options.expectedReasoningEffort ||
        message.request.serviceTier !== options.expectedServiceTier
      ) {
        recordViolation('run_start_contract_mismatch');
        return;
      }
      state.runStartObserved = true;
      return;
    }
    if (message.type !== 'run.approve' || !state.runStartObserved) {
      return;
    }
    if (
      state.approvalRequiredAt === null ||
      !isRecord(message.request) ||
      message.request.callId !== state.approvalCallId ||
      message.request.runId !== state.runId ||
      message.request.threadId !== state.threadId
    ) {
      recordViolation('approval_decision_identity_mismatch');
      return;
    }
    if (state.approvalResolvedAt !== null) {
      recordViolation('multiple_approval_decisions');
      return;
    }
    if (
      message.request.approved !== true ||
      message.request.grantScope !== 'once'
    ) {
      recordViolation('approval_decision_not_once_allow');
      return;
    }
    state.approvalResolvedAt = at(observedAt);
  }

  function observeReceived(payload, observedAt) {
    if (!state.armed) {
      return;
    }
    const message = parseFrame(payload);
    if (
      message === null ||
      message.type !== 'run.event' ||
      !isRecord(message.event)
    ) {
      return;
    }
    const event = message.event;
    if (
      event.type === 'run_ack' &&
      state.runStartObserved &&
      state.runId === null
    ) {
      state.runId = event.runId;
      state.threadId = event.threadId;
      state.lastSeq = event.seq;
      state.startedAt = canonicalTimestamp(event.ts ?? observedAt);
      return;
    }
    if (!eventMatchesRun(event, state)) {
      return;
    }
    if (Number.isInteger(event.seq)) {
      state.lastSeq = Math.max(state.lastSeq, event.seq);
    }
    const eventAt = canonicalTimestamp(event.ts ?? observedAt);
    if (event.type === 'tool_call') {
      const args = isRecord(event.payload?.args) ? event.payload.args : {};
      const argsMatched =
        args.path === options.expectedFilePath &&
        args.content === options.expectedFileContent &&
        !Object.hasOwn(args, 'versionToken');
      toolCalls.push({
        at: eventAt,
        callId: event.payload?.callId,
        tool: event.payload?.tool,
        argsMatched,
      });
      if (event.payload?.tool !== EXPECTED_TOOL || !argsMatched) {
        recordViolation('unexpected_tool_call');
      }
      return;
    }
    if (event.type === 'approval_required') {
      if (state.approvalRequiredAt !== null) {
        recordViolation('multiple_approval_requests');
        return;
      }
      if (
        event.payload?.toolName !== EXPECTED_TOOL ||
        event.payload?.callId !== toolCalls[0]?.callId ||
        event.payload?.runId !== state.runId ||
        event.payload?.threadId !== state.threadId
      ) {
        recordViolation('approval_request_contract_mismatch');
        return;
      }
      state.approvalRequiredAt = eventAt;
      state.approvalCallId = event.payload.callId;
      state.approvalReferenceId = digest({
        runId: state.runId,
        callId: state.approvalCallId,
        kind: 'manual_write_approval',
      });
      options.onApprovalRequired?.({
        approvalReferenceId: state.approvalReferenceId,
        at: eventAt,
      });
      return;
    }
    if (event.type === 'tool_result') {
      const matchingCall = toolCalls.find(
        (call) => call.callId === event.payload?.callId,
      );
      const ok =
        event.payload?.ok === true &&
        event.payload?.tool === EXPECTED_TOOL &&
        matchingCall?.argsMatched === true;
      toolResults.push({
        at: eventAt,
        callId: event.payload?.callId,
        ok,
      });
      if (!ok) {
        recordViolation('tool_result_failed_or_mismatched');
      } else {
        sideEffects.push({
          at: eventAt,
          sideEffectReferenceId: digest({
            runId: state.runId,
            callId: event.payload.callId,
            tool: EXPECTED_TOOL,
          }),
        });
      }
      return;
    }
    if (event.type === 'usage_updated') {
      const usage = event.payload;
      if (
        Number.isInteger(usage?.inputTokens) &&
        Number.isInteger(usage?.cachedInputTokens) &&
        Number.isInteger(usage?.outputTokens)
      ) {
        state.usage = {
          inputTokens: usage.inputTokens,
          cachedInputTokens: usage.cachedInputTokens,
          outputTokens: usage.outputTokens,
        };
        state.usageAt = eventAt;
      }
      return;
    }
    if (event.type === 'done' || event.type === 'error') {
      const answer =
        event.type === 'done' && typeof event.payload?.answer === 'string'
          ? event.payload.answer.trim()
          : '';
      state.terminal = {
        answerMatched:
          event.type === 'done' &&
          event.payload?.ok === true &&
          answer === options.expectedAnswer,
        at: eventAt,
        observedAnswerReferenceId: digest(answer),
        outcome: terminalOutcome(event),
      };
      resolveTerminal();
    }
  }

  function snapshot() {
    if (
      state.startedAt === null ||
      state.runId === null ||
      state.threadId === null ||
      state.terminal === null
    ) {
      throw new Error('approval UI observation is not terminal');
    }
    if (toolCalls.length !== 1) {
      recordViolation('tool_invocation_count_mismatch');
    }
    if (toolResults.length !== 1) {
      recordViolation('tool_result_count_mismatch');
    }
    if (
      state.approvalRequiredAt === null ||
      state.approvalResolvedAt === null ||
      state.approvalReferenceId === null
    ) {
      recordViolation('manual_approval_incomplete');
    }
    const toolDurationMs = toolResults.reduce((total, result) => {
      const call = toolCalls.find((entry) => entry.callId === result.callId);
      return (
        total +
        (call === undefined
          ? 0
          : Math.max(0, Date.parse(result.at) - Date.parse(call.at)))
      );
    }, 0);
    return Object.freeze({
      runId: state.runId,
      threadId: state.threadId,
      lastSeq: state.lastSeq,
      startedAt: state.startedAt,
      approval: Object.freeze({
        requiredAt: state.approvalRequiredAt,
        resolvedAt: state.approvalResolvedAt,
        interventionReferenceId: state.approvalReferenceId,
      }),
      sideEffects: Object.freeze(
        sideEffects.map((sideEffect) => Object.freeze({ ...sideEffect })),
      ),
      toolInvocationCount: toolCalls.length,
      toolFailureCount: toolResults.filter((result) => !result.ok).length,
      toolDurationMs,
      usage: state.usage === null ? undefined : Object.freeze(state.usage),
      usageAt: state.usageAt,
      terminal: Object.freeze(state.terminal),
      violations: Object.freeze([...violations]),
    });
  }

  return Object.freeze({
    arm() {
      state.armed = true;
    },
    observeReceived,
    observeSent,
    fail(failedAt, failureCode) {
      if (
        state.startedAt === null ||
        state.runId === null ||
        state.threadId === null
      ) {
        return null;
      }
      recordViolation(failureCode);
      if (state.terminal === null) {
        state.terminal = {
          answerMatched: false,
          at: at(failedAt),
          observedAnswerReferenceId: digest(''),
          outcome: 'failed',
        };
      }
      return snapshot();
    },
    snapshot,
    waitForTerminal() {
      return terminalPromise;
    },
  });
}

function buildWorkload({
  attemptReference,
  declaration,
  providerId,
  run,
  oracle,
}) {
  const observations = [
    { kind: 'run_started', at: run.startedAt },
    ...(run.approval.requiredAt === null
      ? []
      : [
          {
            kind: 'intervention_required',
            at: run.approval.requiredAt,
            interventionReferenceId: run.approval.interventionReferenceId,
            reason: 'approval_or_authority',
          },
        ]),
    ...(run.approval.resolvedAt === null
      ? []
      : [
          {
            kind: 'intervention_resolved',
            at: run.approval.resolvedAt,
            interventionReferenceId: run.approval.interventionReferenceId,
          },
        ]),
    ...run.sideEffects.map((sideEffect) => ({
      kind: 'side_effect_committed',
      at: sideEffect.at,
      sideEffectReferenceId: sideEffect.sideEffectReferenceId,
    })),
    ...(run.usage === undefined
      ? []
      : [
          {
            kind: 'provider_usage',
            at: run.usageAt ?? run.terminal.at,
            providerReferenceId: providerId,
            inputTokens: run.usage.inputTokens,
            cachedInputTokens: run.usage.cachedInputTokens,
            outputTokens: run.usage.outputTokens,
            costMicrousd: null,
          },
        ]),
    {
      kind: 'tool_usage',
      at: run.terminal.at,
      toolInvocationCount: run.toolInvocationCount,
      toolFailureCount: run.toolFailureCount,
      observedDurationMs: run.toolDurationMs,
    },
    ...(oracle.outcome === 'verified_completed'
      ? [
          {
            kind: 'progress_verified',
            at: oracle.verifiedAt,
            evidenceReferenceId: oracle.evidenceReferenceId,
          },
        ]
      : []),
  ].sort((left, right) => Date.parse(left.at) - Date.parse(right.at));
  observations.push({
    kind: 'run_terminal',
    at: oracle.verifiedAt,
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
        taskReferenceId: declaration.tasks[0].taskReferenceId,
        oracle: {
          outcome: oracle.outcome,
          evidenceReferenceId: oracle.evidenceReferenceId,
        },
        observations,
      },
    ],
  };
}

export function createApprovalUiProbeArtifacts(options) {
  const oracleEvidenceReferenceId = digest({
    oracleKind: 'exact_isolated_write_and_answer',
    attemptReference: options.attemptReference,
    runId: options.run.runId,
    threadId: options.run.threadId,
    expectedFilePathReferenceId: options.expectedFilePathReferenceId,
    expectedFileContentReferenceId: options.expectedFileContentReferenceId,
    observedFileContentReferenceId: options.observedFileContentReferenceId,
    fileMatched: options.fileMatched,
    expectedAnswerReferenceId: digest(EXPECTED_ANSWER),
    observedAnswerReferenceId: options.run.terminal.observedAnswerReferenceId,
    answerMatched: options.run.terminal.answerMatched,
    terminalOutcome: options.run.terminal.outcome,
    toolInvocationCount: options.run.toolInvocationCount,
    toolFailureCount: options.run.toolFailureCount,
    violationReferenceIds: options.run.violations.map(digest),
  });
  const verified =
    options.fileMatched &&
    options.run.terminal.answerMatched &&
    options.run.terminal.outcome === 'completed' &&
    options.run.toolInvocationCount === 1 &&
    options.run.toolFailureCount === 0 &&
    options.run.sideEffects.length === 1 &&
    options.run.violations.length === 0;
  const workload = buildWorkload({
    attemptReference: options.attemptReference,
    declaration: options.declaration,
    providerId: options.providerId,
    run: options.run,
    oracle: {
      outcome: verified ? 'verified_completed' : 'verified_failed',
      evidenceReferenceId: oracleEvidenceReferenceId,
      verifiedAt: options.verifiedAt,
    },
  });
  return Object.freeze({
    workload,
    report: evaluateAgentAutonomyWorkload(workload),
    oracleEvidenceReferenceId,
    verified,
  });
}

function parseCliArgs(argv) {
  const parsed = { preflight: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--preflight') {
      parsed.preflight = true;
      continue;
    }
    const supported = new Set([
      '--base-url',
      '--cdp-url',
      '--model-id',
      '--model-label',
      '--output',
      '--provider-id',
      '--reasoning-effort',
      '--service-tier',
      '--timeout-ms',
      '--working-directory',
    ]);
    if (!supported.has(argument)) {
      throw new ApprovalUiProbeInputError(`unsupported argument: ${argument}`);
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) {
      throw new ApprovalUiProbeInputError(`${argument} requires a value`);
    }
    index += 1;
    const key = argument.slice(2).replaceAll('-', '_');
    if (parsed[key] !== undefined) {
      throw new ApprovalUiProbeInputError(
        `${argument} may only be provided once`,
      );
    }
    parsed[key] = value;
  }
  for (const key of [
    'base_url',
    'cdp_url',
    'model_id',
    'model_label',
    'output',
    'provider_id',
    'reasoning_effort',
    'service_tier',
    'timeout_ms',
    'working_directory',
  ]) {
    if (parsed[key] === undefined) {
      throw new ApprovalUiProbeInputError(
        `--${key.replaceAll('_', '-')} is required`,
      );
    }
  }
  const timeoutMs = Number(parsed.timeout_ms);
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
    throw new ApprovalUiProbeInputError(
      '--timeout-ms must be a positive integer',
    );
  }
  if (
    parsed.model_id !== 'gpt-5.6-sol' ||
    parsed.model_label !== 'GPT-5.6 Sol' ||
    parsed.provider_id !== 'openai_codex_direct' ||
    parsed.reasoning_effort !== 'medium' ||
    parsed.service_tier !== 'standard'
  ) {
    throw new ApprovalUiProbeInputError(
      'R2 requires GPT-5.6 Sol OAuth with medium reasoning and standard service',
    );
  }
  return { ...parsed, timeoutMs };
}

function resolveHttpUrl(value, label, { loopbackOnly }) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new ApprovalUiProbeInputError(`${label} must be a valid URL`);
  }
  if (
    url.protocol !== 'http:' ||
    url.username !== '' ||
    url.password !== '' ||
    (loopbackOnly &&
      !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))
  ) {
    throw new ApprovalUiProbeInputError(
      `${label} must be an uncredentialed ${
        loopbackOnly ? 'loopback ' : ''
      }http URL`,
    );
  }
  return url;
}

function resolveOutput(value) {
  if (isAbsolute(value)) {
    throw new ApprovalUiProbeInputError('--output must be repository-relative');
  }
  const output = resolve(repoRoot, value);
  const outputRoot = resolve(repoRoot, OUTPUT_ROOT);
  const relativePath = relative(outputRoot, output);
  if (
    relativePath === '' ||
    relativePath.startsWith('..') ||
    isAbsolute(relativePath)
  ) {
    throw new ApprovalUiProbeInputError(
      `--output must stay below ${OUTPUT_ROOT}`,
    );
  }
  return output;
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

async function readObservedFileContent(markerPath) {
  try {
    return await readFile(markerPath, 'utf8');
  } catch {
    return null;
  }
}

function failureCode(error) {
  if (
    error instanceof Error &&
    error.message === 'approval UI probe timed out before terminal event'
  ) {
    return 'probe_timeout';
  }
  return 'probe_failed';
}

async function selectProbeUiState(page, options) {
  await page.getByRole('button', { name: '새 세션', exact: true }).click();

  const locationButton = page.locator('button.composer-context-bar');
  await locationButton.waitFor({ state: 'visible' });
  const locationTitle = await locationButton.getAttribute('title');
  if (locationTitle !== `시작 위치: ${options.workingDirectory}`) {
    throw new Error(
      `visible web-shell working directory mismatch: ${locationTitle ?? 'missing'}`,
    );
  }

  const approvalButton = page.getByTitle('승인 방식', { exact: true });
  if (!(await approvalButton.textContent())?.includes('수동 승인')) {
    await approvalButton.click();
    await page
      .getByRole('menuitem')
      .filter({ hasText: /^수동 승인/u })
      .click();
  }

  const modelButton = page.getByTitle('모델, 사고 강도와 속도', {
    exact: true,
  });
  if (!(await modelButton.textContent())?.includes(options.modelLabel)) {
    await modelButton.click();
    await page
      .getByRole('menuitem')
      .filter({
        hasText: new RegExp(`^${escapeRegExp(options.modelLabel)}`, 'u'),
      })
      .click();
  }
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

export async function attachRunChannelCdpObserver({
  context,
  now = () => new Date(),
  observer,
  page,
}) {
  const session = await context.newCDPSession(page);
  const runChannelRequestIds = new Set();
  let observedSocketCount = 0;
  session.on('Network.webSocketCreated', ({ requestId, url }) => {
    if (new URL(url).pathname !== '/api/ws') {
      return;
    }
    runChannelRequestIds.add(requestId);
    observedSocketCount += 1;
  });
  session.on(
    'Network.webSocketFrameSent',
    ({ requestId, response: { payloadData } }) => {
      if (
        runChannelRequestIds.has(requestId) &&
        typeof payloadData === 'string'
      ) {
        observer.observeSent(payloadData, now().toISOString());
      }
    },
  );
  session.on(
    'Network.webSocketFrameReceived',
    ({ requestId, response: { payloadData } }) => {
      if (
        runChannelRequestIds.has(requestId) &&
        typeof payloadData === 'string'
      ) {
        observer.observeReceived(payloadData, now().toISOString());
      }
    },
  );
  await session.send('Network.enable');
  return Object.freeze({
    observedSocketCount() {
      return observedSocketCount;
    },
    async close() {
      await session.detach();
    },
  });
}

export async function runAgentAutonomyApprovalUiProbe(options = {}) {
  const argv = options.argv ?? process.argv.slice(2);
  const env = options.env ?? process.env;
  const parsed = parseCliArgs(argv);
  const baseUrl = resolveHttpUrl(parsed.base_url, '--base-url', {
    loopbackOnly: true,
  });
  const cdpUrl = resolveHttpUrl(parsed.cdp_url, '--cdp-url', {
    loopbackOnly: false,
  });
  const output = resolveOutput(parsed.output);
  const preflight = {
    schemaVersion: 1,
    kind: 'agent_autonomy_approval_ui_preflight',
    endpointScopeReferenceId: digest(baseUrl.origin),
    cdpEndpointScopeReferenceId: digest(cdpUrl.origin),
    liveOptInPresent: env[LIVE_OPT_IN_ENV] === '1',
    modelId: parsed.model_id,
    providerId: parsed.provider_id,
    reasoningEffort: parsed.reasoning_effort,
    serviceTier: parsed.service_tier,
  };
  if (parsed.preflight) {
    (options.log ?? console.log)(JSON.stringify(preflight));
    return { exitCode: 0, preflight };
  }
  if (!preflight.liveOptInPresent) {
    throw new ApprovalUiProbeInputError(
      `live execution requires ${LIVE_OPT_IN_ENV}=1`,
    );
  }

  const now = options.now ?? (() => new Date());
  const registeredAt = now().toISOString();
  const attemptSeed = randomUUID();
  const markerPath = resolve(output, 'workspace', 'approval-marker.txt');
  const markerContent = `geulbat-approval-ui-r2:${attemptSeed}\n`;
  const prompt = [
    `Use exactly one ${EXPECTED_TOOL} tool call.`,
    `Create the new file at ${markerPath}.`,
    `Write this exact JSON string value as its complete content: ${JSON.stringify(markerContent)}.`,
    'Do not call any other tool and do not perform any other action.',
    `After the tool succeeds, reply exactly: ${EXPECTED_ANSWER}`,
  ].join(' ');
  const taskReferenceId = digest({
    taskKind: 'manual_write_approval_ui_vertical',
    promptReferenceId: digest(prompt),
    expectedFilePathReferenceId: digest(markerPath),
    expectedFileContentReferenceId: digest(markerContent),
    endpointScopeReferenceId: preflight.endpointScopeReferenceId,
    modelId: parsed.model_id,
    providerId: parsed.provider_id,
    reasoningEffort: parsed.reasoning_effort,
    serviceTier: parsed.service_tier,
  });
  const attemptReference = digest({
    taskReferenceId,
    registeredAt,
    attemptSeed,
  });
  const declaration = createAgentAutonomyWorkloadDeclaration({
    schemaVersion: 1,
    workloadKind: 'agent_autonomy_workload_declaration',
    registeredAt,
    tasks: [
      {
        taskReferenceId,
        eligibility: 'eligible',
        eligibilityReason: 'manual_write_approval_ui_vertical',
        attemptReferences: [attemptReference],
        interventionRules: [
          { reason: 'approval_or_authority', necessity: 'justified' },
        ],
      },
    ],
  });
  await writeJsonNoReplace(resolve(output, 'declaration.json'), declaration);

  const observer = createApprovalUiFrameObserver({
    expectedAnswer: EXPECTED_ANSWER,
    expectedFileContent: markerContent,
    expectedFilePath: markerPath,
    expectedModelId: parsed.model_id,
    expectedPrompt: prompt,
    expectedReasoningEffort: parsed.reasoning_effort,
    expectedServiceTier: parsed.service_tier,
    now,
    onApprovalRequired: () => {
      (options.log ?? console.log)(
        JSON.stringify({
          kind: 'agent_autonomy_approval_ui_waiting_for_user',
          action: 'click_visible_allow_once',
        }),
      );
    },
  });
  let browser;
  let page;
  let runChannelObservation;

  try {
    browser =
      options.connectOverCDP === undefined
        ? await chromium.connectOverCDP(cdpUrl.toString())
        : await options.connectOverCDP(cdpUrl.toString());
    const context = browser.contexts()[0];
    if (context === undefined) {
      throw new Error('CDP browser did not expose a browser context');
    }
    page = await context.newPage();
    await page.addInitScript(
      ({ modelId, reasoningEffort, serviceTier, workingDirectory }) => {
        globalThis.localStorage.setItem(
          'geulbat.shell.run-session-preferences.v1',
          JSON.stringify({
            version: 1,
            preferences: {
              workingDirectory,
              planModeRequested: false,
              planModeIntensity: 'visual',
              planModeDepth: 'standard',
              modelId,
              reasoningEffort,
              serviceTier,
              subagentModelRouting: { mode: 'auto' },
            },
          }),
        );
      },
      {
        modelId: parsed.model_id,
        reasoningEffort: parsed.reasoning_effort,
        serviceTier: parsed.service_tier,
        workingDirectory: parsed.working_directory,
      },
    );
    runChannelObservation = await attachRunChannelCdpObserver({
      context,
      now,
      observer,
      page,
    });
    await page.goto(baseUrl.toString(), { waitUntil: 'domcontentloaded' });
    await selectProbeUiState(page, {
      modelLabel: parsed.model_label,
      workingDirectory: parsed.working_directory,
    });
    if (runChannelObservation.observedSocketCount() === 0) {
      throw new Error('visible web-shell did not open the run-channel socket');
    }
    observer.arm();
    const promptInput = page.locator(
      'textarea[placeholder*="어시스턴트에게 물어보거나 부탁하기"]',
    );
    await promptInput.fill(prompt);
    await page.getByRole('button', { name: '보내기', exact: true }).click();
    const timeoutController = new AbortController();
    try {
      await Promise.race([
        observer.waitForTerminal(),
        delay(parsed.timeoutMs, undefined, {
          signal: timeoutController.signal,
        }).then(() => {
          throw new Error('approval UI probe timed out before terminal event');
        }),
      ]);
    } finally {
      timeoutController.abort();
    }
    const run = observer.snapshot();
    const observedFileContent = await readObservedFileContent(markerPath);
    const verifiedAt = now().toISOString();
    const artifacts = createApprovalUiProbeArtifacts({
      attemptReference,
      declaration,
      expectedFileContentReferenceId: digest(markerContent),
      expectedFilePathReferenceId: digest(markerPath),
      fileMatched: observedFileContent === markerContent,
      observedFileContentReferenceId: digest(observedFileContent),
      providerId: parsed.provider_id,
      run,
      verifiedAt,
    });
    const receipt = {
      schemaVersion: 1,
      kind: 'agent_autonomy_approval_ui_probe_receipt',
      capturedAt: verifiedAt,
      workloadReferenceId: declaration.workloadReferenceId,
      taskReferenceId,
      attemptReference,
      endpointScopeReferenceId: preflight.endpointScopeReferenceId,
      cdpEndpointScopeReferenceId: preflight.cdpEndpointScopeReferenceId,
      expectedFilePathReferenceId: digest(markerPath),
      expectedFileContentReferenceId: digest(markerContent),
      observedFileContentReferenceId: digest(observedFileContent),
      oracleEvidenceReferenceId: artifacts.oracleEvidenceReferenceId,
      runId: run.runId,
      threadId: run.threadId,
      lastEventSeq: run.lastSeq,
      manualApprovalObserved:
        run.approval.requiredAt !== null && run.approval.resolvedAt !== null,
      answerMatched: run.terminal.answerMatched,
      fileMatched: observedFileContent === markerContent,
      terminalOutcome: run.terminal.outcome,
      violationReferenceIds: run.violations.map(digest),
    };
    await writeJsonNoReplace(
      resolve(output, 'workload.json'),
      artifacts.workload,
    );
    await writeJsonNoReplace(resolve(output, 'report.json'), artifacts.report);
    await writeJsonNoReplace(resolve(output, 'receipt.json'), receipt);
    (options.log ?? console.log)(
      JSON.stringify({
        kind: 'agent_autonomy_approval_ui_probe_completed',
        output: relative(repoRoot, output),
        passed: artifacts.report.primary.passedTaskCount === 1,
        manualApprovalObserved: receipt.manualApprovalObserved,
      }),
    );
    return {
      exitCode: artifacts.report.primary.passedTaskCount === 1 ? 0 : 1,
      report: artifacts.report,
      receipt,
    };
  } catch (error) {
    const capturedAt = now().toISOString();
    const code = failureCode(error);
    const run = observer.fail(capturedAt, code);
    const failureReceipt = {
      schemaVersion: 1,
      kind: 'agent_autonomy_approval_ui_probe_failure_receipt',
      capturedAt,
      workloadReferenceId: declaration.workloadReferenceId,
      taskReferenceId,
      attemptReference,
      endpointScopeReferenceId: preflight.endpointScopeReferenceId,
      cdpEndpointScopeReferenceId: preflight.cdpEndpointScopeReferenceId,
      phase: run === null ? 'pre_run' : 'run',
      failureCode: code,
      ...(run === null
        ? {}
        : {
            runId: run.runId,
            threadId: run.threadId,
            lastEventSeq: run.lastSeq,
          }),
    };
    await writeJsonNoReplace(
      resolve(output, 'failure-receipt.json'),
      failureReceipt,
    );
    if (run !== null) {
      const observedFileContent = await readObservedFileContent(markerPath);
      const artifacts = createApprovalUiProbeArtifacts({
        attemptReference,
        declaration,
        expectedFileContentReferenceId: digest(markerContent),
        expectedFilePathReferenceId: digest(markerPath),
        fileMatched: observedFileContent === markerContent,
        observedFileContentReferenceId: digest(observedFileContent),
        providerId: parsed.provider_id,
        run,
        verifiedAt: capturedAt,
      });
      await writeJsonNoReplace(
        resolve(output, 'workload.json'),
        artifacts.workload,
      );
      await writeJsonNoReplace(
        resolve(output, 'report.json'),
        artifacts.report,
      );
    }
    throw error;
  } finally {
    await runChannelObservation?.close().catch(() => {});
    await Promise.allSettled(
      [page?.close(), browser?.close()].filter(
        (settlement) => settlement !== undefined,
      ),
    );
  }
}

const isMain =
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  runAgentAutonomyApprovalUiProbe()
    .then(({ exitCode }) => {
      process.exitCode = exitCode;
    })
    .catch((error) => {
      console.error(
        error instanceof Error ? `${error.name}: ${error.message}` : error,
      );
      process.exitCode = 1;
    });
}
