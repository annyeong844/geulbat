import type { ProcessCommandResult } from '@geulbat/shared-utils/process-command';
import type {
  SandboxAttemptCapabilityProjection,
  SandboxAttemptStore,
  SandboxOutputRef,
  SandboxTerminalStatus,
} from '../sandbox/attempt-store.js';
import {
  sandboxRootFailureDiagnostics,
  withRunningSandboxAttemptRoot,
} from '../sandbox/attempt-root.js';
import { buildSandboxEnvironment } from '../sandbox/environment.js';
import { importSandboxOutputEvidence } from '../sandbox/output-evidence-store.js';
import { collectSandboxOutputRef } from '../sandbox/output-validation.js';

// react-bundle dependency admission의 공유 sandbox attempt 생명주기 harness.
// probe/prepare 두 엔트리가 각자 복사해 갖고 있던 골격 — attempt 생성 →
// sandbox root → env 구성 → 프로세스 실행 → terminal 판정 → 출력 수집 →
// 증거 import → 후보 검증 → markTerminal 부기 — 를 여기 한 곳이 소유한다.
// 엔트리별 고유부(프로세스 실행 방식, 후보 검증 정책, 요약 shape)는
// runProcess/produceCandidate/buildSummary로 주입받는다. 실패 경로의
// markTerminal 진단 문자열 규격(`output_collection_failed:` 등)과 성공
// 부기의 순서는 harness가 소유하고, 후보 검증 실패의 진단 문자열은
// `failAttempt`를 통해 호출자가 소유한다.

interface ReactBundleDependencyAttemptRunArgs<
  ProcessResult extends ProcessCommandResult,
  Candidate,
  Summary,
> {
  workspaceRoot: string;
  store: SandboxAttemptStore;
  /** 에러 메시지 접두 — `react bundle dependency metadata probe` 등. */
  errorPrefix: string;
  attempt: {
    jobKind: string;
    adapterKind: string;
    capability?: SandboxAttemptCapabilityProjection;
  };
  adapterEnv: Record<string, string>;
  runProcess(args: {
    rootPath: string;
    outputDir: string;
    env: NodeJS.ProcessEnv;
  }): Promise<ProcessResult>;
  /** 증거 import 이후의 후보 읽기+검증. 실패는 `failAttempt`로 확정한다 —
   * 진단 문자열과 던질 에러를 호출자가 소유한다. */
  produceCandidate(args: {
    outputRef: SandboxOutputRef;
    processResult: Extract<ProcessResult, { kind: 'exit' }>;
    failAttempt: (diagnostics: string, error: unknown) => never;
  }): Promise<Candidate>;
  buildSummary(args: {
    attempt: { jobId: string; attemptId: string };
    outputRef: SandboxOutputRef;
    candidate: Candidate;
  }): Summary;
}

export async function runReactBundleDependencyAttempt<
  ProcessResult extends ProcessCommandResult,
  Candidate,
  Summary,
>(
  args: ReactBundleDependencyAttemptRunArgs<ProcessResult, Candidate, Summary>,
): Promise<Summary> {
  const attempt = args.store.createAttempt({
    jobKind: args.attempt.jobKind,
    adapterKind: args.attempt.adapterKind,
    ...(args.attempt.capability ? { capability: args.attempt.capability } : {}),
  });

  return await withRunningSandboxAttemptRoot({
    attemptId: attempt.attemptId,
    store: args.store,
    onRootFailure: (message) => {
      args.store.markTerminal(attempt.attemptId, {
        status: 'failed',
        diagnostics: sandboxRootFailureDiagnostics(message),
      });
      throw new Error(`${args.errorPrefix} sandbox_root_failed: ${message}`);
    },
    run: async (root) => {
      const env = buildSandboxEnvironment({
        homeDir: root.homeDir,
        tempDir: root.tempDir,
        adapterEnv: args.adapterEnv,
      });

      const processResult = await args.runProcess({
        rootPath: root.rootPath,
        outputDir: root.outputDir,
        env,
      });
      const status = classifySandboxedProcessResult(processResult);
      if (!isExitProcessResult(processResult) || status !== 'succeeded') {
        const diagnostics = joinDiagnostics(
          processResult.stdout,
          processResult.stderr,
        );
        args.store.markTerminal(attempt.attemptId, {
          status,
          exitCode:
            processResult.kind === 'exit' ? processResult.exitCode : null,
          diagnostics,
        });
        throw new Error(
          `${args.errorPrefix} failed: ${status}${
            diagnostics ? `: ${diagnostics}` : ''
          }`,
        );
      }

      return await importAttemptOutput({
        harness: args,
        attemptId: attempt.attemptId,
        processResult,
        outputDir: root.outputDir,
      });
    },
  });
}

