import type {
  PtcLabBrowserRuntimeCommandOutcome,
  PtcLabBrowserRuntimeInputCleanupOutcome,
} from './lab-browser-runtime-command.js';
import { definedPtcProps } from '../../../shared/record-shape.js';
import type { PtcSessionDockerCommandResult } from '../../session/session-docker-contract.js';
import {
  toPtcSessionTaintCloseDiagnostics,
  type PtcSessionTaintCloseOutcome,
} from '../../session/session-taint-close.js';

interface PtcLabBrowserTaintedSessionEnvelope {
  diagnostics?: Record<string, string | number | boolean>;
  sessionLifecycle: {
    mode: 'runtime_owned';
    retainedAfterExecution: false;
    taintedAfterExecution: true;
  };
}

interface PtcLabBrowserRuntimeCleanupFailureEnvelope extends PtcLabBrowserTaintedSessionEnvelope {
  diagnostics: Record<string, string | number | boolean>;
}

type PtcLabBrowserRuntimeCommandFailureReason =
  | 'ptc_lab_browser_navigation_failed'
  | 'ptc_lab_browser_timeout'
  | 'ptc_lab_browser_cancelled'
  | 'ptc_lab_browser_cleanup_uncertain';

type PtcLabBrowserRuntimeCommandFailurePhase =
  | 'runtime_start'
  | 'navigation'
  | 'cleanup';

export interface PtcLabBrowserRuntimeCommandFailureMessages {
  cancelled: string;
  cleanupUncertain: string;
  executionFailed: string;
  inputPrepareFailed: string;
  runnerThrew: string;
  timedOut: string;
}

interface PtcLabBrowserRuntimeCommandFailureDetails {
  diagnostics?: Record<string, string | number | boolean>;
  sessionLifecycle?: {
    mode: 'runtime_owned';
    retainedAfterExecution: boolean;
    taintedAfterExecution: boolean;
  };
}

export interface PtcLabBrowserRuntimeCommandFailureEnvelope {
  details: PtcLabBrowserRuntimeCommandFailureDetails;
  message: string;
  phase: PtcLabBrowserRuntimeCommandFailurePhase;
  reasonCode: PtcLabBrowserRuntimeCommandFailureReason;
}

type PtcLabBrowserRuntimeCommandClassification =
  | { ok: true; execution: PtcSessionDockerCommandResult }
  | { ok: false; failure: PtcLabBrowserRuntimeCommandFailureEnvelope };

function toPtcLabBrowserRuntimeInputCleanupFailureEnvelope(
  cleanup: PtcLabBrowserRuntimeInputCleanupOutcome,
): PtcLabBrowserRuntimeCleanupFailureEnvelope | undefined {
  if (cleanup.status !== 'failed') {
    return undefined;
  }
  const taint = toPtcLabBrowserTaintedSessionEnvelope(cleanup.closeOutcome);
  return {
    sessionLifecycle: taint.sessionLifecycle,
    diagnostics: {
      inputCleanupFailed: true,
      ...(taint.diagnostics ?? {}),
    },
  };
}

export function toPtcLabBrowserTaintedSessionEnvelope(
  outcome: PtcSessionTaintCloseOutcome,
): PtcLabBrowserTaintedSessionEnvelope {
  const diagnostics = toPtcSessionTaintCloseDiagnostics(outcome);
  return {
    sessionLifecycle: {
      mode: 'runtime_owned',
      retainedAfterExecution: false,
      taintedAfterExecution: true,
    },
    ...definedPtcProps({ diagnostics }),
  };
}

export function classifyPtcLabBrowserRuntimeCommandOutcome(args: {
  messages: PtcLabBrowserRuntimeCommandFailureMessages;
  outcome: PtcLabBrowserRuntimeCommandOutcome;
}): PtcLabBrowserRuntimeCommandClassification {
  const { messages, outcome } = args;
  const cleanup = toPtcLabBrowserRuntimeInputCleanupFailureEnvelope(
    outcome.inputCleanup,
  );

  if (outcome.primary.kind === 'not_started') {
    return {
      failure: {
        details: runtimeCommandFailureDetails(cleanup),
        message: messages.inputPrepareFailed,
        phase: 'runtime_start',
        reasonCode: 'ptc_lab_browser_navigation_failed',
      },
      ok: false,
    };
  }

  if (outcome.primary.kind === 'runner_threw') {
    return {
      failure: {
        details: runtimeCommandFailureDetails(cleanup, {
          commandResultKind: 'thrown',
        }),
        message: messages.runnerThrew,
        phase: 'navigation',
        reasonCode: 'ptc_lab_browser_navigation_failed',
      },
      ok: false,
    };
  }

  const execution = outcome.primary.result;
  if (cleanup === undefined) {
    return { execution, ok: true };
  }

  if (execution.kind === 'exit') {
    return {
      failure: {
        details: runtimeCommandFailureDetails(cleanup),
        message: messages.cleanupUncertain,
        phase: 'cleanup',
        reasonCode: 'ptc_lab_browser_cleanup_uncertain',
      },
      ok: false,
    };
  }

  return {
    failure: {
      details: runtimeCommandFailureDetails(
        cleanup,
        execution.kind === 'crash' ? { commandResultKind: 'crash' } : {},
      ),
      message:
        execution.kind === 'timeout'
          ? messages.timedOut
          : execution.kind === 'cancelled'
            ? messages.cancelled
            : messages.executionFailed,
      phase: 'navigation',
      reasonCode:
        execution.kind === 'timeout'
          ? 'ptc_lab_browser_timeout'
          : execution.kind === 'cancelled'
            ? 'ptc_lab_browser_cancelled'
            : 'ptc_lab_browser_navigation_failed',
    },
    ok: false,
  };
}

function runtimeCommandFailureDetails(
  cleanup: PtcLabBrowserRuntimeCleanupFailureEnvelope | undefined,
  diagnostics: Record<string, string | number | boolean> = {},
): PtcLabBrowserRuntimeCommandFailureDetails {
  return {
    ...definedPtcProps({ sessionLifecycle: cleanup?.sessionLifecycle }),
    ...(Object.keys(diagnostics).length === 0 &&
    cleanup?.diagnostics === undefined
      ? {}
      : { diagnostics: { ...diagnostics, ...(cleanup?.diagnostics ?? {}) } }),
  };
}
