import test from 'node:test';
import assert from 'node:assert/strict';

import { assertThreadId } from '@geulbat/protocol/ids';
import { z } from 'zod';
import { defineParsedTool } from './parsed-tool.js';
import { createToolRegistryStore } from './registry.js';
import { defineZodTool } from './zod-tool.js';
import type { RegisteredToolLike } from './tool-registry-model.js';
import type {
  AgentToolExecutionContext,
  AnyTool,
  StandaloneToolExecutionContext,
  ToolExecutionContext,
  ToolParseResult,
} from './types.js';
import {
  buildAgentToolExecutionContext,
  isAgentToolExecutionContext,
} from './types.js';

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? true
    : false;
type Expect<T extends true> = T;

const manualTool = defineParsedTool({
  name: 'type_boundary_manual_tool',
  description: 'type-level manual parser seam test',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string' },
      replaceAll: { type: 'boolean' },
    },
    required: ['path'],
    additionalProperties: false,
  },
  strict: true,
  sideEffectLevel: 'write',
  mayMutateComputerFiles: true,
  timeoutMs: 1_000,
  requiresApproval: true,
  parseArgs(raw): ToolParseResult<{ path: string; replaceAll?: boolean }> {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      return { ok: false, message: 'tool arguments must be an object.' };
    }

    const record = raw as Record<string, unknown>;
    if (typeof record.path !== 'string') {
      return { ok: false, message: 'path is required.' };
    }
    if (
      'replaceAll' in record &&
      typeof record.replaceAll !== 'boolean' &&
      typeof record.replaceAll !== 'undefined'
    ) {
      return {
        ok: false,
        message: 'replaceAll must be a boolean when provided.',
      };
    }

    return {
      ok: true,
      value: {
        path: record.path,
        ...(typeof record.replaceAll === 'boolean'
          ? { replaceAll: record.replaceAll }
          : {}),
      },
    };
  },
  async executeParsed(args, _ctx) {
    return {
      ok: true,
      output: `${args.path}:${String(args.replaceAll ?? false)}`,
    };
  },
});

const zodArgsSchema = z.strictObject({
  path: z.string().min(1),
  offset: z.number().min(0).optional(),
});

const zodTool = defineZodTool({
  name: 'type_boundary_zod_tool',
  description: 'type-level zod seam test',
  argsSchema: zodArgsSchema,
  sideEffectLevel: 'read',
  mayMutateComputerFiles: false,
  timeoutMs: 1_000,
  requiresApproval: false,
  async executeParsed(args, _ctx) {
    return {
      ok: true,
      output: `${args.path}:${String(args.offset ?? 0)}`,
    };
  },
});

const _erasedTool: AnyTool = zodTool;
const registry = createToolRegistryStore({ builtins: [zodTool] });
const THREAD_ID = assertThreadId('00000000-0000-4000-8000-000000000001');

type ManualExecuteArgs = Parameters<typeof manualTool.executeParsed>[0];
type ManualParseInput = Parameters<typeof manualTool.parseArgs>[0];
type ZodExecuteArgs = Parameters<typeof zodTool.executeParsed>[0];
type ZodParseResult = ReturnType<typeof zodTool.parseArgs>;
type RegistryLookup = ReturnType<typeof registry.getTool>;
type ErasedExecuteArgs = Parameters<typeof _erasedTool.executeParsed>[0];

type _ManualToolKeepsParsedArgs = Expect<
  Equal<ManualExecuteArgs, { path: string; replaceAll?: boolean }>
>;
type _ManualToolParsesFromUnknown = Expect<Equal<ManualParseInput, unknown>>;
type _ZodToolKeepsSchemaOutput = Expect<
  Equal<ZodExecuteArgs, z.output<typeof zodArgsSchema>>
>;
type _ZodToolParseResultMatchesSchema = Expect<
  Equal<ZodParseResult, ToolParseResult<z.output<typeof zodArgsSchema>>>
>;
type _RegistryLookupErasesLeafArgs = Expect<
  Equal<RegistryLookup, RegisteredToolLike | undefined>
>;
type _ErasedToolExecuteArgsAreNotLeafSpecific = Expect<
  Equal<ErasedExecuteArgs, object>
>;
type _AgentContextRequiresCanonicalRunIds = Expect<
  Equal<AgentToolExecutionContext['runId'], string>
>;
type _AgentContextKeepsSelectionPresentAsUndefinedableField = Expect<
  Equal<
    AgentToolExecutionContext['selection'],
    { startLine: number; endLine: number; text: string } | undefined
  >
