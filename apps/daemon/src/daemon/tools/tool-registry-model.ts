import type { SideEffectLevel } from '@geulbat/protocol/run-events';
import type { ErrorCode } from '../error-codes.js';

export interface ToolParameters {
  type: 'object';
  properties: Record<string, unknown>;
  required: string[];
  additionalProperties: false;
}

export type ParallelToolBatchKind = 'subagent_launch';

export interface ToolDefinition {
  type: 'function';
  name: string;
  description: string;
  parameters: ToolParameters;
  strict: boolean;
}

export interface ToolMeta {
  sideEffectLevel: SideEffectLevel;
  mayMutateWorkspaceFiles?: boolean;
  parallelBatchKind?: ParallelToolBatchKind;
  timeoutMs?: number;
  requiresApproval: boolean;
}

export interface RegisteredToolLike extends ToolMeta {
  name: string;
  description: string;
  parameters: ToolParameters;
  strict: boolean;
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
