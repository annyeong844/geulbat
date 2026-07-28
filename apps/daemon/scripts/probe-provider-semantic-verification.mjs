import { randomUUID } from 'node:crypto';
import {
  link,
  mkdir,
  mkdtemp,
  open,
  readFile,
  rm,
  unlink,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { sha256StableJson } from '@geulbat/content-identity/stable-json';
import { resolveRunModelDescriptor } from '@geulbat/protocol/run-contract';

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const REPO_ROOT = resolve(dirname(SCRIPT_PATH), '../../..');
const LIVE_OPT_IN_ENV = 'GEULBAT_PROVIDER_SEMANTIC_VERIFICATION_LIVE';
const OUTPUT_ROOT = '.audit/provider-semantic-verification-live';
const MODEL_IDS = Object.freeze(['gpt-5.6-sol', 'grok-4.5']);
const TASK_ID = 'goal_completion_admission_audit_v1';
const SOURCE_PATHS = Object.freeze([
  'apps/daemon/src/daemon/agent/run-completion-policy.ts',
  'apps/daemon/src/daemon/sessions/goal-store.ts',
  'apps/daemon/src/daemon/tools/builtin/update-goal.ts',
  'docs/current/spec/phase7-goal-mode/geulbat-phase7-goal-mode-completion-admission-spec-v1-codex-direct.md',
]);
const CLAIMS = Object.freeze([
  Object.freeze({
    id: 'H1',
    statement:
      'Goal completion requests persist the exact requesting run identity, and completion admission rejects a different run identity.',
    expectedStatus: 'supported',
    maxEvidenceSpanLines: 12,
    anchors: Object.freeze([
      Object.freeze({
        path: 'apps/daemon/src/daemon/sessions/goal-store.ts',
        pattern: 'completionRunId:\\s*assertRunId\\(runId\\)',
      }),
      Object.freeze({
        path: 'apps/daemon/src/daemon/sessions/goal-store.ts',
        pattern: 'current\\.completionRunId\\s*!==\\s*runId',
      }),
    ]),
  }),
  Object.freeze({
    id: 'H2',
    statement:
      'After process restart, a persisted Goal left in verifying is recovered as verification_unavailable unless the current process still owns that completion.',
    expectedStatus: 'supported',
    maxEvidenceSpanLines: 14,
    anchors: Object.freeze([
      Object.freeze({
        path: 'apps/daemon/src/daemon/sessions/goal-store.ts',
        pattern:
          "current\\?\\.snapshot\\.state\\s*!==\\s*'verifying'[\\s\\S]*liveCompletionThreadIds\\.has\\(threadId\\)",
      }),
      Object.freeze({
        path: 'apps/daemon/src/daemon/sessions/goal-store.ts',
        pattern: "state:\\s*'verification_unavailable'",
      }),
    ]),
  }),
  Object.freeze({
    id: 'H3',
    statement:
      'Once a Goal is verifying, admitCompletion accepts any runId without checking the stored completion correlation.',
    expectedStatus: 'contradicted',
    maxEvidenceSpanLines: 12,
    anchors: Object.freeze([
      Object.freeze({
        path: 'apps/daemon/src/daemon/sessions/goal-store.ts',
        pattern:
          "current\\.snapshot\\.state\\s*!==\\s*'verifying'[\\s\\S]*current\\.completionRunId\\s*!==\\s*runId",
      }),
      Object.freeze({
        path: 'apps/daemon/src/daemon/sessions/goal-store.ts',
        pattern: 'Goal completion request is no longer current',
      }),
    ]),
  }),
  Object.freeze({
    id: 'H4',
    statement:
      'When an approved plan is bound to the run, the completion policy assesses that plan before calling Goal admitCompletion.',
    expectedStatus: 'supported',
    maxEvidenceSpanLines: 14,
    anchors: Object.freeze([
      Object.freeze({
        path: 'apps/daemon/src/daemon/agent/run-completion-policy.ts',
        pattern:
          'args\\.planningWorkflows\\.assessExecutionCompletion\\([\\s\\S]*args\\.approvedPlan\\.ref',
      }),
      Object.freeze({
        path: 'apps/daemon/src/daemon/agent/run-completion-policy.ts',
        pattern: 'await\\s+args\\.goals\\.admitCompletion\\(',
      }),
    ]),
  }),
  Object.freeze({
    id: 'H5',
    statement:
      'The public completed Goal state guarantees that a separate model independently verified semantic achievement of the objective.',
    expectedStatus: 'contradicted',
    maxEvidenceSpanLines: 10,
    anchors: Object.freeze([
      Object.freeze({
        path: 'docs/current/spec/phase7-goal-mode/geulbat-phase7-goal-mode-completion-admission-spec-v1-codex-direct.md',
        pattern:
          '`completed`는\\s+별도\\s+모델이[\\s\\S]*독립\\s+검증했다는\\s+뜻이\\s+아니다',
      }),
      Object.freeze({
        path: 'docs/current/spec/phase7-goal-mode/geulbat-phase7-goal-mode-completion-admission-spec-v1-codex-direct.md',
        pattern:
          'agent의\\s+명시적\\s+완료\\s+요청과\\s+host가\\s+직접\\s+판정할\\s+수\\s+있는\\s+obligation',
      }),
    ]),
  }),
  Object.freeze({
    id: 'H6',
    statement:
      'Successful completion admission preserves legacyVerificationAttempts unchanged while appending a durable completion admission record.',
    expectedStatus: 'supported',
    maxEvidenceSpanLines: 14,
    anchors: Object.freeze([
      Object.freeze({
        path: 'apps/daemon/src/daemon/sessions/goal-store.ts',
        pattern:
          'completionAdmissions:\\s*\\[[\\s\\S]*\\.\\.\\.current\\.completionAdmissions',
      }),
      Object.freeze({
        path: 'apps/daemon/src/daemon/sessions/goal-store.ts',
        pattern:
          'legacyVerificationAttempts:\\s*current\\.legacyVerificationAttempts',
      }),
    ]),
  }),
  Object.freeze({
    id: 'H7',
    statement:
      'A Goal-store read or completion-admission failure is surfaced as verification_unavailable rather than being silently treated as terminal success.',
    expectedStatus: 'supported',
    maxEvidenceSpanLines: 14,
    anchors: Object.freeze([
      Object.freeze({
        path: 'apps/daemon/src/daemon/agent/run-completion-policy.ts',
        pattern:
          "return\\s*\\{[\\s\\S]*kind:\\s*'verification_unavailable'[\\s\\S]*message:[\\s\\S]*args\\.userMessage",
      }),
      Object.freeze({
        path: 'apps/daemon/src/daemon/agent/run-completion-policy.ts',
        pattern:
          "operation:\\s*'goal_completion_admission'[\\s\\S]*userMessage:\\s*'Goal completion admission is unavailable\\.'",
      }),
    ]),
  }),
]);
const ARM_KINDS = Object.freeze([
  'single_pass',
  'same_provider_submission_review',
  'distinct_provider_submission_review',
  'same_provider_blind_snapshot',
  'distinct_provider_blind_snapshot',
]);

class ProbeInputError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ProbeInputError';
  }
}

