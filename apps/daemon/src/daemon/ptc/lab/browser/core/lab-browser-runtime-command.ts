import { rm, stat, writeFile } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import { runPtcSessionDockerCommand } from '../../session/session-docker-command.js';
import {
  closeTaintedPtcDockerSession,
  type PtcSessionTaintCloseOutcome,
} from '../../session/session-taint-close.js';
import type {
  PtcSessionDockerCommandInvocation,
  PtcSessionDockerCommandResult,
  PtcSessionDockerCommandRunner,
  PtcSessionDockerFailureReason,
  PtcSessionDockerHandle,
  PtcSessionDockerIdentity,
  PtcSessionDockerManager,
} from '../../session/session-docker-contract.js';
import { definedPtcProps } from '../../../shared/record-shape.js';

export const PTC_LAB_BROWSER_RUNTIME_INPUT_MAX_BYTES = 8 * 1024;

type PtcLabBrowserRuntimeCommandOwnerKind =
  | 'user_url_navigation'
  | 'page_load_evidence'
  | 'dom_text_evidence';

type PtcLabBrowserRuntimeCommandPrimary =
  | { kind: 'not_started'; reason: 'input_prepare_failed' }
  | { kind: 'runner_threw' }
  | { kind: 'command_result'; result: PtcSessionDockerCommandResult };

export type PtcLabBrowserRuntimeInputCleanupOutcome =
  | { attempted: false; status: 'not_needed' }
  | { attempted: true; status: 'removed' }
  | {
      attempted: true;
      status: 'failed';
      closeOutcome: PtcSessionTaintCloseOutcome;
    };

export interface PtcLabBrowserRuntimeCommandOutcome {
  primary: PtcLabBrowserRuntimeCommandPrimary;
  inputCleanup: PtcLabBrowserRuntimeInputCleanupOutcome;
}

interface RunPtcLabBrowserRuntimeCommandArgs {
  attemptDigest: string;
  commandRunner?: PtcSessionDockerCommandRunner;
  dockerPath?: string;
  handle: PtcSessionDockerHandle;
  identity: PtcSessionDockerIdentity;
  inputEnvelope: unknown;
  ownerKind: PtcLabBrowserRuntimeCommandOwnerKind;
  outputBufferPolicy?: NonNullable<
    PtcSessionDockerCommandInvocation['outputBufferPolicy']
  >;
  runtimeScript: string;
  sessionManager: Pick<PtcSessionDockerManager, 'close'>;
  signal?: AbortSignal;
  timeoutMs: number;
}

export interface RunPtcLabBrowserRuntimeCommandAttemptArgs<
  FailureResult,
> extends Omit<
  RunPtcLabBrowserRuntimeCommandArgs,
  'handle' | 'sessionManager'
> {
  sessionManager: PtcSessionDockerManager;
  sessionUnavailable: (
    reasonCode: PtcSessionDockerFailureReason | 'session_manager_threw',
  ) => FailureResult;
  validateSession: (
    handle: PtcSessionDockerHandle,
  ) => { ok: true } | { ok: false; failure: FailureResult };
}

type PtcLabBrowserRuntimeCommandAttemptResult<FailureResult> =
  | {
      ok: true;
      handle: PtcSessionDockerHandle;
      outcome: PtcLabBrowserRuntimeCommandOutcome;
    }
  | { ok: false; failure: FailureResult };

const ATTEMPT_DIGEST_PATTERN = /^sha256:([0-9a-f]{64})$/u;

const OWNER_KIND_FILENAME_SEGMENT = {
  dom_text_evidence: 'dom-text-evidence',
  page_load_evidence: 'page-load-evidence',
  user_url_navigation: 'user-url-navigation',
} satisfies Record<PtcLabBrowserRuntimeCommandOwnerKind, string>;

export async function runPtcLabBrowserRuntimeCommand(
  args: RunPtcLabBrowserRuntimeCommandArgs,
): Promise<PtcLabBrowserRuntimeCommandOutcome> {
  const inputFile = buildBrowserRuntimeInputFile({
    attemptDigest: args.attemptDigest,
    handle: args.handle,
    ownerKind: args.ownerKind,
  });
  const serializedInput = serializeBrowserRuntimeInput(args.inputEnvelope);
  if (!inputFile.ok || !serializedInput.ok || args.runtimeScript.length === 0) {
    return {
      inputCleanup: { attempted: false, status: 'not_needed' },
      primary: { kind: 'not_started', reason: 'input_prepare_failed' },
    };
  }

  try {
    await writeFile(inputFile.hostPath, serializedInput.value, {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    });
  } catch {
    return {
      inputCleanup: await cleanupMaybeCreatedInputFile({
        hostPath: inputFile.hostPath,
        identity: args.identity,
        sessionManager: args.sessionManager,
      }),
      primary: { kind: 'not_started', reason: 'input_prepare_failed' },
    };
  }

  let commandResult: PtcSessionDockerCommandResult;
  try {
    commandResult = await (args.commandRunner ?? runPtcSessionDockerCommand)({
      executable: args.dockerPath ?? 'docker',
      args: [
        'exec',
        args.handle.containerId,
        'node',
        '-e',
        args.runtimeScript,
        inputFile.containerPath,
      ],
      timeoutMs: args.timeoutMs,
      ...definedPtcProps({
        outputBufferPolicy: args.outputBufferPolicy,
        signal: args.signal,
      }),
    });
  } catch {
    return {
      inputCleanup: await cleanupCreatedInputFile({
        hostPath: inputFile.hostPath,
        identity: args.identity,
        sessionManager: args.sessionManager,
      }),
      primary: { kind: 'runner_threw' },
    };
  }

  return {
    inputCleanup: await cleanupCreatedInputFile({
      hostPath: inputFile.hostPath,
      identity: args.identity,
      sessionManager: args.sessionManager,
    }),
    primary: { kind: 'command_result', result: commandResult },
  };
}

