import {
  isReactBundleInlineCompileResponse,
  type ReactBundleInlineCompileResponse,
  type ReactBundleInlineSourceInput,
} from '@geulbat/protocol/react-bundle-inline-compile';

import { apiFetch } from './client.js';

export function compileReactBundleInlineSource(
  input: ReactBundleInlineSourceInput,
): Promise<ReactBundleInlineCompileResponse> {
  return apiFetch(
    '/api/react-bundle-inline-compile',
    {
      method: 'POST',
      body: JSON.stringify({
        renderer: 'react_bundle',
        input,
      }),
    },
    isReactBundleInlineCompileResponse,
  );
}
