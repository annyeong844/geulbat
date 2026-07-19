import { createHash } from 'node:crypto';
import { version as esbuildVersion } from 'esbuild';
import {
  REACT_BUNDLE_RUNTIME_ABI_VERSION,
  REACT_BUNDLE_RUNTIME_REACT_MAJOR,
  REACT_BUNDLE_RUNTIME_SHIM_MAP_VERSION,
  type ReactBundleInlineCompileRequest,
} from '@geulbat/protocol/react-bundle-inline-compile';

const REACT_BUNDLE_BUNDLER_VERSION = `esbuild-${esbuildVersion}`;
// Compiler admission and transform policy are daemon-owned execution details,
// not part of the shell/daemon wire or runtime ABI surface.
const REACT_BUNDLE_INLINE_COMPILE_POLICY_VERSION =
  'react-inline-compile-policy-v1';

export function createReactBundleInlineCacheKey(
  input: ReactBundleInlineCompileRequest['input'],
): string {
  const hash = createHash('sha256');
  hash.update(REACT_BUNDLE_RUNTIME_ABI_VERSION);
  hash.update('\0');
  hash.update(String(REACT_BUNDLE_RUNTIME_REACT_MAJOR));
  hash.update('\0');
  hash.update(REACT_BUNDLE_RUNTIME_SHIM_MAP_VERSION);
  hash.update('\0');
  hash.update(REACT_BUNDLE_BUNDLER_VERSION);
  hash.update('\0');
  hash.update(REACT_BUNDLE_INLINE_COMPILE_POLICY_VERSION);
  hash.update('\0');
  hash.update(input.entry);
  hash.update('\0');

  const normalizedPaths = Object.keys(input.files).sort();
  for (const normalizedPath of normalizedPaths) {
    hash.update(normalizedPath);
    hash.update('\0');
    hash.update(input.files[normalizedPath] ?? '');
    hash.update('\0');
  }

  return hash.digest('hex');
}