>;
type _StandaloneContextAllowsOptionalHomeStateRoot = Expect<
  Equal<StandaloneToolExecutionContext['stateRoot'], string | undefined>
>;
type _StandaloneContextAllowsOptionalWorkingDirectory = Expect<
  Equal<StandaloneToolExecutionContext['workingDirectory'], string | undefined>
>;
type _AgentContextRequiresHomeStateRoot = Expect<
  Equal<AgentToolExecutionContext['stateRoot'], string>
>;
type _AgentContextRequiresWorkingDirectory = Expect<
  Equal<AgentToolExecutionContext['workingDirectory'], string>
>;
type _StandaloneContextUsesExplicitKind = Expect<
  Equal<StandaloneToolExecutionContext['kind'], 'standalone' | undefined>
>;
type _AgentContextUsesExplicitKind = Expect<
  Equal<AgentToolExecutionContext['kind'], 'agent'>
>;
type _StandaloneContextStillAllowsOptionalApprovalSession = Expect<
  Equal<StandaloneToolExecutionContext['approvalSessionId'], string | undefined>
>;
type _StandaloneContextAllowsOptionalComputerFileRoot = Expect<
  Equal<StandaloneToolExecutionContext['computerFileRoot'], string | undefined>
>;
type _AgentContextAllowsOptionalComputerFileRoot = Expect<
  Equal<AgentToolExecutionContext['computerFileRoot'], string | undefined>
>;
type _StandaloneContextExcludesProjectIdentity = Expect<
  Equal<
    'projectId' extends keyof StandaloneToolExecutionContext ? true : false,
    false
  >
>;
type _AgentContextExcludesProjectIdentity = Expect<
  Equal<
    'projectId' extends keyof AgentToolExecutionContext ? true : false,
    false
  >
>;
type _StandaloneContextExcludesWorkspaceRoot = Expect<
  Equal<
    'workspaceRoot' extends keyof StandaloneToolExecutionContext ? true : false,
    false
  >
>;
type _AgentContextExcludesWorkspaceRoot = Expect<
  Equal<
    'workspaceRoot' extends keyof AgentToolExecutionContext ? true : false,
    false
  >
>;
function collectArgs(_ctx: ToolExecutionContext): void {
  // compile-only anchor so ToolExecutionContext stays in this file's seam.
}

void test('tool generic args boundary type contracts compile', async () => {
  const parsed = manualTool.parseArgs({ path: 'draft.md', replaceAll: true });
  assert.equal(parsed.ok, true);
  if (parsed.ok) {
    const result = await manualTool.executeParsed(parsed.value, {
      callId: 'call-type-boundary',
    });
    assert.equal(result.ok, true);
    collectArgs({
      callId: 'call-type-boundary',
    });
  }

  const registryTool = registry.getTool('type_boundary_zod_tool');
  assert.ok(registryTool);
});

void test('agent tool execution context guard uses explicit context kind', () => {
  const standaloneContext: StandaloneToolExecutionContext = {
    kind: 'standalone',
    callId: 'call-standalone',
    stateRoot: '/tmp/home-state',
    workingDirectory: '/tmp/type-boundary',
    computerFileRoot: '/tmp/computer-session',
    approvalGranted: true,
    approvalSessionId: 'approval-session',
    permissionMode: 'basic',
    threadId: THREAD_ID,
    runId: 'run-1',
    emitAgentEvent: () => undefined,
  };

  const agentContext = buildAgentToolExecutionContext({
    base: {
      kind: 'agent',
      runOwnerKind: 'root_main',
      signal: undefined,
      runSignal: undefined,
      stateRoot: '/tmp/home-state',
      workingDirectory: '/tmp/type-boundary',
      computerFileRoot: '/tmp/computer-session',
      currentFile: undefined,
      selection: undefined,
      approvalSessionId: 'approval-session',
      permissionMode: 'basic',
      threadId: THREAD_ID,
      runId: 'run-1',
      runState: undefined,
      emitAgentEvent: () => undefined,
      memoryIndex: undefined,
      agentSpawnRuntime: undefined,
    },
    callId: 'call-agent',
    approvalGranted: true,
  });

  assert.equal(isAgentToolExecutionContext(standaloneContext), false);
  assert.equal(isAgentToolExecutionContext(agentContext), true);
  assert.equal(agentContext.computerFileRoot, '/tmp/computer-session');
});