class ProbeRuntimeError extends Error {
  constructor(code) {
    super(code);
    this.name = 'ProbeRuntimeError';
    this.code = code;
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
      if (parsed.preflight) {
        throw new ProbeInputError('--preflight may only be provided once');
      }
      parsed.preflight = true;
      continue;
    }
    if (
      argument !== '--output' &&
      argument !== '--repeat' &&
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
  for (const key of ['output', 'repeat', 'timeout_ms']) {
    if (parsed[key] === undefined) {
      throw new ProbeInputError(`--${key.replaceAll('_', '-')} is required`);
    }
  }
  const repeat = Number(parsed.repeat);
  const timeoutMs = Number(parsed.timeout_ms);
  if (!Number.isInteger(repeat) || repeat <= 0) {
    throw new ProbeInputError('--repeat must be a positive integer');
  }
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
    throw new ProbeInputError('--timeout-ms must be a positive integer');
  }
  return {
    output: parsed.output,
    preflight: parsed.preflight,
    repeat,
    timeoutMs,
  };
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

async function writeTextNoReplace(path, value) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  let file;
  try {
    file = await open(temporaryPath, 'wx', 0o600);
    await file.writeFile(value, 'utf8');
    await file.sync();
    await file.close();
    file = undefined;
    await link(temporaryPath, path);
  } finally {
    await file?.close().catch(() => {});
    await unlink(temporaryPath).catch(() => {});
  }
}

async function writeJsonNoReplace(path, value) {
  await writeTextNoReplace(path, `${JSON.stringify(value, null, 2)}\n`);
}

async function loadLiveRuntime() {
  const [
    kernel,
    modelRound,
    authRuntime,
    authStatus,
    providerOptions,
    websocketCache,
  ] = await Promise.all([
    import('@geulbat/agent-loop/kernel'),
    import('../src/daemon/agent/loop-model-round.ts'),
    import('../src/daemon/auth/runtime-state.ts'),
    import('../src/daemon/auth/status.ts'),
    import('../src/daemon/llm/provider/provider-options.ts'),
    import('../src/daemon/llm/provider/transport/responses-websocket-cache.ts'),
  ]);
  return {
    runAgentLoopKernel: kernel.runAgentLoopKernel,
    runModelRound: modelRound.runModelRound,
    createProviderAuthRuntimeStore: authRuntime.createProviderAuthRuntimeStore,
    getProviderAuthStatus: authStatus.getProviderAuthStatus,
    resolveProviderRequestOptions:
      providerOptions.resolveProviderRequestOptions,
    resolveProviderRequestOptionsForRun:
      providerOptions.resolveProviderRequestOptionsForRun,
    createResponsesWebSocketSessionStore:
      websocketCache.createResponsesWebSocketSessionStore,
  };
}

