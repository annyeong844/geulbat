import type { SideEffectLevel } from '@geulbat/protocol/run-events';
import type { ErrorCode } from '../error-codes.js';
import { isRecord, tryParseJson } from '../runtime-json.js';

export interface ToolObjectParameters {
  type: 'object';
  properties: Record<string, unknown>;
  required: string[];
  additionalProperties: false;
}

interface ToolOneOfParameters {
  oneOf: ToolObjectParameters[];
}

export interface ToolAnyOfParameters {
  anyOf: ToolObjectParameters[];
}

export type ToolParameters =
  | ToolObjectParameters
  | ToolOneOfParameters
  | ToolAnyOfParameters;

function isClonedToolObjectParameters(
  value: unknown,
): value is ToolObjectParameters {
  return (
    isRecord(value) &&
    value.type === 'object' &&
    isRecord(value.properties) &&
    Array.isArray(value.required) &&
    value.required.every((entry) => typeof entry === 'string') &&
    value.additionalProperties === false
  );
}

function isClonedToolParameters(value: unknown): value is ToolParameters {
  if (!isRecord(value)) {
    return false;
  }
  if ('oneOf' in value) {
    return (
      !('anyOf' in value) &&
      Array.isArray(value.oneOf) &&
      value.oneOf.every(isClonedToolObjectParameters)
    );
  }
  if ('anyOf' in value) {
    return (
      Array.isArray(value.anyOf) &&
      value.anyOf.every(isClonedToolObjectParameters)
    );
  }
  return isClonedToolObjectParameters(value);
}

export function cloneToolParameters(
  parameters: ToolParameters,
): ToolParameters {
  const serialized = JSON.stringify(parameters);
  if (serialized === undefined) {
    throw new TypeError('Tool parameters must be JSON-serializable');
  }
  const cloned = tryParseJson(serialized);
  if (!cloned.ok || !isClonedToolParameters(cloned.value)) {
    throw new TypeError('Tool parameters must match the registry schema');
  }
  return cloned.value;
}

export function isToolObjectParameters(
  parameters: ToolParameters,
): parameters is ToolObjectParameters {
  return !('oneOf' in parameters) && !('anyOf' in parameters);
}

export function isToolAnyOfParameters(
  parameters: ToolParameters,
): parameters is ToolAnyOfParameters {
  return 'anyOf' in parameters;
}

export type ParallelToolBatchKind = 'subagent_launch' | 'ptc_cell';

export type ToolCatalogSearchFamily =
  | 'agent'
  | 'browser'
  | 'command'
  | 'catalog'
  | 'file'
  | 'memory'
  | 'network'
  | 'planning'
  | 'presentation'
  | 'ptc'
  | 'tool_output';

export interface ToolCatalogSearchMetadata {
  family: ToolCatalogSearchFamily;
  searchHints: readonly string[];
  tags: readonly string[];
  whenToUse: string;
  notFor: string;
  summary?: string;
}

export type HostToolEffect =
  | 'readOnly'
  | 'idempotent'
  | 'computerWrite'
  | 'hostStateMutation'
  | 'exclusive';

export type ToolRecoveryStrategy =
  | 'replay_safe'
  | 'idempotency_key'
  | 'reconcile_then_replay'
  | 'durable_handle'
  | 'at_least_once';

export interface ToolExposure {
  directHot: boolean;
  sdkVisible: boolean;
  inCellCallable: boolean;
  directOnly: boolean;
  approvalRequired: boolean;
  effectClass: HostToolEffect;
}

export interface ToolDefinition {
  type: 'function';
  name: string;
  description: string;
  parameters: ToolParameters;
  strict: boolean;
}

export interface ToolMeta {
  sideEffectLevel: SideEffectLevel;
  mayMutateComputerFiles: boolean;
  parallelBatchKind?: ParallelToolBatchKind;
  timeoutMs?: number;
  requiresApproval: boolean;
  exposure: ToolExposure;
  recoveryStrategy?: ToolRecoveryStrategy;
  // 도구 인자 스트리밍 opt-in — 켜면 provider args 델타가 tool_call_delta
  // 이벤트로 클라이언트까지 흐른다 (visualize의 실시간 렌더용)
  streamsArgsDelta?: boolean;
}

export interface RegisteredToolLike {
  name: string;
  description: string;
  parameters: ToolParameters;
  strict: boolean;
  sideEffectLevel: SideEffectLevel;
  mayMutateComputerFiles: boolean;
  parallelBatchKind?: ParallelToolBatchKind;
  timeoutMs?: number;
  requiresApproval: boolean;
  exposure?: ToolExposure;
  recoveryStrategy?: ToolRecoveryStrategy;
  streamsArgsDelta?: boolean;
  catalogSearchMetadata?: ToolCatalogSearchMetadata;
  parseArgs(
    raw: unknown,
  ): { ok: false; message: string } | { ok: true; value: object };
  executeParsed(
    args: object,
    ctx: unknown,
  ): Promise<
    | { ok: true; output: string; errorCode?: undefined; error?: undefined }
    | { ok: false; output: string; errorCode: ErrorCode; error: string }
  >;
}

export interface ToolRegistryStore {
  registerTool(tool: RegisteredToolLike): void;
  unregisterTool(name: string): boolean;
  getTool(name: string): RegisteredToolLike | undefined;
  getToolMeta(name: string): ToolMeta | null;
  getAllRegisteredToolNames(): string[];
  buildToolDefinitions(options?: { names?: string[] }): ToolDefinition[];
}

export type ToolResolver = Pick<ToolRegistryStore, 'getTool'>;
export type ToolMetaReader = Pick<ToolRegistryStore, 'getToolMeta'>;
export type ToolExecutionRegistry = Pick<
  ToolRegistryStore,
  'getTool' | 'getToolMeta'
>;
export type ToolRuntimeRegistry = Pick<
  ToolRegistryStore,
  'buildToolDefinitions' | 'getTool' | 'getToolMeta'
>;