async function importAttemptOutput<
  ProcessResult extends ProcessCommandResult,
  Candidate,
  Summary,
>(args: {
  harness: ReactBundleDependencyAttemptRunArgs<
    ProcessResult,
    Candidate,
    Summary
  >;
  attemptId: string;
  processResult: Extract<ProcessResult, { kind: 'exit' }>;
  outputDir: string;
}): Promise<Summary> {
  const { harness, attemptId, processResult } = args;
  const current = harness.store.getAttempt(attemptId);
  if (!current) {
    throw new Error(`sandbox attempt not found: ${attemptId}`);
  }

  let collectedOutput: Awaited<ReturnType<typeof collectSandboxOutputRef>>;
  try {
    collectedOutput = await collectSandboxOutputRef(args.outputDir);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    harness.store.markTerminal(attemptId, {
      status: 'failed',
      exitCode: processResult.exitCode,
      diagnostics: `output_collection_failed: ${message}`,
    });
    throw new Error(
      `${harness.errorPrefix} output_collection_failed: ${message}`,
    );
  }
  let outputRef: SandboxOutputRef;
  try {
    outputRef = await importSandboxOutputEvidence({
      workspaceRoot: harness.workspaceRoot,
      attempt: current,
      collectedOutput,
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    harness.store.markTerminal(attemptId, {
      status: 'failed',
      exitCode: processResult.exitCode,
      diagnostics: `evidence_import_failed: ${message}`,
    });
    throw new Error(
      `${harness.errorPrefix} evidence_import_failed: ${message}`,
    );
  }

  const failAttempt = (diagnostics: string, error: unknown): never => {
    harness.store.markTerminal(attemptId, {
      status: 'failed',
      exitCode: processResult.exitCode,
      diagnostics,
    });
    throw error;
  };
  const candidate = await harness.produceCandidate({
    outputRef,
    processResult,
    failAttempt,
  });

  const summary = harness.buildSummary({
    attempt: current,
    outputRef,
    candidate,
  });
  harness.store.markTerminal(attemptId, {
    status: 'succeeded',
    exitCode: processResult.exitCode,
    diagnostics: joinDiagnostics(processResult.stdout, processResult.stderr),
    outputRef,
  });
  return summary;
}

// 제네릭 ProcessResult 유니온은 `.kind` 비교만으로는 Extract로 좁혀지지
// 않아 전용 가드가 필요하다.
function isExitProcessResult<ProcessResult extends ProcessCommandResult>(
  result: ProcessResult,
): result is Extract<ProcessResult, { kind: 'exit' }> {
  return result.kind === 'exit';
}

function classifySandboxedProcessResult(
  result: ProcessCommandResult,
): SandboxTerminalStatus {
  switch (result.kind) {
    case 'exit':
      return result.exitCode === 0 ? 'succeeded' : 'failed';
    case 'timeout':
      return 'timed_out';
    case 'cancelled':
      return 'cancelled';
    case 'output_limit_exceeded':
      return 'crashed';
    case 'crash':
      return 'crashed';
  }
}

export function joinDiagnostics(stdout: string, stderr: string): string {
  return [stdout.trim(), stderr.trim()].filter(Boolean).join('\n');
}
