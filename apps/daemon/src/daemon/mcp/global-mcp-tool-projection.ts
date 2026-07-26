import { createHash } from 'node:crypto';

import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import {
  CallToolResultSchema,
  ListToolsResultSchema,
} from '@modelcontextprotocol/sdk/types.js';
import type { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv-provider.js';
import type {
  JsonSchemaType,
  JsonSchemaValidator,
} from '@modelcontextprotocol/sdk/validation/types.js';
import type { McpServerRegistration } from '@geulbat/protocol/mcp';
import {
  toApprovalClass,
  type ApprovalClass,
} from '@geulbat/protocol/run-approval';
import { isMcpRecord as isRecord } from './mcp-value-guards.js';

import { defineParsedTool } from '../tools/parsed-tool.js';
import { toolError } from '../tools/result.js';
import type {
  ToolObjectParameters,
  ToolRegistryStore,
} from '../tools/tool-registry-model.js';
import { getErrorMessage } from '../utils/error.js';
import { McpServerConfigError } from './global-mcp-contract.js';
import { cloneServerSource } from './global-mcp-registration.js';

export interface LiveMcpServer {
  client: Client;
  /**
   * 살아 있는 MCP 전송이다. 프로세스는 command-host 세션이 소유하므로 이
   * 계층은 프로세스를 알지 못한다 (P7.6 §4, §9 M4).
   */
  transport: Transport;
  schemaValidator: AjvJsonSchemaValidator;
  projectedToolNames: Set<string>;
}

type DiscoveredMcpTool = Awaited<
  ReturnType<Client['listTools']>
>['tools'][number];

export function requestOptions(
  timeoutMs: number | undefined,
  signal?: AbortSignal,
): { timeout?: number; signal?: AbortSignal } | undefined {
  if (timeoutMs === undefined && signal === undefined) {
    return undefined;
  }
  return {
    ...(timeoutMs === undefined ? {} : { timeout: timeoutMs }),
    ...(signal === undefined ? {} : { signal }),
  };
}

export async function listAllTools(
  client: Client,
  timeoutMs: number | undefined,
): Promise<DiscoveredMcpTool[]> {
  const tools: DiscoveredMcpTool[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | undefined;
  do {
    const page = await client.request(
      {
        method: 'tools/list',
        ...(cursor === undefined ? {} : { params: { cursor } }),
      },
      ListToolsResultSchema,
      requestOptions(timeoutMs),
    );
    tools.push(...page.tools);
    const nextCursor = page.nextCursor;
    if (nextCursor !== undefined) {
      if (seenCursors.has(nextCursor)) {
        throw new McpServerConfigError(
          'MCP tools/list repeated a pagination cursor',
        );
      }
      seenCursors.add(nextCursor);
    }
    cursor = nextCursor;
  } while (cursor !== undefined);
  return tools;
}

export function indexModelVisibleTools(
  serverId: string,
  advertisedTools: readonly DiscoveredMcpTool[],
): Map<string, DiscoveredMcpTool> {
  const toolsByName = new Map<string, DiscoveredMcpTool>();
  const publicNames = new Set<string>();
  for (const tool of advertisedTools) {
    if (!isMcpToolVisibleToModel(tool)) {
      continue;
    }
    const publicName = projectMcpToolName(serverId, tool.name);
    if (toolsByName.has(tool.name) || publicNames.has(publicName)) {
      throw new McpServerConfigError(
        `MCP server published colliding tool names: ${tool.name}`,
      );
    }
    toolsByName.set(tool.name, tool);
    publicNames.add(publicName);
  }
  return toolsByName;
}

function isMcpToolVisibleToModel(tool: DiscoveredMcpTool): boolean {
  const ui = isRecord(tool._meta) ? tool._meta['ui'] : undefined;
  if (!isRecord(ui) || !Object.hasOwn(ui, 'visibility')) {
    return true;
  }
  const visibility = ui['visibility'];
  return Array.isArray(visibility) && visibility.includes('model');
}

export function createProjectedMcpTool(args: {
  client: Client;
  schemaValidator: AjvJsonSchemaValidator;
  registration: McpServerRegistration;
  publicName: string;
  tool: DiscoveredMcpTool;
}) {
  if (args.tool.execution?.taskSupport === 'required') {
    throw new McpServerConfigError(
      `MCP tool "${args.tool.name}" requires task-based execution, which is not supported by this runtime`,
    );
  }
  let validateInput: JsonSchemaValidator<Record<string, unknown>>;
  try {
    validateInput = args.schemaValidator.getValidator<Record<string, unknown>>(
      args.tool.inputSchema as JsonSchemaType,
    );
  } catch (error: unknown) {
    throw new McpServerConfigError(
      `MCP tool "${args.tool.name}" has an invalid input schema: ${getErrorMessage(error)}`,
    );
  }
  let validateOutput: JsonSchemaValidator<Record<string, unknown>> | undefined;
  if (args.tool.outputSchema !== undefined) {
    try {
      validateOutput = args.schemaValidator.getValidator<
        Record<string, unknown>
      >(args.tool.outputSchema as JsonSchemaType);
    } catch (error: unknown) {
      throw new McpServerConfigError(
        `MCP tool "${args.tool.name}" has an invalid output schema: ${getErrorMessage(error)}`,
      );
    }
  }
  return defineParsedTool<Record<string, unknown>>({
    name: args.publicName,
    description:
      `MCP server "${args.registration.name}" tool "${args.tool.name}". ${args.tool.description ?? ''}`.trim(),
    parameters: normalizeMcpInputSchema(args.tool.inputSchema),
    strict: false,
    sideEffectLevel: 'write',
    mayMutateComputerFiles: true,
    ...(args.registration.transport.requestTimeoutMs === undefined
      ? {}
      : { timeoutMs: args.registration.transport.requestTimeoutMs }),
    requiresApproval: true,
    approvalClass: mcpApprovalClass(args.registration.serverId),
    exposure: {
      directHot: false,
      sdkVisible: true,
      inCellCallable: true,
      directOnly: false,
      effectClass: 'hostStateMutation',
    },
    catalogSearchMetadata: {
      family: 'catalog',
      searchHints: [
        'mcp external tool',
        args.registration.name,
        args.tool.name,
      ],
      tags: ['external-tool', 'mcp'],
      whenToUse: `Use the configured MCP tool "${args.tool.name}" from "${args.registration.name}".`,
      notFor: 'Calls that do not require this configured external MCP server.',
    },
    parseArgs(raw) {
      if (!isRecord(raw)) {
        return { ok: false, message: 'MCP tool arguments must be an object' };
      }
      const validated = validateInput(raw);
      if (!validated.valid) {
        return {
          ok: false,
          message: `MCP tool arguments do not match its input schema: ${validated.errorMessage}`,
        };
      }
      return { ok: true, value: { ...validated.data } };
    },
    async executeParsed(toolArgs, context) {
      try {
        const result = await args.client.request(
          {
            method: 'tools/call',
            params: { name: args.tool.name, arguments: toolArgs },
          },
          CallToolResultSchema,
          requestOptions(
            args.registration.transport.requestTimeoutMs,
            context.signal,
          ),
        );
        if (validateOutput !== undefined && result.isError !== true) {
          if (result.structuredContent === undefined) {
            return toolError(
              'execution_failed',
              `MCP tool "${args.tool.name}" did not return structured content required by its output schema`,
            );
          }
          const validatedOutput = validateOutput(result.structuredContent);
          if (!validatedOutput.valid) {
            return toolError(
              'execution_failed',
              `MCP tool output does not match its output schema: ${validatedOutput.errorMessage}`,
            );
          }
        }
        const output = JSON.stringify({
          mcp: {
            serverId: args.registration.serverId,
            serverName: args.registration.name,
            toolName: args.tool.name,
            source: cloneServerSource(args.registration.source),
          },
          result,
        });
        if (result.isError === true) {
          return toolError('execution_failed', output);
        }
        return { ok: true, output };
      } catch (error: unknown) {
        return toolError(
          'execution_failed',
          `MCP tool call failed: ${getErrorMessage(error)}`,
        );
      }
    },
  });
}

function normalizeMcpInputSchema(
  schema: DiscoveredMcpTool['inputSchema'],
): ToolObjectParameters {
  const properties: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(schema.properties ?? {})) {
    properties[key] = normalizeMcpSchemaNode({
      value,
      root: schema,
      resolvingRefs: new Set(),
    });
  }
  const required = (schema.required ?? []).filter((key) =>
    Object.hasOwn(properties, key),
  );
  return {
    type: 'object',
    properties,
    required,
    additionalProperties: false,
  };
}

function normalizeMcpSchemaNode(args: {
  value: unknown;
  root: unknown;
  resolvingRefs: ReadonlySet<string>;
}): unknown {
  if (Array.isArray(args.value)) {
    return args.value.map((value) =>
      normalizeMcpSchemaNode({ ...args, value }),
    );
  }
  if (!isRecord(args.value)) {
    return args.value;
  }
  const schemaRecord = args.value;

  const ref = schemaRecord['$ref'];
  if (typeof ref === 'string') {
    if (args.resolvingRefs.has(ref)) {
      throw new McpServerConfigError(
        `MCP input schema contains a recursive local reference: ${ref}`,
      );
    }
    const nextRefs = new Set(args.resolvingRefs).add(ref);
    const target = resolveLocalMcpSchemaRef(args.root, ref);
    const resolved = normalizeMcpSchemaNode({
      value: target,
      root: args.root,
      resolvingRefs: nextRefs,
    });
    const siblings = normalizeMcpSchemaRecord({
      value: Object.fromEntries(
        Object.entries(schemaRecord).filter(([key]) => key !== '$ref'),
      ),
      root: args.root,
      resolvingRefs: nextRefs,
    });
    return Object.keys(siblings).length === 0
      ? resolved
      : { allOf: [resolved], ...siblings };
  }

  return normalizeMcpSchemaRecord({ ...args, value: schemaRecord });
}

function normalizeMcpSchemaRecord(args: {
  value: Record<string, unknown>;
  root: unknown;
  resolvingRefs: ReadonlySet<string>;
}): Record<string, unknown> {
  const normalized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args.value)) {
    if (
      (key === 'properties' ||
        key === 'patternProperties' ||
        key === '$defs' ||
        key === 'definitions' ||
        key === 'dependentSchemas') &&
      isRecord(value)
    ) {
      normalized[key] = Object.fromEntries(
        Object.entries(value).map(([name, schema]) => [
          name,
          normalizeMcpSchemaNode({ ...args, value: schema }),
        ]),
      );
      continue;
    }
    normalized[key] = normalizeMcpSchemaNode({ ...args, value });
  }
  return normalized;
}