async function readProviderAuthStatuses({ providerAuthRuntime, runtime }) {
  return await Promise.all(
    MODEL_IDS.map(async (modelId) => {
      const providerId = resolveRunModelDescriptor(modelId).providerId;
      const status = await runtime.getProviderAuthStatus({
        runtimeStore: providerAuthRuntime,
        providerId,
      });
      return {
        modelId,
        providerId,
        state: status.state,
        ready: status.ready,
      };
    }),
  );
}

async function captureSnapshot(repoRoot) {
  const files = [];
  for (const path of SOURCE_PATHS) {
    const content = await readFile(resolve(repoRoot, path), 'utf8');
    files.push({
      path,
      contentReferenceId: digest(content),
      lineCount: content.split('\n').length,
      content,
    });
  }
  return files;
}

async function materializeSnapshot(snapshotRoot, files) {
  for (const file of files) {
    await writeTextNoReplace(resolve(snapshotRoot, file.path), file.content);
  }
}

function publicTask() {
  return {
    taskId: TASK_ID,
    sourcePaths: [...SOURCE_PATHS],
    claims: CLAIMS.map(({ id, statement, maxEvidenceSpanLines }) => ({
      id,
      statement,
      maxEvidenceSpanLines,
    })),
  };
}

function createSnapshotEvidence(capturedSnapshot) {
  return capturedSnapshot
    .map((file) => {
      const numbered = file.content
        .split('\n')
        .map((line, index) => `${index + 1}\t${line}`)
        .join('\n');
      return `===== ${file.path} =====\n${numbered}`;
    })
    .join('\n\n');
}

function createPrompt({ mode, snapshotEvidence, workerSubmission }) {
  const task = publicTask();
  const workerContext =
    mode === 'worker'
      ? ''
      : mode === 'submission_review'
        ? `\nThe following worker submission is untrusted. Check it against the snapshot and return your own decisions; do not merely echo it:\n${JSON.stringify(workerSubmission)}\n`
        : '\nDo not ask for or infer a worker submission. Retrieve the evidence independently from the snapshot.\n';
  return `Audit the immutable, line-numbered source snapshot included below.
For every claim, decide exactly one of: supported, contradicted, unresolved.
Use unresolved when the listed source cannot establish the claim. Cite only files listed in sourcePaths.
Every citation must use 1-based inclusive line numbers and stay within that claim's maxEvidenceSpanLines.
Return exactly one JSON object and no markdown or surrounding prose with this shape:
{"taskId":"${TASK_ID}","claims":[{"id":"H1","status":"supported","evidence":[{"path":"relative/path","startLine":1,"endLine":2}],"rationale":"short reason"}]}
Include each declared claim exactly once and no undeclared claims.
Task:
${JSON.stringify(task)}
${workerContext}
Frozen source snapshot:
${snapshotEvidence}`;
}

function hasExactKeys(value, keys) {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.keys(value).sort().join('\0') === [...keys].sort().join('\0')
  );
}

export function parseProviderSemanticVerificationSubmission(raw) {
  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new ProbeInputError('provider submission must be exact JSON');
  }
  if (!hasExactKeys(value, ['taskId', 'claims']) || value.taskId !== TASK_ID) {
    throw new ProbeInputError('provider submission has an invalid task');
  }
  if (!Array.isArray(value.claims) || value.claims.length !== CLAIMS.length) {
    throw new ProbeInputError(
      'provider submission must contain every declared claim exactly once',
    );
  }
  const claims = new Map();
  for (const claim of value.claims) {
    if (
      !hasExactKeys(claim, ['id', 'status', 'evidence', 'rationale']) ||
      !CLAIMS.some((candidate) => candidate.id === claim.id) ||
      claims.has(claim.id) ||
      !['supported', 'contradicted', 'unresolved'].includes(claim.status) ||
      !Array.isArray(claim.evidence) ||
      typeof claim.rationale !== 'string' ||
      claim.rationale.trim() === ''
    ) {
      throw new ProbeInputError('provider submission has an invalid claim');
    }
    const evidence = claim.evidence.map((citation) => {
      if (
        !hasExactKeys(citation, ['path', 'startLine', 'endLine']) ||
        !SOURCE_PATHS.includes(citation.path) ||
        !Number.isInteger(citation.startLine) ||
        !Number.isInteger(citation.endLine) ||
        citation.startLine <= 0 ||
        citation.endLine < citation.startLine
      ) {
        throw new ProbeInputError(
          'provider submission has an invalid evidence citation',
        );
      }
      return {
        path: citation.path,
        startLine: citation.startLine,
        endLine: citation.endLine,
      };
    });
    claims.set(claim.id, {
      id: claim.id,
      status: claim.status,
      evidence,
      rationale: claim.rationale.trim(),
    });
  }
  return {
    taskId: TASK_ID,
    claims: CLAIMS.map(({ id }) => claims.get(id)),
  };
}

