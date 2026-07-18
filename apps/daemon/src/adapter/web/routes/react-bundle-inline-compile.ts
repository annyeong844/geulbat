import { Router, type Response } from 'express';
import {
  decodeReactBundleInlineCompileRequest,
  decodeReactBundleInlineSourceInput,
  type ReactBundleInlineCompileInputRefResponse,
  type ReactBundleInlineCompileResponse,
  type ReactBundleInlineCompileRequest,
  type ReactBundleInlineCompileRouteRequest,
} from '@geulbat/protocol/react-bundle-inline-compile';
import { compileReactBundleInlineSource } from '../../../daemon/react-bundle-inline/compile-service.js';
import { readGeneratedReactBundleInlineAsset } from '../../../daemon/react-bundle-inline/generated-assets.js';
import {
  deleteReactBundleInlineCompileInputRefPath,
  readReactBundleInlineCompileInputRef,
  readReactBundleInlineCompileInputRefPath,
  writeReactBundleInlineCompileInputRefFromStream,
} from '../../../daemon/react-bundle-inline/input-ref-store.js';
import { tryParseJson } from '../../../daemon/runtime-json.js';
import {
  sendApiError,
  sendUnexpectedApiError,
} from '#web/response/send-api-error.js';
import { registerInputRefDeleteRoute } from './input-ref-routes.js';

export function createReactBundleInlineCompileRoutes(args: {
  homeStateRoot: string;
}): Router {
  const router = Router();

  router.post('/api/react-bundle-inline-compile/inputs', async (req, res) => {
    if (req.is('application/json')) {
      sendApiError(
        res,
        'bad_request',
        'react bundle inline compile input upload must use a streaming content type',
      );
      return;
    }

    try {
      const result = await writeReactBundleInlineCompileInputRefFromStream({
        workspaceRoot: args.homeStateRoot,
        input: req,
      });
      const response: ReactBundleInlineCompileInputRefResponse = {
        ok: true,
        ...result,
      };
      res.status(201).json(response);
    } catch (error: unknown) {
      sendUnexpectedApiError(res, 'react-bundle-inline-compile/inputs', error);
    }
  });

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

    try {
      const resolvedRequest = await resolveReactBundleInlineCompileRequest({
        request: decoded.value,
        homeStateRoot: args.homeStateRoot,
      });
      if (!resolvedRequest.ok) {
        if (resolvedRequest.kind === 'api_error') {
          sendApiError(res, resolvedRequest.code, resolvedRequest.message);
          return;
        }
        const response: ReactBundleInlineCompileResponse = {
          ok: false,
          code: resolvedRequest.code,
          detail: resolvedRequest.detail,
        };
        res.status(200).json(response);
        return;
      }

      const compiled = await compileReactBundleInlineSource({
        request: resolvedRequest.value,
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
    } catch (error: unknown) {
      sendUnexpectedApiError(res, 'react-bundle-inline-compile', error);
    }
  });

  registerInputRefDeleteRoute({
    router,
    path: '/api/react-bundle-inline-compile/inputs',
    resolveWorkspaceRoot: () => args.homeStateRoot,
    refQueryName: 'inputRef',
    logContext: 'react-bundle-inline-compile/inputs/delete',
    readRefPath: ({ workspaceRoot, ref }) =>
      readReactBundleInlineCompileInputRefPath({
        workspaceRoot,
        inputRef: ref,
      }),
    deleteRefPath: deleteReactBundleInlineCompileInputRefPath,
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

async function resolveReactBundleInlineCompileRequest(args: {
  request: ReactBundleInlineCompileRouteRequest;
  homeStateRoot: string;
}): Promise<
  | { ok: true; value: ReactBundleInlineCompileRequest }
  | {
      ok: false;
      kind: 'api_error';
      code: 'bad_request' | 'conflict' | 'not_found';
      message: string;
    }
  | {
      ok: false;
      kind: 'compile_failure';
      code: 'sanitize_rejected';
      detail: string;
    }
> {
  if ('input' in args.request) {
    return { ok: true, value: args.request };
  }

  const refInput = await readReactBundleInlineCompileInputRef({
    workspaceRoot: args.homeStateRoot,
    inputRef: args.request.inputRef,
  });
  if (!refInput.ok) {
    return {
      ok: false,
      kind: 'api_error',
      code: refInput.code,
      message: refInput.message,
    };
  }

  try {
    const parsedInput = tryParseJson(refInput.rawInput);
    if (!parsedInput.ok) {
      return {
        ok: false,
        kind: 'compile_failure',
        code: 'sanitize_rejected',
        detail:
          'react bundle inline compile inputRef must contain valid inline source JSON',
      };
    }

    const decodedInput = decodeReactBundleInlineSourceInput(parsedInput.value);
    if (!decodedInput.ok) {
      return {
        ok: false,
        kind: 'compile_failure',
        code: decodedInput.code,
        detail: decodedInput.detail,
      };
    }

    return {
      ok: true,
      value: {
        renderer: 'react_bundle',
        input: decodedInput.value,
      },
    };
  } finally {
    await deleteReactBundleInlineCompileInputRefPath(refInput.path);
  }
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
