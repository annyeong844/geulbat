import { Router } from 'express';
import {
  isInputRefRecoveryAction,
  type InputRefInventoryEntry,
  type InputRefInventoryResponse,
  type InputRefRecoveryAction,
  type InputRefRecoveryResponse,
} from '@geulbat/protocol/input-refs';
import { isRecord } from '@geulbat/protocol/runtime-utils';

import { ARTIFACT_RUNTIME_STATE_INPUT_REF_STORE } from '../../../daemon/artifact-runtime-persistence/input-ref-store.js';
import { FILE_BINARY_INPUT_REF_STORE } from '../../../daemon/files/binary-input-ref-store.js';
import { REACT_BUNDLE_INLINE_COMPILE_INPUT_REF_STORE } from '../../../daemon/react-bundle-inline/input-ref-store.js';
import { RUN_PROMPT_INPUT_REF_STORE } from '../../../daemon/sessions/prompt-input-ref-store.js';
import {
  listInputRefFiles,
  recoverInputRefFile,
  type InputRefFileRecoveryResult,
  type InputRefFileStoreConfig,
} from '../../../daemon/utils/input-ref-file-store.js';
import {
  readProjectWorkspaceScopeFromBody,
  readProjectWorkspaceScopeFromQuery,
} from '#web/request/project-scope.js';
import { readRequiredBodyStrings } from '#web/request/string-fields.js';
import {
  sendApiError,
  sendUnexpectedApiError,
} from '#web/response/send-api-error.js';
import type { ProjectScopedRoutesContext } from './routes-context.js';

const INPUT_REF_STORES = Object.freeze([
  RUN_PROMPT_INPUT_REF_STORE,
  FILE_BINARY_INPUT_REF_STORE,
  ARTIFACT_RUNTIME_STATE_INPUT_REF_STORE,
  REACT_BUNDLE_INLINE_COMPILE_INPUT_REF_STORE,
]);

export function createInputRefRoutes(args: {
  projectRegistry: ProjectScopedRoutesContext['projectRegistry'];
}): Router {
  const router = Router();
  const { projectRegistry } = args;

  router.get('/api/input-refs', async (req, res) => {
    const projectScope = readProjectWorkspaceScopeFromQuery(
      req.query['projectId'],
      { projectRegistry },
    );
    if (!projectScope.ok) {
      sendApiError(res, projectScope.code, projectScope.message);
      return;
    }
    try {
      res.json(await listProjectInputRefs(projectScope.workspaceRoot));
    } catch (error: unknown) {
      sendUnexpectedApiError(res, 'input-refs/list', error);
    }
  });

  router.post('/api/input-refs/recovery', async (req, res) => {
    const body = isRecord(req.body) ? req.body : undefined;
    const projectScope = readProjectWorkspaceScopeFromBody(body, {
      projectRegistry,
    });
    if (!projectScope.ok) {
      sendApiError(res, projectScope.code, projectScope.message);
      return;
    }
    const required = readRequiredBodyStrings(body, ['ref', 'action']);
    if (!required.ok) {
      sendApiError(res, 'bad_request', required.message);
      return;
    }
    if (!isInputRefRecoveryAction(required.values.action)) {
      sendApiError(res, 'bad_request', 'action must be retry or release');
      return;
    }
    const rawClaimId = body?.['claimId'];
    if (rawClaimId !== undefined && typeof rawClaimId !== 'string') {
      sendApiError(res, 'bad_request', 'claimId must be a string');
      return;
    }

    try {
      const result = await recoverProjectInputRef({
        workspaceRoot: projectScope.workspaceRoot,
        ref: required.values.ref,
        action: required.values.action,
        ...(rawClaimId !== undefined ? { claimId: rawClaimId } : {}),
      });
      if (!result.ok) {
        sendApiError(res, result.code, result.message);
        return;
      }
      const response: InputRefRecoveryResponse = {
        ok: true,
        disposition: result.disposition,
      };
      res.json(response);
    } catch (error: unknown) {
      sendUnexpectedApiError(res, 'input-refs/recovery', error);
    }
  });

  return router;
}

async function listProjectInputRefs(
  workspaceRoot: string,
): Promise<InputRefInventoryResponse> {
  const storedEntries = (
    await Promise.all(
      INPUT_REF_STORES.map((config) =>
        listInputRefFiles({ workspaceRoot, config }),
      ),
    )
  ).flat();
  const entries = storedEntries
    .map(toInputRefInventoryEntry)
    .sort(compareInputRefInventoryEntries);
  return {
    ok: true,
    entries,
    totalByteLength: entries.reduce(
      (total, entry) => total + entry.byteLength,
      0,
    ),
  };
}

async function recoverProjectInputRef(args: {
  workspaceRoot: string;
  ref: string;
  action: InputRefRecoveryAction;
  claimId?: string;
}): Promise<InputRefFileRecoveryResult> {
  const config = findInputRefStore(args.ref);
  if (config === undefined) {
    return {
      ok: false,
      code: 'bad_request',
      message: 'ref must identify a supported input reference.',
    };
  }
  return recoverInputRefFile({ ...args, config });
}

function findInputRefStore(ref: string): InputRefFileStoreConfig | undefined {
  return INPUT_REF_STORES.find((config) => ref.startsWith(config.refPrefix));
}

function toInputRefInventoryEntry(
  stored: Awaited<ReturnType<typeof listInputRefFiles>>[number],
): InputRefInventoryEntry {
  return stored.state === 'pending'
    ? {
        ref: stored.ref,
        kind: stored.kind,
        state: stored.state,
        byteLength: stored.byteLength,
        createdAt: stored.createdAt,
      }
    : {
        ref: stored.ref,
        kind: stored.kind,
        state: stored.state,
        byteLength: stored.byteLength,
        createdAt: stored.createdAt,
        claimId: stored.claimId,
      };
}

function compareInputRefInventoryEntries(
  left: InputRefInventoryEntry,
  right: InputRefInventoryEntry,
): number {
  return (
    left.createdAt.localeCompare(right.createdAt) ||
    left.kind.localeCompare(right.kind) ||
    left.ref.localeCompare(right.ref) ||
    (left.claimId ?? '').localeCompare(right.claimId ?? '')
  );
}
