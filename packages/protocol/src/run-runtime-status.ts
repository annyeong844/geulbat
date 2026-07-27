import { isRunId, type RunId } from './ids.js';
import {
  isBoolean,
  isCanonicalIsoTimestamp,
  isNumber,
  isRecord,
  isString,
} from './wire-value-guards.js';

export const PROVIDER_RUNTIME_PHASES = [
  'auth_waiting',
  'provider_waiting',
  'rate_limit_waiting',
  'provider_streaming',
] as const;

export type ProviderRuntimePhase = (typeof PROVIDER_RUNTIME_PHASES)[number];

export const PROVIDER_RETRY_OUTCOMES = [
  'scheduled',
  'recovered',
  'exhausted',
  'unsafe_after_output',
  'unavailable',
] as const;

export type ProviderRetryOutcome = (typeof PROVIDER_RETRY_OUTCOMES)[number];

export interface ProviderRetryDiagnostics {
  available: boolean;
  performed: boolean;
  outcome: ProviderRetryOutcome;
}

export interface ProviderRequestDiagnostics {
  startedAt: string;
  lastEventAt?: string;
  endedAt?: string;
  durationMs?: number;
  attemptCount: number;
  retry?: ProviderRetryDiagnostics;
}

export interface ProviderRuntimeStatusEventPayload {
  phase: ProviderRuntimePhase;
  observedAt: string;
  request?: ProviderRequestDiagnostics;
}

export const SUBAGENT_TYPES = ['explorer', 'worker'] as const;
export type SubagentType = (typeof SUBAGENT_TYPES)[number];

export const SUBAGENT_CAPABILITIES = ['ptc'] as const;
export type SubagentCapability = (typeof SUBAGENT_CAPABILITIES)[number];

export const SUBAGENT_TOOL_SURFACE_PROFILES = [
  'explorer',
  'explorer_ptc',
  'worker',
] as const;
export type SubagentToolSurfaceProfile =
  (typeof SUBAGENT_TOOL_SURFACE_PROFILES)[number];

export const SUBAGENT_RUNTIME_PHASES = [
  'queued',
  'starting',
  'auth_waiting',
  'provider_waiting',
  'rate_limit_waiting',
  'provider_streaming',
  'tool_running',
  'approval_pending',
] as const;
export type SubagentRuntimePhase = (typeof SUBAGENT_RUNTIME_PHASES)[number];

export const SUBAGENT_RUNTIME_TOOL_STATES = [
  'running',
  'succeeded',
  'failed',
] as const;
export type SubagentRuntimeToolState =
  (typeof SUBAGENT_RUNTIME_TOOL_STATES)[number];

export interface SubagentRuntimeDiagnostics {
  phase: SubagentRuntimePhase;
  observedAt: string;
  lastTool?: {
    name: string;
    callId: string;
    state: SubagentRuntimeToolState;
  };
  partialOutputAvailable: boolean;
  previousChildRunId?: RunId;
  providerRequest?: ProviderRequestDiagnostics;
}

export interface RunUsageTotals {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
}

export function isSubagentType(value: unknown): value is SubagentType {
  return SUBAGENT_TYPES.some((subagentType) => subagentType === value);
}

export function isSubagentCapabilities(
  value: unknown,
): value is readonly SubagentCapability[] {
  if (!Array.isArray(value) || value.length > SUBAGENT_CAPABILITIES.length) {
    return false;
  }
  return value.every((capability) =>
    SUBAGENT_CAPABILITIES.some((candidate) => candidate === capability),
  );
}

export function isSubagentToolSurfaceProfile(
  value: unknown,
): value is SubagentToolSurfaceProfile {
  return SUBAGENT_TOOL_SURFACE_PROFILES.some((profile) => profile === value);
}

export function isSubagentRuntimePhase(
  value: unknown,
): value is SubagentRuntimePhase {
  return SUBAGENT_RUNTIME_PHASES.some((phase) => phase === value);
}

export function isProviderRuntimeStatusEventPayload(
  value: unknown,
): value is ProviderRuntimeStatusEventPayload {
  return (
    isRecord(value) &&
    PROVIDER_RUNTIME_PHASES.some((phase) => phase === value.phase) &&
    isCanonicalIsoTimestamp(value.observedAt) &&
    (value.request === undefined || isProviderRequestDiagnostics(value.request))
  );
}

export function isProviderRetryDiagnostics(
  value: unknown,
): value is ProviderRetryDiagnostics {
  if (
    !isRecord(value) ||
    !isBoolean(value.available) ||
    !isBoolean(value.performed) ||
    !PROVIDER_RETRY_OUTCOMES.some((outcome) => outcome === value.outcome)
  ) {
    return false;
  }
  if (value.outcome === 'scheduled') {
    return value.available && value.performed;
  }
  if (value.available) {
    return false;
  }
  return value.outcome !== 'recovered' || value.performed;
}

export function isProviderRequestDiagnostics(
  value: unknown,
): value is ProviderRequestDiagnostics {
  return (
    isRecord(value) &&
    isCanonicalIsoTimestamp(value.startedAt) &&
    (value.lastEventAt === undefined ||
      isCanonicalIsoTimestamp(value.lastEventAt)) &&
    (value.endedAt === undefined || isCanonicalIsoTimestamp(value.endedAt)) &&
    (value.durationMs === undefined ||
      (isNumber(value.durationMs) &&
        Number.isSafeInteger(value.durationMs) &&
        value.durationMs >= 0)) &&
    (value.endedAt === undefined) === (value.durationMs === undefined) &&
    isNumber(value.attemptCount) &&
    Number.isSafeInteger(value.attemptCount) &&
    value.attemptCount >= 1 &&
    (value.retry === undefined || isProviderRetryDiagnostics(value.retry))
  );
}

export function isSubagentRuntimeToolState(
  value: unknown,
): value is SubagentRuntimeToolState {
  return SUBAGENT_RUNTIME_TOOL_STATES.some((state) => state === value);
}

export function isSubagentRuntimeDiagnostics(
  value: unknown,
): value is SubagentRuntimeDiagnostics {
  if (
    !isRecord(value) ||
    !isSubagentRuntimePhase(value.phase) ||
    !isCanonicalIsoTimestamp(value.observedAt) ||
    !isBoolean(value.partialOutputAvailable) ||
    (value.providerRequest !== undefined &&
      !isProviderRequestDiagnostics(value.providerRequest)) ||
    (value.previousChildRunId !== undefined &&
      (!isString(value.previousChildRunId) ||
        !isRunId(value.previousChildRunId)))
  ) {
    return false;
  }
  if (value.lastTool === undefined) {
    return true;
  }
  return (
    isRecord(value.lastTool) &&
    isString(value.lastTool.name) &&
    value.lastTool.name.trim().length > 0 &&
    isString(value.lastTool.callId) &&
    value.lastTool.callId.trim().length > 0 &&
    isSubagentRuntimeToolState(value.lastTool.state)
  );
}

export function isRunUsageTotals(value: unknown): value is RunUsageTotals {
  return (
    isRecord(value) &&
    isNumber(value.inputTokens) &&
    isNumber(value.outputTokens) &&
    isNumber(value.cachedInputTokens)
  );
}
