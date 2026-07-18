import { Router, type Response } from 'express';
import { z } from 'zod';

import type {
  McpServerCreateRequest,
  McpServerDeleteResponse,
  McpServerEnabledRequest,
  McpServerListResponse,
  McpServerMutationResponse,
} from '@geulbat/protocol/mcp';
import {
  McpServerConfigError,
  McpServerNotFoundError,
  McpServerOwnershipError,
  type GlobalMcpRuntime,
} from '../../../daemon/mcp/global-mcp-runtime.js';
import {
  sendApiError,
  sendUnexpectedApiError,
} from '#web/response/send-api-error.js';

const stdioTransportSchema = z
  .object({
    kind: z.literal('stdio'),
    command: z.string(),
    args: z.array(z.string()),
    envKeys: z.array(z.string()),
    connectionTimeoutMs: z
      .number()
      .int()
      .positive()
      .max(Number.MAX_SAFE_INTEGER)
      .optional(),
    requestTimeoutMs: z
      .number()
      .int()
      .positive()
      .max(Number.MAX_SAFE_INTEGER)
      .optional(),
    shutdownGraceMs: z
      .number()
      .int()
      .positive()
      .max(Number.MAX_SAFE_INTEGER)
      .optional(),
  })
  .strict();

const createServerSchema = z
  .object({
    name: z.string(),
    enabled: z.boolean().optional(),
    transport: stdioTransportSchema,
  })
  .strict();

const enabledSchema = z.object({ enabled: z.boolean() }).strict();

export function createMcpRoutes(args: { globalMcp: GlobalMcpRuntime }): Router {
  const router = Router();

  router.get('/api/mcp/servers', (_req, res) => {
    const response: McpServerListResponse = {
      servers: args.globalMcp.listServers(),
    };
    res.status(200).json(response);
  });

  router.post('/api/mcp/servers', async (req, res) => {
    const parsed = createServerSchema.safeParse(req.body);
    if (!parsed.success) {
      sendApiError(res, 'bad_request', 'invalid MCP server registration');
      return;
    }
    await respondWithMcpMutation(res, async () => {
      const request: McpServerCreateRequest = {
        name: parsed.data.name,
        transport: {
          kind: 'stdio',
          command: parsed.data.transport.command,
          args: parsed.data.transport.args,
          envKeys: parsed.data.transport.envKeys,
          ...(parsed.data.transport.connectionTimeoutMs === undefined
            ? {}
            : {
                connectionTimeoutMs: parsed.data.transport.connectionTimeoutMs,
              }),
          ...(parsed.data.transport.requestTimeoutMs === undefined
            ? {}
            : { requestTimeoutMs: parsed.data.transport.requestTimeoutMs }),
          ...(parsed.data.transport.shutdownGraceMs === undefined
            ? {}
            : { shutdownGraceMs: parsed.data.transport.shutdownGraceMs }),
        },
        ...(parsed.data.enabled === undefined
          ? {}
          : { enabled: parsed.data.enabled }),
      };
      const response: McpServerMutationResponse = {
        server: await args.globalMcp.addServer(request),
      };
      res.status(201).json(response);
    });
  });

  router.patch('/api/mcp/servers/:serverId/enabled', async (req, res) => {
    const serverId = readServerId(req.params['serverId']);
    const parsed = enabledSchema.safeParse(req.body);
    if (serverId === null || !parsed.success) {
      sendApiError(res, 'bad_request', 'invalid MCP server enabled request');
      return;
    }
    await respondWithMcpMutation(res, async () => {
      const request: McpServerEnabledRequest = parsed.data;
      const response: McpServerMutationResponse = {
        server: await args.globalMcp.setServerEnabled(
          serverId,
          request.enabled,
        ),
      };
      res.status(200).json(response);
    });
  });

  router.put('/api/mcp/servers/:serverId/tools/:toolName', async (req, res) => {
    const serverId = readServerId(req.params['serverId']);
    const toolName = readToolName(req.params['toolName']);
    if (serverId === null || toolName === null || !hasEmptyBody(req.body)) {
      sendApiError(res, 'bad_request', 'invalid MCP tool install request');
      return;
    }
    await respondWithMcpMutation(res, async () => {
      const response: McpServerMutationResponse = {
        server: await args.globalMcp.installTool(serverId, toolName),
      };
      res.status(200).json(response);
    });
  });

  router.delete(
    '/api/mcp/servers/:serverId/tools/:toolName',
    async (req, res) => {
      const serverId = readServerId(req.params['serverId']);
      const toolName = readToolName(req.params['toolName']);
      if (serverId === null || toolName === null || !hasEmptyBody(req.body)) {
        sendApiError(res, 'bad_request', 'invalid MCP tool remove request');
        return;
      }
      await respondWithMcpMutation(res, async () => {
        const response: McpServerMutationResponse = {
          server: await args.globalMcp.uninstallTool(serverId, toolName),
        };
        res.status(200).json(response);
      });
    },
  );

  router.delete('/api/mcp/servers/:serverId', async (req, res) => {
    const serverId = readServerId(req.params['serverId']);
    if (serverId === null) {
      sendApiError(res, 'bad_request', 'invalid MCP server id');
      return;
    }
    await respondWithMcpMutation(res, async () => {
      await args.globalMcp.removeServer(serverId);
      const response: McpServerDeleteResponse = { removedServerId: serverId };
      res.status(200).json(response);
    });
  });

  return router;
}

async function respondWithMcpMutation(
  res: Response,
  operation: () => Promise<void>,
): Promise<void> {
  try {
    await operation();
  } catch (error: unknown) {
    if (error instanceof McpServerNotFoundError) {
      sendApiError(res, 'not_found', error.message);
      return;
    }
    if (error instanceof McpServerConfigError) {
      sendApiError(res, 'bad_request', error.message);
      return;
    }
    if (error instanceof McpServerOwnershipError) {
      sendApiError(res, 'conflict', error.message);
      return;
    }
    sendUnexpectedApiError(res, 'web/mcp', error);
  }
}

function readServerId(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

function readToolName(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function hasEmptyBody(value: unknown): boolean {
  return (
    value === undefined ||
    (typeof value === 'object' &&
      value !== null &&
      !Array.isArray(value) &&
      Object.keys(value).length === 0)
  );
}
