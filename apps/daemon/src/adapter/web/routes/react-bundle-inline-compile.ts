import { Router, type Response } from 'express';
import {
  decodeReactBundleInlineCompileRequest,
  type ReactBundleInlineCompileResponse,
} from '@geulbat/protocol/react-bundle-inline-compile';
import { compileReactBundleInlineSource } from '../../../daemon/react-bundle-inline/compile-service.js';
import { readGeneratedReactBundleInlineAsset } from '../../../daemon/react-bundle-inline/generated-assets.js';

export function createReactBundleInlineCompileRoutes(): Router {
  const router = Router();

  router.post('/api/react-bundle-inline-compile', async (req, res) => {
    const decoded = decodeReactBundleInlineCompileRequest(req.body);
    if (!decoded.ok) {
      const response: ReactBundleInlineCompileResponse = {
        ok: false,
        code: decoded.code,
        detail: decoded.detail,
      };
      res.status(200).json(response);
      return;
    }

    const compiled = await compileReactBundleInlineSource({
      request: decoded.value,
      requestOrigin: buildRequestOrigin(req),
    });
    const response: ReactBundleInlineCompileResponse = compiled.ok
      ? {
          ok: true,
          manifest: compiled.value.manifest,
        }
      : {
          ok: false,
          code: compiled.code,
          detail: compiled.detail,
        };
    res.status(200).json(response);
  });

  return router;
}

export function createPublicReactBundleInlineGeneratedAssetRoutes(): Router {
  const router = Router();

  router.get(
    /^\/public-generated\/react-bundle-inline\/(.+)$/,
    async (req, res) => {
      const asset = await readGeneratedReactBundleInlineAsset(req.path);
      if (!asset) {
        res.status(404).end();
        return;
      }

      sendGeneratedJavascriptAsset(res, asset.contentType, asset.body);
    },
  );

  return router;
}

function buildRequestOrigin(req: {
  protocol: string;
  get(name: string): string | undefined;
}): string {
  const host = req.get('host');
  if (!host) {
    throw new Error('react bundle inline compile route requires request host');
  }
  return `${req.protocol}://${host}`;
}

function sendGeneratedJavascriptAsset(
  res: Response,
  contentType: string,
  body: Buffer,
): void {
  res.setHeader('Content-Type', contentType);
  res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.status(200).send(body);
}
