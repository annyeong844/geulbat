import { build, type BuildResult } from 'esbuild';
import {
  type ReactBundleInlineCompileFailureCode,
  type ReactBundleInlineCompileRequest,
} from '@geulbat/protocol/react-bundle-inline-compile';
import { createReactBundleInlinePlugin } from './inline-plugin.js';

export async function buildReactBundleInlineOutputFiles(args: {
  request: ReactBundleInlineCompileRequest;
}): Promise<
  | {
      ok: true;
      value: BuildResult;
    }
  | {
      ok: false;
      code: ReactBundleInlineCompileFailureCode;
      detail: string;
    }
> {
  const { request } = args;

  try {
    const outputFiles = await build({
      entryPoints: ['__geulbat_inline_entry_wrapper__'],
      bundle: true,
      splitting: true,
      write: false,
      format: 'esm',
      platform: 'browser',
      target: ['es2022'],
      outdir: '/out',
      entryNames: 'entry',
      chunkNames: 'chunks/[name]-[hash]',
      assetNames: 'assets/[name]-[hash]',
      logLevel: 'silent',
      jsx: 'automatic',
      plugins: [
        createReactBundleInlinePlugin({
          files: request.input.files,
          entry: request.input.entry,
        }),
      ],
    });

    return {
      ok: true,
      value: outputFiles,
    };
  } catch (error: unknown) {
    return classifyBuildError(error);
  }
}

function classifyBuildError(error: unknown): {
  ok: false;
  code: ReactBundleInlineCompileFailureCode;
  detail: string;
} {
  const customCode =
    typeof error === 'object' && error && 'code' in error
      ? error.code
      : undefined;
  if (
    customCode === 'sanitize_rejected' ||
    customCode === 'policy_blocked' ||
    customCode === 'boot_failed' ||
    customCode === 'runtime_crashed'
  ) {
    return {
      ok: false,
      code: customCode,
      detail:
        error instanceof Error
          ? error.message
          : 'react bundle inline compile failed',
    };
  }

  const errorMessage = extractEsbuildErrorText(error);
  const prefixedMatch =
    /^\[(sanitize_rejected|policy_blocked|boot_failed|runtime_crashed)\]\s*(.+)$/s.exec(
      errorMessage,
    );
  if (prefixedMatch?.[1] && prefixedMatch[2]) {
    return {
      ok: false,
      code: prefixedMatch[1] as ReactBundleInlineCompileFailureCode,
      detail: prefixedMatch[2],
    };
  }

  return {
    ok: false,
    code: 'boot_failed',
    detail: errorMessage,
  };
}

function extractEsbuildErrorText(error: unknown): string {
  if (typeof error === 'object' && error && 'errors' in error) {
    const errors = error.errors;
    if (Array.isArray(errors) && errors.length > 0) {
      const firstError = errors[0];
      if (
        typeof firstError === 'object' &&
        firstError &&
        'text' in firstError &&
        typeof firstError.text === 'string'
      ) {
        return firstError.text;
      }
    }
  }

  if (error instanceof Error && error.message.trim()) {
    return error.message;
  }

  return 'react bundle inline compile failed';
}
