import {
  runPtcLabBrowserRuntimeCommandAttempt,
  type RunPtcLabBrowserRuntimeCommandAttemptArgs,
} from './lab-browser-runtime-command.js';
import {
  classifyPtcLabBrowserRuntimeCommandOutcome,
  type PtcLabBrowserRuntimeCommandFailureEnvelope,
  type PtcLabBrowserRuntimeCommandFailureMessages,
} from './lab-browser-runtime-cleanup.js';
import type {
  PtcSessionDockerCommandResult,
  PtcSessionDockerCommandRunner,
  PtcSessionDockerIdentity,
  PtcSessionDockerManager,
} from '../../session/session-docker-contract.js';

export interface PtcLabBrowserRuntimeExecutionOwnerArgs<Policy, Request> {
  policy: Policy;
  request: Request;
  identity: PtcSessionDockerIdentity;
  sessionManager: PtcSessionDockerManager;
  ownerStartMs?: number;
  commandRunner?: PtcSessionDockerCommandRunner;
  dockerPath?: string;
  now?: () => number;
  signal?: AbortSignal;
}

export interface PtcLabBrowserRuntimeOwnerArgs<Request, Admission> {
  admission: Admission;
  identity: PtcSessionDockerIdentity;
  sessionManager: PtcSessionDockerManager;
  request: Request;
  commandRunner?: PtcSessionDockerCommandRunner;
  dockerPath?: string;
  now?: () => number;
  signal?: AbortSignal;
}

type PtcLabBrowserRuntimeExecutionResult<FailureResult> =
  | { ok: true; execution: PtcSessionDockerCommandResult }
  | { ok: false; failure: FailureResult };

export async function runPtcLabBrowserRuntimeExecution<FailureResult>(args: {
  command: RunPtcLabBrowserRuntimeCommandAttemptArgs<FailureResult>;
  messages: PtcLabBrowserRuntimeCommandFailureMessages;
  mapFailure: (
    failure: PtcLabBrowserRuntimeCommandFailureEnvelope,
  ) => FailureResult;
}): Promise<PtcLabBrowserRuntimeExecutionResult<FailureResult>> {
  const runtimeAttempt = await runPtcLabBrowserRuntimeCommandAttempt(
    args.command,
  );
  if (!runtimeAttempt.ok) {
    return { ok: false, failure: runtimeAttempt.failure };
  }

  const runtimeClassification = classifyPtcLabBrowserRuntimeCommandOutcome({
    messages: args.messages,
    outcome: runtimeAttempt.outcome,
  });
  if (!runtimeClassification.ok) {
    return {
      ok: false,
      failure: args.mapFailure(runtimeClassification.failure),
    };
  }

  return { ok: true, execution: runtimeClassification.execution };
}