async function readSnapshot(snapshotRoot) {
  return new Map(
    await Promise.all(
      SOURCE_PATHS.map(async (path) => [
        path,
        (await readFile(resolve(snapshotRoot, path), 'utf8')).split('\n'),
      ]),
    ),
  );
}

function evaluateCitation({ citation, claim, snapshot }) {
  const lines = snapshot.get(citation.path);
  const spanLineCount = citation.endLine - citation.startLine + 1;
  if (
    lines === undefined ||
    citation.endLine > lines.length ||
    spanLineCount > claim.maxEvidenceSpanLines
  ) {
    return { relevant: false, coveredAnchorIndexes: [] };
  }
  const text = lines.slice(citation.startLine - 1, citation.endLine).join('\n');
  const coveredAnchorIndexes = [];
  for (let index = 0; index < claim.anchors.length; index += 1) {
    const anchor = claim.anchors[index];
    if (
      anchor.path === citation.path &&
      new RegExp(anchor.pattern, 'u').test(text)
    ) {
      coveredAnchorIndexes.push(index);
    }
  }
  return {
    relevant: coveredAnchorIndexes.length > 0,
    coveredAnchorIndexes,
  };
}

export async function evaluateProviderSemanticVerification(
  submission,
  snapshotRoot,
) {
  const snapshot = await readSnapshot(snapshotRoot);
  let relevantEvidenceCount = 0;
  let totalEvidenceCount = 0;
  const claims = CLAIMS.map((rubric) => {
    const submitted = submission.claims.find((claim) => claim.id === rubric.id);
    const coveredAnchorIndexes = new Set();
    const evidence = submitted.evidence.map((citation) => {
      const evaluation = evaluateCitation({
        citation,
        claim: rubric,
        snapshot,
      });
      totalEvidenceCount += 1;
      relevantEvidenceCount += Number(evaluation.relevant);
      for (const index of evaluation.coveredAnchorIndexes) {
        coveredAnchorIndexes.add(index);
      }
      return { ...citation, relevant: evaluation.relevant };
    });
    const statusCorrect = submitted.status === rubric.expectedStatus;
    const allAnchorsCovered =
      coveredAnchorIndexes.size === rubric.anchors.length;
    return {
      id: rubric.id,
      expectedStatus: rubric.expectedStatus,
      observedStatus: submitted.status,
      statusCorrect,
      allAnchorsCovered,
      hardConstraintSatisfied: statusCorrect && allAnchorsCovered,
      evidence,
    };
  });
  return {
    hardConstraintCount: claims.length,
    hardConstraintSatisfiedCount: claims.filter(
      (claim) => claim.hardConstraintSatisfied,
    ).length,
    statusCorrectCount: claims.filter((claim) => claim.statusCorrect).length,
    relevantEvidenceCount,
    totalEvidenceCount,
    unsupportedEvidenceCount: totalEvidenceCount - relevantEvidenceCount,
    evidencePrecision:
      totalEvidenceCount === 0
        ? null
        : relevantEvidenceCount / totalEvidenceCount,
    claims,
  };
}