function resolveLocalMcpSchemaRef(root: unknown, ref: string): unknown {
  if (ref === '#') {
    return root;
  }
  if (!ref.startsWith('#/')) {
    throw new McpServerConfigError(
      `MCP input schema contains an unsupported non-local reference: ${ref}`,
    );
  }
  let current = root;
  for (const rawSegment of ref.slice(2).split('/')) {
    let segment: string;
    try {
      segment = decodeURIComponent(rawSegment)
        .replaceAll('~1', '/')
        .replaceAll('~0', '~');
    } catch {
      throw new McpServerConfigError(
        `MCP input schema contains an invalid local reference: ${ref}`,
      );
    }
    if (!isRecord(current) || !Object.hasOwn(current, segment)) {
      throw new McpServerConfigError(
        `MCP input schema local reference does not resolve: ${ref}`,
      );
    }
    current = current[segment];
  }
  return current;
}

/**
 * MCP 도구의 승낙(grant) 단위는 **서버**다.
 *
 * 사용자가 내린 신뢰 결정은 "이 MCP 서버를 설치했다"이지 "이 해시를
 * 허용한다"가 아니다. 투영 이름(`projectMcpToolName`)은 내용 해시라 사람이
 * "다시 묻지 않기"를 걸 단위가 못 되고, 승인 클래스 문법(소문자 슬러그)도
 * 만족하지 못한다 — base64url은 대문자를 포함한다. `serverId`는 대시를 뺀
 * 소문자 hex라 그 문법을 구성상 만족하므로 슬러그화도 충돌 위험도 없다.
 *
 * 서버 하나 안에서 더 좁혀야 할 이유가 생기면 효과 세그먼트를 덧붙인다
 * (`mcp:<serverId>:destructive`) — 지금 `manage_files:delete`가 쓰는 것과
 * 같은 문법이라 구조를 바꾸지 않고 확장된다.
 */
