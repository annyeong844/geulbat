import { Router } from 'express';
import {
  isInputRefRecoveryAction,
  type InputRefInventoryEntry,
  type InputRefInventoryResponse,
  type InputRefRecoveryAction,
  type InputRefRecoveryResponse,
} from '@geulbat/protocol/input-refs';
import { isRecord } from '../../../daemon/runtime-json.js';

import { ARTIFACT_RUNTIME_STATE_INPUT_REF_STORE } from '../../../daemon/artifact-runtime-persistence/input-ref-store.js';
import { FILE_BINARY_INPUT_REF_STORE } from '../../../daemon/files/binary-input-ref-store.js';
import type { ComputerFileScope } from '../../../daemon/files/computer-file-scope.js';
import { REACT_BUNDLE_INLINE_COMPILE_INPUT_REF_STORE } from '../../../daemon/react-bundle-inline/input-ref-store.js';
import { RUN_PROMPT_INPUT_REF_STORE } from '../../../daemon/sessions/prompt-input-ref-store.js';
import {
  listInputRefFiles,
  recoverInputRefFile,
  type InputRefFileRecoveryResult,
  type InputRefFileStoreConfig,
} from '../../../daemon/utils/input-ref-file-store.js';
import { readRequiredBodyStrings } from '#web/request/string-fields.js';
import {
  sendApiError,
  sendUnexpectedApiError,
} from '#web/response/send-api-error.js';
const HOME_INPUT_REF_STORES = Object.freeze([
  RUN_PROMPT_INPUT_REF_STORE,
  ARTIFACT_RUNTIME_STATE_INPUT_REF_STORE,
  REACT_BUNDLE_INLINE_COMPILE_INPUT_REF_STORE,
]);

export function createInputRefRoutes(args: {
  homeStateRoot: string;
  computerFileScope?: ComputerFileScope;
}): Router {
  const router = Router();

  router.get('/api/input-refs', async (req, res) => {
    if (req.query['projectId'] !== undefined) {
      sendApiError(res, 'bad_request', 'projectId is not supported');
      return;
    }
    try {
      res.json(await listInputRefs(args));
    } catch (error: unknown) {
      sendUnexpectedApiError(res, 'input-refs/list', error);
    }
  });

  router.post('/api/input-refs/recovery', async (req, res) => {
    const body = isRecord(req.body) ? req.body : undefined;
    if (body && 'projectId' in body) {
      sendApiError(res, 'bad_request', 'projectId is not supported');
      return;
    }
    const required = readRequiredBodyStrings(body, ['ref', 'action']);
    if (!required.ok) {
      sendApiError(res, 'bad_request', required.message);
      return;
    }
    const action = required.read('action');
    if (!isInputRefRecoveryAction(action)) {
      sendApiError(res, 'bad_request', 'action must be retry or release');
      return;
    }
    const rawClaimId = body?.['claimId'];
    if (rawClaimId !== undefined && typeof rawClaimId !== 'string') {
      sendApiError(res, 'bad_request', 'claimId must be a string');
      return;
    }

    try {
      const result = await recoverInputRef({
        ...args,
        ref: required.read('ref'),
        action,
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

async function listInputRefs(args: {
  homeStateRoot: string;
  computerFileScope?: ComputerFileScope;
}): Promise<InputRefInventoryResponse> {
  const storeOwners = [
    ...HOME_INPUT_REF_STORES.map((config) => ({
      config,
      workspaceRoot: args.homeStateRoot,
    })),
    ...(args.computerFileScope === undefined
      ? []
      : [
          {
            config: FILE_BINARY_INPUT_REF_STORE,
            workspaceRoot: args.computerFileScope.root,
          },
        ]),
  ];
  const storedEntries = (
    await Promise.all(
      storeOwners.map(({ config, workspaceRoot }) =>
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

async function recoverInputRef(args: {
  homeStateRoot: string;
  computerFileScope?: ComputerFileScope;
  ref: string;
  action: InputRefRecoveryAction;
  claimId?: string;
}): Promise<InputRefFileRecoveryResult> {
  const storeOwner = resolveInputRefStoreOwner(args);
  if (storeOwner === undefined) {
    return {
      ok: false,
      code: 'bad_request',
      message: 'ref must identify a supported input reference.',
    };
  }
  return recoverInputRefFile({
    workspaceRoot: storeOwner.workspaceRoot,
    config: storeOwner.config,
    ref: args.ref,
    action: args.action,
    ...(args.claimId === undefined ? {} : { claimId: args.claimId }),
  });
}

function resolveInputRefStoreOwner(args: {
  homeStateRoot: string;
  computerFileScope?: ComputerFileScope;
  ref: string;
}): { config: InputRefFileStoreConfig; workspaceRoot: string } | undefined {
  const homeConfig = HOME_INPUT_REF_STORES.find((config) =>
    args.ref.startsWith(config.refPrefix),
  );
  if (homeConfig !== undefined) {
    return { config: homeConfig, workspaceRoot: args.homeStateRoot };
  }
  if (
    args.computerFileScope !== undefined &&
    args.ref.startsWith(FILE_BINARY_INPUT_REF_STORE.refPrefix)
  ) {
    return {
      config: FILE_BINARY_INPUT_REF_STORE,
      workspaceRoot: args.computerFileScope.root,
    };
  }
  return undefined;
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