function combineWorkerAndVerifier(
  worker,
  verifier,
  workerScore,
  verifierScore,
) {
  const claims = CLAIMS.map((rubric) => {
    const workerClaim = worker.claims.find((claim) => claim.id === rubric.id);
    const verifierClaim = verifier.claims.find(
      (claim) => claim.id === rubric.id,
    );
    const workerClaimScore = workerScore.claims.find(
      (claim) => claim.id === rubric.id,
    );
    const verifierClaimScore = verifierScore.claims.find(
      (claim) => claim.id === rubric.id,
    );
    const status =
      workerClaim.status === verifierClaim.status
        ? workerClaim.status
        : 'unresolved';
    return {
      id: rubric.id,
      expectedStatus: rubric.expectedStatus,
      workerStatus: workerClaim.status,
      verifierStatus: verifierClaim.status,
      status,
      disagreement: workerClaim.status !== verifierClaim.status,
      bothWrongSameStatus:
        workerClaim.status === verifierClaim.status &&
        workerClaim.status !== rubric.expectedStatus,
      correlatedHardFailure:
        !workerClaimScore.hardConstraintSatisfied &&
        !verifierClaimScore.hardConstraintSatisfied,
      verifierRecoveredWorkerHardFailure:
        !workerClaimScore.hardConstraintSatisfied &&
        verifierClaimScore.hardConstraintSatisfied,
      verifierIntroducedHardFailure:
        workerClaimScore.hardConstraintSatisfied &&
        !verifierClaimScore.hardConstraintSatisfied,
      hardConstraintSatisfied:
        status === rubric.expectedStatus &&
        workerClaimScore.hardConstraintSatisfied &&
        verifierClaimScore.hardConstraintSatisfied,
    };
  });
  return {
    hardConstraintCount: claims.length,
    hardConstraintSatisfiedCount: claims.filter(
      (claim) => claim.hardConstraintSatisfied,
    ).length,
    disagreementCount: claims.filter((claim) => claim.disagreement).length,
    unresolvedCount: claims.filter((claim) => claim.status === 'unresolved')
      .length,
    correlatedWrongCount: claims.filter((claim) => claim.bothWrongSameStatus)
      .length,
    correlatedHardFailureCount: claims.filter(
      (claim) => claim.correlatedHardFailure,
    ).length,
    verifierRecoveredWorkerHardFailureCount: claims.filter(
      (claim) => claim.verifierRecoveredWorkerHardFailure,
    ).length,
    verifierIntroducedHardFailureCount: claims.filter(
      (claim) => claim.verifierIntroducedHardFailure,
    ).length,
    falseSupportedCount: claims.filter(
      (claim) =>
        claim.status === 'supported' && claim.expectedStatus !== 'supported',
    ).length,
    claims,
  };
}

function otherModelId(modelId) {
  return MODEL_IDS.find((candidate) => candidate !== modelId);
}

async function runDirectProviderAttempt(args) {
  const history = [{ kind: 'user', text: args.prompt }];
  const providerSessionId = randomUUID();
  const model = resolveRunModelDescriptor(args.modelId);
  const providerRequestOptions =
    args.runtime.resolveProviderRequestOptionsForRun(
      args.baseProviderRequestOptions,
      {
        providerModel: {
          providerId: model.providerId,
          model: model.id,
        },
        reasoningEffort: 'high',
        serviceTier: 'standard',
      },
    );
  const signal = AbortSignal.timeout(args.timeoutMs);
  let usage;
  const result = await args.runtime.runAgentLoopKernel({
    signal,
    ports: {
      getHistoryItemCount() {
        return history.length;
      },
      async runModelRound({ round }) {
        const modelRound = await args.runtime.runModelRound({
          history,
          systemPrompt:
            'Return only the exact JSON object requested by the user. Do not emit markdown.',
          round,
          toolDefs: [],
          threadId: providerSessionId,
          providerWebSocketSessions: args.providerWebSocketSessions,
          providerAuthRuntime: args.providerAuthRuntime,
          providerRequestOptions,
          signal,
          emit() {},
        });
        if (modelRound.ok) {
          usage = modelRound.value.providerUsageTelemetry;
        }
        return modelRound;
      },
      async processStructuredOutputs({ structuredOutputs }) {
        return structuredOutputs.length === 0
          ? { ok: true, handled: false }
          : {
              ok: false,
              message:
                'semantic verification probe does not accept provider structured output',
            };
      },
      appendAssistantText({ text }) {
        history.push({ kind: 'assistant', phase: 'final_answer', text });
      },
      appendHistoryItems(items) {
        history.push(...items);
      },
      appendFunctionCalls(functionCalls) {
        for (const functionCall of functionCalls) {
          history.push({ kind: 'function_call', ...functionCall });
        }
      },
      async processFunctionCalls() {
        return {
          ok: false,
          result: {
            ok: false,
            finalProse: 'semantic_verification_unexpected_tool_call',
          },
        };
      },
      createTerminalFailure(failure) {
        return {
          ok: false,
          finalProse: `semantic_verification_${failure.kind}`,
        };
      },
      settleTerminal() {},
    },
  });
  if (!result.ok) {
    throw new ProbeRuntimeError('provider_attempt_failed');
  }
  return {
    answer: result.finalProse,
    providerSessionId,
    usage,
  };
}

function attemptReference(input) {
  return digest({
    taskId: TASK_ID,
    repeatIndex: input.repeatIndex,
    armKind: input.armKind,
    workerModelId: input.workerModelId,
    verifierModelId: input.verifierModelId ?? null,
  }).slice('sha256:'.length);
}

