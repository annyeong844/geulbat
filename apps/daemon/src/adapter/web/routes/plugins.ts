import {
  isPluginEnabledRequest,
  isPluginInstallRequest,
  isPluginMarketplaceAddRequest,
  isPluginMarketplaceInstallRequest,
  type PluginDeleteResponse,
  type PluginListResponse,
  type PluginMarketplaceDeleteResponse,
  type PluginMarketplaceListResponse,
  type PluginMarketplaceMutationResponse,
  type PluginMutationResponse,
  type PluginSkillListResponse,
} from '@geulbat/protocol/plugins';
import { createReadStream } from 'node:fs';
import { Router, type Response } from 'express';

import {
  PluginStoreError,
  type PluginStore,
} from '../../../daemon/extensions/plugin-store.js';
import {
  PluginMarketplaceStoreError,
  type PluginMarketplaceStore,
} from '../../../daemon/extensions/plugin-marketplace-store.js';
import type { PluginSkillRuntime } from '../../../daemon/extensions/plugin-skill-runtime.js';
import type { ComputerFileScope } from '../../../daemon/files/computer-file-scope.js';
import {
  sendApiError,
  sendUnexpectedApiError,
} from '#web/response/send-api-error.js';

export function createPluginRoutes(args: {
  plugins: PluginStore;
  pluginSkills: PluginSkillRuntime;
  marketplaces: PluginMarketplaceStore;
  computerFileScope?: ComputerFileScope | undefined;
}): Router {
  const router = Router();

  router.get('/api/plugins', (_req, res) => {
    const response: PluginListResponse = {
      plugins: args.plugins.listPlugins(),
    };
    res.status(200).json(response);
  });

  router.get('/api/plugins/marketplaces', (_req, res) => {
    const response: PluginMarketplaceListResponse = args.marketplaces.list(
      args.plugins.listPlugins(),
    );
    res.status(200).json(response);
  });

  router.post('/api/plugins/marketplaces/official', async (req, res) => {
    if (!hasNoRequestBody(req.body)) {
      sendApiError(
        res,
        'bad_request',
        'the official marketplace sync does not accept source configuration',
      );
      return;
    }
    await respondWithPluginOperation(res, async () => {
      const response: PluginMarketplaceMutationResponse = {
        marketplace: await args.marketplaces.ensureOfficialMarketplace(),
      };
      res.status(200).json(response);
    });
  });

  router.post('/api/plugins/marketplaces', async (req, res) => {
    const request: unknown = req.body;
    if (!isPluginMarketplaceAddRequest(request)) {
      sendApiError(res, 'bad_request', 'invalid marketplace source request');
      return;
    }
    await respondWithPluginOperation(res, async () => {
      const response: PluginMarketplaceMutationResponse = {
        marketplace: await args.marketplaces.add(request),
      };
      res.status(201).json(response);
    });
  });

  router.get(
    '/api/plugins/marketplaces/:marketplaceId/entries/:entryId/icon',
    async (req, res) => {
      const marketplaceId = readIdentity(req.params['marketplaceId']);
      const entryId = readIdentity(req.params['entryId']);
      if (marketplaceId === null || entryId === null) {
        sendApiError(res, 'bad_request', 'invalid marketplace icon identity');
        return;
      }
      await respondWithPluginOperation(res, async () => {
        const icon = await args.marketplaces.resolveEntryIcon(
          marketplaceId,
          entryId,
        );
        if (icon === null) {
          sendApiError(res, 'not_found', 'marketplace plugin icon not found');
          return;
        }
        res.status(200);
        res.setHeader('Content-Type', icon.contentType);
        res.setHeader('Content-Disposition', 'inline');
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.setHeader('Content-Security-Policy', 'sandbox');
        const stream = createReadStream(icon.absolutePath);
        stream.once('error', (error) => {
          if (res.headersSent) {
            res.destroy(error);
          } else {
            sendUnexpectedApiError(res, 'web/plugins/icon', error);
          }
        });
        stream.pipe(res);
      });
    },
  );

  router.post('/api/plugins/marketplaces/install', async (req, res) => {
    const request: unknown = req.body;
    if (!isPluginMarketplaceInstallRequest(request)) {
      sendApiError(res, 'bad_request', 'invalid marketplace install request');
      return;
    }
    await respondWithPluginOperation(res, async () => {
      const candidate =
        await args.marketplaces.resolveInstallCandidate(request);
      const response: PluginMutationResponse = {
        plugin: await args.plugins.installMarketplacePlugin(candidate),
      };
      res.status(201).json(response);
    });
  });

  router.delete(
    '/api/plugins/marketplaces/:marketplaceId',
    async (req, res) => {
      const marketplaceId = readIdentity(req.params['marketplaceId']);
      if (marketplaceId === null) {
        sendApiError(res, 'bad_request', 'invalid marketplace identity');
        return;
      }
      await respondWithPluginOperation(res, async () => {
        await args.marketplaces.remove(marketplaceId);
        const response: PluginMarketplaceDeleteResponse = {
          removedMarketplaceId: marketplaceId,
        };
        res.status(200).json(response);
      });
    },
  );

  router.get('/api/plugins/skills', async (_req, res) => {
    await respondWithPluginOperation(res, async () => {
      const inventory = await args.pluginSkills.listPluginSkills({
        includeDisabled: true,
      });
      const response: PluginSkillListResponse = {
        skills: inventory.skills.map((skill) => ({
          skillRef: skill.skillRef,
          name: skill.name,
          description: skill.description,
          enabled: skill.enabled,
          allowImplicitInvocation: skill.allowImplicitInvocation,
          runtimeStatus: skill.runtimeStatus,
          pluginInstallationId: skill.sourcePlugin.installationId,
          pluginName: skill.sourcePlugin.name,
          pluginDisplayName: skill.sourcePlugin.displayName,
          pluginVersion: skill.sourcePlugin.version,
        })),
        diagnostics: inventory.diagnostics.map((diagnostic) => ({
          pluginInstallationId: diagnostic.pluginInstallationId,
          pluginName: diagnostic.pluginName,
          code: diagnostic.code,
          message: diagnostic.message,
        })),
      };
      res.status(200).json(response);
    });
  });

  router.post('/api/plugins', async (req, res) => {
    const request: unknown = req.body;
    if (!isPluginInstallRequest(request)) {
      sendApiError(res, 'bad_request', 'invalid plugin install request');
      return;
    }
    await respondWithPluginOperation(res, async () => {
      const response: PluginMutationResponse = {
        plugin: await args.plugins.installPlugin(
          request,
          args.computerFileScope,
        ),
      };
      res.status(201).json(response);
    });
  });

  router.patch('/api/plugins/:installationId/enabled', async (req, res) => {
    const installationId = readIdentity(req.params['installationId']);
    const request: unknown = req.body;
    if (installationId === null || !isPluginEnabledRequest(request)) {
      sendApiError(res, 'bad_request', 'invalid plugin enabled request');
      return;
    }
    await respondWithPluginOperation(res, async () => {
      const response: PluginMutationResponse = {
        plugin: await args.plugins.setEnabled(installationId, request.enabled),
      };
      res.status(200).json(response);
    });
  });

  router.delete('/api/plugins/:installationId', async (req, res) => {
    const installationId = readIdentity(req.params['installationId']);
    if (installationId === null) {
      sendApiError(res, 'bad_request', 'invalid plugin installation id');
      return;
    }
    await respondWithPluginOperation(res, async () => {
      await args.plugins.uninstall(installationId);
      const response: PluginDeleteResponse = {
        removedInstallationId: installationId,
      };
      res.status(200).json(response);
    });
  });

  return router;
}

async function respondWithPluginOperation(
  res: Response,
  operation: () => Promise<void>,
): Promise<void> {
  try {
    await operation();
  } catch (error: unknown) {
    if (
      error instanceof PluginStoreError ||
      error instanceof PluginMarketplaceStoreError
    ) {
      if (error.code === 'invalid_request') {
        sendApiError(res, 'bad_request', error.message);
        return;
      }
      if (error.code === 'not_found') {
        sendApiError(res, 'not_found', error.message);
        return;
      }
      if (error.code === 'conflict') {
        sendApiError(res, 'conflict', error.message);
        return;
      }
    }
    sendUnexpectedApiError(res, 'web/plugins', error);
  }
}

function readIdentity(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

function hasNoRequestBody(value: unknown): boolean {
  return (
    value === undefined ||
    (typeof value === 'object' &&
      value !== null &&
      !Array.isArray(value) &&
      Object.keys(value).length === 0)
  );
}