export function mcpApprovalClass(serverId: string): ApprovalClass {
  return toApprovalClass(`mcp:${serverId}`);
}

export function projectMcpToolName(serverId: string, toolName: string): string {
  if (toolName.length === 0) {
    throw new McpServerConfigError('MCP server published an empty tool name');
  }
  const identity = createHash('sha256')
    .update(serverId)
    .update('\0')
    .update(toolName)
    .digest('base64url');
  return `mcp_${identity}`;
}

export function assertRequestedToolName(toolName: string): void {
  if (toolName.length === 0) {
    throw new McpServerConfigError('MCP tool name is required');
  }
}

export function assertProjectionNamesAvailable(args: {
  projectedTools: Array<{ publicName: string; tool: DiscoveredMcpTool }>;
  currentProjectionNames: ReadonlySet<string>;
  toolRegistry: ToolRegistryStore;
}): void {
  const nextNames = new Set<string>();
  for (const projected of args.projectedTools) {
    if (nextNames.has(projected.publicName)) {
      throw new McpServerConfigError(
        `MCP server published colliding tool names: ${projected.tool.name}`,
      );
    }
    nextNames.add(projected.publicName);
    if (
      !args.currentProjectionNames.has(projected.publicName) &&
      args.toolRegistry.getTool(projected.publicName) !== undefined
    ) {
      throw new McpServerConfigError(
        `MCP tool projection collides with an existing tool: ${projected.publicName}`,
      );
    }
  }
}

export function unregisterProjection(
  live: LiveMcpServer,
  toolRegistry: ToolRegistryStore,
): void {
  for (const name of live.projectedToolNames) {
    toolRegistry.unregisterTool(name);
  }
  live.projectedToolNames.clear();
}