async function executeAttempt(args) {
  const reference = attemptReference(args);
  const startedAtMs = args.nowMs();
  let run;
  try {
    run = await args.runAttempt({
      baseProviderRequestOptions: args.baseProviderRequestOptions,
      modelId: args.modelId,
      prompt: args.prompt,
      providerAuthRuntime: args.providerAuthRuntime,
      providerWebSocketSessions: args.providerWebSocketSessions,
      runtime: args.runtime,
      timeoutMs: args.timeoutMs,
    });
  } catch (error) {
    await writeJsonNoReplace(
      resolve(args.output, 'submissions', `${reference}.failure.json`),
      {
        schemaVersion: 1,
        kind: 'provider_semantic_verification_attempt_failure',
        attemptReference: reference,
        armKind: args.armKind,
        workerModelId: args.workerModelId,
        verifierModelId: args.verifierModelId ?? null,
        modelId: args.modelId,
        failureCode:
          error instanceof ProbeRuntimeError ? error.code : 'unexpected_error',
      },
    );
    throw error;
  }
  const rawAnswer = run.answer.trim();
  await writeTextNoReplace(
    resolve(args.output, 'submissions', `${reference}.raw.txt`),
    `${rawAnswer}\n`,
  );
  const submission = parseProviderSemanticVerificationSubmission(rawAnswer);
  const score = await evaluateProviderSemanticVerification(
    submission,
    args.snapshotRoot,
  );
  const model = resolveRunModelDescriptor(args.modelId);
  const receipt = {
    schemaVersion: 1,
    kind: 'provider_semantic_verification_attempt',
    attemptReference: reference,
    repeatIndex: args.repeatIndex,
    armKind: args.armKind,
    workerModelId: args.workerModelId,
    verifierModelId: args.verifierModelId ?? null,
    modelId: model.id,
    providerId: model.providerId,
    providerSessionId: run.providerSessionId,
    terminalOutcome: 'completed',
    toolDefinitionCount: 0,
    durationMs: Math.max(0, args.nowMs() - startedAtMs),
    usage:
      run.usage === undefined
        ? null
        : {
            inputTokens: run.usage.inputTokens,
            cachedInputTokens: run.usage.cachedInputTokens,
            outputTokens: run.usage.outputTokens,
          },
    submission,
    score,
  };
  await writeJsonNoReplace(
    resolve(args.output, 'submissions', `${reference}.json`),
    receipt,
  );
  return receipt;
}

function sum(values) {
  return values.reduce((total, value) => total + value, 0);
}

function aggregateArm(attempts) {
  const precisionValues = attempts
    .map((attempt) => attempt.score.evidencePrecision)
    .filter((value) => value !== null);
  const usage = attempts.map((attempt) => attempt.usage);
  return {
    attemptCount: attempts.length,
    hardConstraintCount: sum(
      attempts.map((attempt) => attempt.score.hardConstraintCount),
    ),
    hardConstraintSatisfiedCount: sum(
      attempts.map((attempt) => attempt.score.hardConstraintSatisfiedCount),
    ),
    meanEvidencePrecision:
      precisionValues.length === 0
        ? null
        : sum(precisionValues) / precisionValues.length,
    unsupportedEvidenceCount: sum(
      attempts.map((attempt) => attempt.score.unsupportedEvidenceCount),
    ),
    durationMs: sum(attempts.map((attempt) => attempt.durationMs)),
    usageObservedAttemptCount: usage.filter((entry) => entry !== null).length,
    inputTokens: sum(
      usage.map((entry) => (entry === null ? 0 : entry.inputTokens)),
    ),
    cachedInputTokens: sum(
      usage.map((entry) => (entry === null ? 0 : entry.cachedInputTokens)),
    ),
    outputTokens: sum(
      usage.map((entry) => (entry === null ? 0 : entry.outputTokens)),
    ),
    billedCostObserved: false,
    costMicrousd: null,
  };
}

