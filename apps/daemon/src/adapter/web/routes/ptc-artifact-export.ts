import { basename } from 'node:path';
import { pipeline } from 'node:stream/promises';

import {
  isPtcArtifactExportPolicy,
  isPtcArtifactRelativePath,
  type PtcArtifactExportPolicy,
} from '@geulbat/protocol/ptc-artifacts';
import { Router } from 'express';

import type { PtcArtifactExportServicePort } from '../../../daemon/ptc-artifact-export-service.js';
import {
  sendApiError,
  sendUnexpectedApiError,
} from '#web/response/send-api-error.js';

export function createPtcArtifactExportRoutes(args: {
  service: PtcArtifactExportServicePort;
}): Router {
  const router = Router();

  router.get('/api/ptc-artifact-export/status', async (_req, res) => {
    res.json(await args.service.getStatus());
  });

  router.post('/api/ptc-artifact-export/enable', async (req, res) => {
    const policy = readPolicyInput(req.body);
    if (policy === null) {
      sendApiError(
        res,
        'bad_request',
        'every artifact export limit is required as a positive safe integer',
      );
      return;
    }
    const current = await args.service.getStatus();
    if (current.state === 'ready' && current.source === 'environment') {
      sendApiError(
        res,
        'conflict',
        'PTC artifact export limits are managed by the environment.',
      );
      return;
    }

    await args.service.savePolicy(policy);
    res.json(await args.service.getStatus());
  });

  router.post('/api/ptc-artifact-export/disable', async (_req, res) => {
    const current = await args.service.getStatus();
    if (current.state === 'ready' && current.source === 'environment') {
      sendApiError(
        res,
        'conflict',
        'Environment-managed PTC artifact export limits cannot be removed here.',
      );
      return;
    }

    await args.service.clearPolicy();
    res.json(await args.service.getStatus());
  });

  router.get('/api/ptc-artifacts/file', async (req, res) => {
    const evidenceRef = readSingleQueryValue(req.query['evidenceRef']);
    const relativePath = readSingleQueryValue(req.query['relativePath']);
    const download = readSingleQueryValue(req.query['download']);
    if (
      evidenceRef === null ||
      relativePath === null ||
      !isPtcArtifactRelativePath(relativePath) ||
      (download !== null && download !== '1')
    ) {
      sendApiError(res, 'bad_request', 'PTC artifact file request is invalid');
      return;
    }

    try {
      const openedResult = await args.service.openFile({
        evidenceRef,
        relativePath,
      });
      if (!openedResult.ok) {
        if (
          openedResult.reasonCode === 'not_found' ||
          openedResult.reasonCode === 'file_not_found'
        ) {
          sendApiError(res, 'not_found', 'PTC artifact file was not found');
          return;
        }
        sendApiError(
          res,
          'bad_request',
          'PTC artifact evidence reference is invalid',
        );
        return;
      }
      const opened = openedResult.value;
      const fileName = basename(opened.relativePath);
      res.status(200);
      res.type(opened.relativePath);
      res.setHeader('Content-Length', String(opened.bytes));
      res.setHeader('ETag', `"sha256-${opened.sha256}"`);
      res.setHeader(
        'Content-Security-Policy',
        "sandbox; default-src 'none'; style-src 'unsafe-inline'",
      );
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader(
        'Content-Disposition',
        `${download === '1' ? 'attachment' : 'inline'}; filename*=UTF-8''${encodeURIComponent(fileName)}`,
      );
      await pipeline(opened.handle.createReadStream(), res);
    } catch (error: unknown) {
      if (res.headersSent) {
        res.destroy();
        return;
      }
      sendUnexpectedApiError(res, 'ptc-artifacts/file', error);
    }
  });

  return router;
}

function readPolicyInput(body: unknown): PtcArtifactExportPolicy | null {
  return isPtcArtifactExportPolicy(body) ? body : null;
}

function readSingleQueryValue(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}
