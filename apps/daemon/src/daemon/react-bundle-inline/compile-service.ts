import type {
  ReactBundleInlineCompileFailureCode,
  ReactBundleInlineCompileRequest,
  ReactBundleRuntimeManifest,
} from '@geulbat/protocol/react-bundle-inline-compile';
import { buildReactBundleInlineOutputFiles } from './build.js';
import { createReactBundleInlineCacheKey } from './cache-key.js';
import {
  buildGeneratedReactBundleInlineManifest,
  readGeneratedReactBundleInlineManifest,
  writeGeneratedReactBundleInlineOutput,
} from './generated-assets.js';

export async function compileReactBundleInlineSource(args: {
  request: ReactBundleInlineCompileRequest;
  requestOrigin: string;
}): Promise<
  | {
      ok: true;
      value: {
        cacheKey: string;
        manifest: ReactBundleRuntimeManifest;
      };
    }
  | {
      ok: false;
      code: ReactBundleInlineCompileFailureCode;
      detail: string;
    }
> {
  const { request, requestOrigin } = args;
  const cacheKey = createReactBundleInlineCacheKey(request.input);
  const existingManifest = await readGeneratedReactBundleInlineManifest({
    cacheKey,
    requestOrigin,
  });
  if (existingManifest) {
    return {
      ok: true,
      value: {
        cacheKey,
        manifest: existingManifest,
      },
    };
  }

  const buildResult = await buildReactBundleInlineOutputFiles({ request });
  if (!buildResult.ok) {
    return buildResult;
  }
  if (!buildResult.value.outputFiles) {
    return {
      ok: false,
      code: 'boot_failed',
      detail: 'react bundle inline compile did not emit output files',
    };
  }

  await writeGeneratedReactBundleInlineOutput({
    cacheKey,
    outputFiles: buildResult.value.outputFiles,
  });

  return {
    ok: true,
    value: {
      cacheKey,
      manifest: buildGeneratedReactBundleInlineManifest({
        cacheKey,
        requestOrigin,
      }),
    },
  };
}