function buildReport({ attempts, comparisons, declaration, repeat }) {
  const arms = Object.fromEntries(
    ARM_KINDS.map((armKind) => [
      armKind,
      aggregateArm(attempts.filter((attempt) => attempt.armKind === armKind)),
    ]),
  );
  const comparisonSummary = Object.fromEntries(
    ARM_KINDS.filter((armKind) => armKind !== 'single_pass').map((armKind) => {
      const rows = comparisons.filter(
        (comparison) => comparison.armKind === armKind,
      );
      return [
        armKind,
        {
          comparisonCount: rows.length,
          hardConstraintCount: sum(
            rows.map((row) => row.gate.hardConstraintCount),
          ),
          hardConstraintSatisfiedCount: sum(
            rows.map((row) => row.gate.hardConstraintSatisfiedCount),
          ),
          disagreementCount: sum(rows.map((row) => row.gate.disagreementCount)),
          unresolvedCount: sum(rows.map((row) => row.gate.unresolvedCount)),
          correlatedWrongCount: sum(
            rows.map((row) => row.gate.correlatedWrongCount),
          ),
          correlatedHardFailureCount: sum(
            rows.map((row) => row.gate.correlatedHardFailureCount),
          ),
          verifierRecoveredWorkerHardFailureCount: sum(
            rows.map((row) => row.gate.verifierRecoveredWorkerHardFailureCount),
          ),
          verifierIntroducedHardFailureCount: sum(
            rows.map((row) => row.gate.verifierIntroducedHardFailureCount),
          ),
          falseSupportedCount: sum(
            rows.map((row) => row.gate.falseSupportedCount),
          ),
        },
      ];
    }),
  );
  return {
    schemaVersion: 1,
    kind: 'provider_semantic_verification_comparison',
    declarationReferenceId: digest(declaration),
    repeat,
    taskCount: 1,
    providerDirections: MODEL_IDS.map((workerModelId) => ({
      workerModelId,
      verifierModelId: otherModelId(workerModelId),
    })),
    arms,
    comparisonSummary,
    limitations: [
      'one frozen code-audit task',
      'configured repeat count is directional evidence, not statistical proof',
      'provider usage tokens are observed when emitted; monetary cost is unavailable',
      'no refine loop was executed',
      'no mutation, approval, Goal commit, or product verifier path was enabled',
    ],
    productizationAuthorized: false,
  };
}