export async function runPtcLabBrowserRuntimeCommandAttempt<FailureResult>(
  args: RunPtcLabBrowserRuntimeCommandAttemptArgs<FailureResult>,
): Promise<PtcLabBrowserRuntimeCommandAttemptResult<FailureResult>> {
  let handle: PtcSessionDockerHandle;
  try {
    const session = await args.sessionManager.getOrCreate(
      args.identity,
      args.signal === undefined ? undefined : { signal: args.signal },
    );
    if (!session.ok) {
      return {
        ok: false,
        failure: args.sessionUnavailable(session.reasonCode),
      };
    }
    handle = session.value;
  } catch {
    return {
      ok: false,
      failure: args.sessionUnavailable('session_manager_threw'),
    };
  }

  const sessionValidation = args.validateSession(handle);
  if (!sessionValidation.ok) {
    return { ok: false, failure: sessionValidation.failure };
  }

  return {
    ok: true,
    handle,
    outcome: await runPtcLabBrowserRuntimeCommand({
      attemptDigest: args.attemptDigest,
      ...definedPtcProps({
        commandRunner: args.commandRunner,
        dockerPath: args.dockerPath,
        outputBufferPolicy: args.outputBufferPolicy,
        signal: args.signal,
      }),
      handle,
      identity: args.identity,
      inputEnvelope: args.inputEnvelope,
      ownerKind: args.ownerKind,
      runtimeScript: args.runtimeScript,
      sessionManager: args.sessionManager,
      timeoutMs: args.timeoutMs,
    }),
  };
}

function buildBrowserRuntimeInputFile(args: {
  attemptDigest: string;
  handle: PtcSessionDockerHandle;
  ownerKind: PtcLabBrowserRuntimeCommandOwnerKind;
}): { ok: true; hostPath: string; containerPath: string } | { ok: false } {
  const ownerSegment = OWNER_KIND_FILENAME_SEGMENT[args.ownerKind];
  const digestHex = ATTEMPT_DIGEST_PATTERN.exec(args.attemptDigest)?.[1];
  if (ownerSegment === undefined || digestHex === undefined) {
    return { ok: false };
  }

  const filename = `ptc-browser-${ownerSegment}-${digestHex}.json`;
  const callbackRoot = resolve(args.handle.callbackRootHostPath);
  const hostPath = resolve(callbackRoot, filename);
  const relativePath = relative(callbackRoot, hostPath);
  if (relativePath.startsWith('..') || isAbsolute(relativePath)) {
    return { ok: false };
  }

  return {
    ok: true,
    containerPath: `${args.handle.callbackRootContainerPath}/${filename}`,
    hostPath,
  };
}

function serializeBrowserRuntimeInput(
  inputEnvelope: unknown,
): { ok: true; value: string } | { ok: false } {
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(inputEnvelope);
  } catch {
    return { ok: false };
  }
  if (
    serialized === undefined ||
    Buffer.byteLength(serialized, 'utf8') >
      PTC_LAB_BROWSER_RUNTIME_INPUT_MAX_BYTES
  ) {
    return { ok: false };
  }
  return { ok: true, value: serialized };
}

async function cleanupMaybeCreatedInputFile(args: {
  hostPath: string;
  identity: PtcSessionDockerIdentity;
  sessionManager: Pick<PtcSessionDockerManager, 'close'>;
}): Promise<PtcLabBrowserRuntimeInputCleanupOutcome> {
  try {
    await stat(args.hostPath);
  } catch {
    return { attempted: false, status: 'not_needed' };
  }
  return await cleanupCreatedInputFile(args);
}

async function cleanupCreatedInputFile(args: {
  hostPath: string;
  identity: PtcSessionDockerIdentity;
  sessionManager: Pick<PtcSessionDockerManager, 'close'>;
}): Promise<PtcLabBrowserRuntimeInputCleanupOutcome> {
  try {
    await rm(args.hostPath, { force: true });
    return { attempted: true, status: 'removed' };
  } catch {
    return {
      attempted: true,
      closeOutcome: await closeTaintedPtcDockerSession({
        identity: args.identity,
        sessionManager: args.sessionManager,
      }),
      status: 'failed',
    };
  }
}
