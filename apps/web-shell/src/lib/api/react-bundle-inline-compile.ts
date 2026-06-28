import {
  isReactBundleInlineCompileInputRefResponse,
  isReactBundleInlineCompileResponse,
  type ReactBundleInlineCompileResponse,
  type ReactBundleInlineSourceInput,
} from '@geulbat/protocol/react-bundle-inline-compile';
import { DEFAULT_PROJECT_ID, type ProjectId } from '@geulbat/protocol/ids';
import { getErrorMessage } from '@geulbat/shared-utils/error';
import { createLogger } from '@geulbat/shared-utils/logger';

import { apiFetch, isApiOkResponse } from './client.js';

const logger = createLogger('api/react-bundle-inline-compile');

export async function compileReactBundleInlineSource(
  input: ReactBundleInlineSourceInput,
  projectId: ProjectId = DEFAULT_PROJECT_ID,
): Promise<ReactBundleInlineCompileResponse> {
  const uploaded = await apiFetch(
    `/api/react-bundle-inline-compile/inputs?projectId=${encodeURIComponent(projectId)}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
      body: JSON.stringify(input),
    },
    isReactBundleInlineCompileInputRefResponse,
  );

  try {
    return await apiFetch(
      `/api/react-bundle-inline-compile?projectId=${encodeURIComponent(projectId)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          renderer: 'react_bundle',
          inputRef: uploaded.inputRef,
        }),
      },
      isReactBundleInlineCompileResponse,
    );
  } catch (error: unknown) {
    await cleanupReactBundleInlineCompileInputRefAfterFailure(
      projectId,
      uploaded.inputRef,
      error,
    );
    throw error;
  }
}

async function cleanupReactBundleInlineCompileInputRefAfterFailure(
  projectId: ProjectId,
  inputRef: string,
  originalError: unknown,
): Promise<void> {
  try {
    await apiFetch(
      `/api/react-bundle-inline-compile/inputs?projectId=${encodeURIComponent(
        projectId,
      )}&inputRef=${encodeURIComponent(inputRef)}`,
      { method: 'DELETE' },
      isApiOkResponse,
    );
  } catch (cleanupError: unknown) {
    logger.warn(
      'failed to delete uploaded react bundle inline compile input ref after failure:',
      {
        inputRef,
        originalError: getErrorMessage(originalError),
        cleanupError: getErrorMessage(cleanupError),
      },
    );
  }
}