export async function runProviderSemanticVerificationProbe(options = {}) {
  const parsed = parseArgs(options.argv ?? process.argv.slice(2));
  const repoRoot = options.repoRoot ?? REPO_ROOT;
  const env = options.env ?? process.env;
  const output = resolveOutput(repoRoot, parsed.output);
  const runtime = await (options.runtimeLoader ?? loadLiveRuntime)();
  const providerAuthRuntime = runtime.createProviderAuthRuntimeStore();
  const providerAuth = await (
    options.readProviderAuthStatuses ?? readProviderAuthStatuses
  )({
    providerAuthRuntime,
    runtime,
  });
  const preflight = {
    schemaVersion: 1,
    kind: 'provider_semantic_verification_preflight',
    modelIds: [...MODEL_IDS],
    providerIds: MODEL_IDS.map(
      (modelId) => resolveRunModelDescriptor(modelId).providerId,
    ),
    liveOptInPresent: env[LIVE_OPT_IN_ENV] === '1',
    providerAuth,
    repeat: parsed.repeat,
    runtimeSurface: 'direct_provider_oauth_model_round',
  };
  if (parsed.preflight) {
    (options.log ?? console.log)(JSON.stringify(preflight));
    return {
      exitCode: providerAuth.every((status) => status.ready) ? 0 : 1,
      preflight,
    };
  }
  if (!preflight.liveOptInPresent) {
    throw new ProbeInputError(`live execution requires ${LIVE_OPT_IN_ENV}=1`);
  }
  if (!providerAuth.every((status) => status.ready)) {
    throw new ProbeInputError(
      'live execution requires ready OAuth credentials for both providers',
    );
  }

  const capturedSnapshot = await captureSnapshot(repoRoot);
  const snapshotFiles = capturedSnapshot.map(({ content, ...file }) => file);
  const runtimeSnapshotRoot = await mkdtemp(
    resolve(tmpdir(), 'geulbat-semantic-verification-'),
  );
  await materializeSnapshot(runtimeSnapshotRoot, capturedSnapshot);
  const snapshotEvidence = createSnapshotEvidence(capturedSnapshot);
  const declaration = {
    schemaVersion: 1,
    kind: 'provider_semantic_verification_declaration',
    registeredAt: (options.now ?? (() => new Date()))().toISOString(),
    task: {
      ...publicTask(),
      rubric: CLAIMS.map(
        ({ id, expectedStatus, maxEvidenceSpanLines, anchors }) => ({
          id,
          expectedStatus,
          maxEvidenceSpanLines,
          anchors,
        }),
      ),
    },
    snapshotFiles,
    execution: {
      repeat: parsed.repeat,
      modelIds: [...MODEL_IDS],
      armKinds: [...ARM_KINDS],
      reasoningEffort: 'high',
      serviceTier: 'standard',
      evidenceSurface: 'frozen_line_numbered_snapshot_in_prompt',
      toolDefinitionCount: 0,
      runtimeSurface: 'direct_provider_oauth_model_round',
      sequence: 'serial',
      disagreementDisposition: 'unresolved',
      refineEnabled: false,
    },
  };
  await writeJsonNoReplace(resolve(output, 'declaration.json'), declaration);

  const providerWebSocketSessions =
    runtime.createResponsesWebSocketSessionStore();
  try {
    const attempts = [];
    const comparisons = [];
    const runAttempt = options.runAttempt ?? runDirectProviderAttempt;
    const nowMs = options.nowMs ?? Date.now;
    const baseProviderRequestOptions =
      runtime.resolveProviderRequestOptions(env);
    for (let repeatIndex = 1; repeatIndex <= parsed.repeat; repeatIndex += 1) {
      for (const workerModelId of MODEL_IDS) {
        const worker = await executeAttempt({
          armKind: 'single_pass',
          baseProviderRequestOptions,
          modelId: workerModelId,
          nowMs,
          output,
          prompt: createPrompt({
            mode: 'worker',
            snapshotEvidence,
          }),
          providerAuthRuntime,
          providerWebSocketSessions,
          repeatIndex,
          runAttempt,
          runtime,
          snapshotRoot: runtimeSnapshotRoot,
          timeoutMs: parsed.timeoutMs,
          workerModelId,
        });
        attempts.push(worker);
        const verifierCases = [
          {
            armKind: 'same_provider_submission_review',
            mode: 'submission_review',
            verifierModelId: workerModelId,
          },
          {
            armKind: 'distinct_provider_submission_review',
            mode: 'submission_review',
            verifierModelId: otherModelId(workerModelId),
          },
          {
            armKind: 'same_provider_blind_snapshot',
            mode: 'blind_retrieval',
            verifierModelId: workerModelId,
          },
          {
            armKind: 'distinct_provider_blind_snapshot',
            mode: 'blind_retrieval',
            verifierModelId: otherModelId(workerModelId),
          },
        ];
        for (const verifierCase of verifierCases) {
          const verifier = await executeAttempt({
            armKind: verifierCase.armKind,
            baseProviderRequestOptions,
            modelId: verifierCase.verifierModelId,
            nowMs,
            output,
            prompt: createPrompt({
              mode: verifierCase.mode,
              snapshotEvidence,
              workerSubmission: worker.submission,
            }),
            providerAuthRuntime,
            providerWebSocketSessions,
            repeatIndex,
            runAttempt,
            runtime,
            snapshotRoot: runtimeSnapshotRoot,
            timeoutMs: parsed.timeoutMs,
            verifierModelId: verifierCase.verifierModelId,
            workerModelId,
          });
          attempts.push(verifier);
          comparisons.push({
            repeatIndex,
            armKind: verifierCase.armKind,
            workerAttemptReference: worker.attemptReference,
            verifierAttemptReference: verifier.attemptReference,
            workerModelId,
            verifierModelId: verifierCase.verifierModelId,
            gate: combineWorkerAndVerifier(
              worker.submission,
              verifier.submission,
              worker.score,
              verifier.score,
            ),
          });
        }
      }
    }
    const report = buildReport({
      attempts,
      comparisons,
      declaration,
      repeat: parsed.repeat,
    });
    await materializeSnapshot(resolve(output, 'snapshot'), capturedSnapshot);
    await writeJsonNoReplace(resolve(output, 'comparisons.json'), {
      schemaVersion: 1,
      kind: 'provider_semantic_verification_comparison_rows',
      rows: comparisons,
    });
    await writeJsonNoReplace(resolve(output, 'report.json'), report);
    (options.log ?? console.log)(
      JSON.stringify({
        kind: 'provider_semantic_verification_probe_completed',
        output: relative(repoRoot, output),
        attemptCount: attempts.length,
        productizationAuthorized: report.productizationAuthorized,
      }),
    );
    return {
      exitCode: 0,
      attempts,
      comparisons,
      declaration,
      report,
    };
  } finally {
    await Promise.all([
      providerWebSocketSessions.closeAll(),
      rm(runtimeSnapshotRoot, { recursive: true, force: true }),
    ]);
  }
}

function safeError(error) {
  if (error instanceof ProbeInputError) {
    return error.message;
  }
  if (error instanceof ProbeRuntimeError) {
    return `provider semantic verification probe failed (${error.code})`;
  }
  return 'provider semantic verification probe failed (unexpected_error)';
}

const isMain =
  process.argv[1] !== undefined && SCRIPT_PATH === resolve(process.argv[1]);

if (isMain) {
  runProviderSemanticVerificationProbe()
    .then(({ exitCode }) => {
      process.exitCode = exitCode;
    })
    .catch((error) => {
      process.stderr.write(`${safeError(error)}\n`);
      process.exitCode = 1;
    });
}
