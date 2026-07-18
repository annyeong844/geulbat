import { randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import {
  link,
  lstat,
  mkdir,
  readdir,
  rename,
  rm,
  stat,
} from 'node:fs/promises';
import { join } from 'node:path';
import type { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ErrorCode } from '../error-codes.js';
import { getErrorCode } from './error.js';

const INPUT_REF_FILE_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const activeInputRefClaimPaths = new Set<string>();
const pendingInputRefClaimQueues = new Map<string, Promise<void>>();

type InputRefFileKind =
  | 'run_prompt'
  | 'file_binary'
  | 'artifact_runtime_state'
  | 'react_bundle_inline_compile';

type InputRefFileRecoveryAction = 'retry' | 'release';

export interface InputRefFileStoreConfig {
  kind: InputRefFileKind;
  refPrefix: string;
  directoryName: string;
  fileExtension: string;
  resolveStorageRoot?: (workspaceRoot: string) => string;
  invalidPrefixMessage: string;
  invalidIdMessage: string;
  notFileMessage: string;
  notFoundMessage: string;
  claimedMessage: string;
}

interface InputRefFileWriteResult {
  ref: string;
  byteLength: number;
}

export type InputRefFilePathResult =
  | { ok: true; path: string }
  | {
      ok: false;
      code: Extract<ErrorCode, 'bad_request' | 'conflict' | 'not_found'>;
      message: string;
    };

type InputRefFileClaimResult = InputRefFilePathResult;

interface InputRefInventoryBase {
  ref: string;
  kind: InputRefFileKind;
  byteLength: number;
  createdAt: string;
  path: string;
}

type InputRefFileInventoryEntry =
  | (InputRefInventoryBase & { state: 'pending'; claimId?: never })
  | (InputRefInventoryBase & {
      state: 'claimed' | 'interrupted';
      claimId: string;
    });

export type InputRefFileRecoveryResult =
  | { ok: true; disposition: 'pending' | 'released' }
  | {
      ok: false;
      code: Extract<ErrorCode, 'bad_request' | 'conflict' | 'not_found'>;
      message: string;
    };

export async function writeInputRefFileFromStream(args: {
  workspaceRoot: string;
  input: Readable;
  config: InputRefFileStoreConfig;
}): Promise<InputRefFileWriteResult> {
  const id = randomUUID();
  const ref = buildInputRefFileRef(args.config, id);
  const directory = buildInputRefFileDirectory(args.workspaceRoot, args.config);
  const finalPath = buildInputRefFilePath(args.workspaceRoot, args.config, id);
  const tempPath = `${finalPath}.${process.pid}.${randomUUID()}.tmp`;

  await mkdir(directory, { recursive: true, mode: 0o700 });
  try {
    await pipeline(
      args.input,
      createWriteStream(tempPath, { flags: 'wx', mode: 0o600 }),
    );
    await rename(tempPath, finalPath);
  } catch (error: unknown) {
    await rm(tempPath, { force: true });
    await rm(finalPath, { force: true });
    throw error;
  }

  const uploaded = await stat(finalPath);
  return {
    ref,
    byteLength: uploaded.size,
  };
}

export async function readInputRefFilePath(args: {
  workspaceRoot: string;
  ref: string;
  config: InputRefFileStoreConfig;
}): Promise<InputRefFilePathResult> {
  const parsed = parseInputRefFileRef(args.config, args.ref);
  if (!parsed.ok) {
    return parsed;
  }

  const path = buildInputRefFilePath(
    args.workspaceRoot,
    args.config,
    parsed.id,
  );
  try {
    const entry = await stat(path);
    if (!entry.isFile()) {
      return {
        ok: false,
        code: 'bad_request',
        message: args.config.notFileMessage,
      };
    }
  } catch (error: unknown) {
    if (getErrorCode(error) === 'ENOENT') {
      if (
        await hasClaimedInputRefFile(args.workspaceRoot, args.config, parsed.id)
      ) {
        return {
          ok: false,
          code: 'conflict',
          message: args.config.claimedMessage,
        };
      }
      return {
        ok: false,
        code: 'not_found',
        message: args.config.notFoundMessage,
      };
    }
    throw error;
  }

  return { ok: true, path };
}

export async function claimInputRefFilePath(args: {
  workspaceRoot: string;
  ref: string;
  config: InputRefFileStoreConfig;
}): Promise<InputRefFileClaimResult> {
  const parsed = parseInputRefFileRef(args.config, args.ref);
  if (!parsed.ok) {
    return parsed;
  }

  const pendingPath = buildInputRefFilePath(
    args.workspaceRoot,
    args.config,
    parsed.id,
  );
  return runSerializedInputRefClaim(pendingPath, async () => {
    const claimedPath = buildClaimedInputRefFilePath(
      args.workspaceRoot,
      args.config,
      parsed.id,
    );
    try {
      await rename(pendingPath, claimedPath);
      activeInputRefClaimPaths.add(claimedPath);
    } catch (error: unknown) {
      if (getErrorCode(error) !== 'ENOENT') {
        throw error;
      }
      if (
        await hasClaimedInputRefFile(args.workspaceRoot, args.config, parsed.id)
      ) {
        return {
          ok: false,
          code: 'conflict',
          message: args.config.claimedMessage,
        };
      }
      return {
        ok: false,
        code: 'not_found',
        message: args.config.notFoundMessage,
      };
    }

    try {
      const entry = await stat(claimedPath);
      if (entry.isFile()) {
        return { ok: true, path: claimedPath };
      }
      await rename(claimedPath, pendingPath);
      activeInputRefClaimPaths.delete(claimedPath);
      return {
        ok: false,
        code: 'bad_request',
        message: args.config.notFileMessage,
      };
    } catch (error: unknown) {
      activeInputRefClaimPaths.delete(claimedPath);
      let rollbackError: unknown;
      try {
        await rename(claimedPath, pendingPath);
      } catch (caughtRollbackError: unknown) {
        rollbackError = caughtRollbackError;
      }
      if (rollbackError !== undefined) {
        throw new AggregateError(
          [error, rollbackError],
          'input ref claim inspection and rollback both failed',
        );
      }
      throw error;
    }
  });
}

async function runSerializedInputRefClaim<T>(
  pendingPath: string,
  operation: () => Promise<T>,
): Promise<T> {
  const previous = pendingInputRefClaimQueues.get(pendingPath);
  let releaseCurrent!: () => void;
  const currentGate = new Promise<void>((resolve) => {
    releaseCurrent = resolve;
  });
  const current = (previous ?? Promise.resolve())
    .catch(() => undefined)
    .then(() => currentGate);
  pendingInputRefClaimQueues.set(pendingPath, current);
  await previous?.catch(() => undefined);

  try {
    return await operation();
  } finally {
    releaseCurrent();
    if (pendingInputRefClaimQueues.get(pendingPath) === current) {
      pendingInputRefClaimQueues.delete(pendingPath);
    }
  }
}

export async function listInputRefFiles(args: {
  workspaceRoot: string;
  config: InputRefFileStoreConfig;
}): Promise<InputRefFileInventoryEntry[]> {
  const directory = buildInputRefFileDirectory(args.workspaceRoot, args.config);
  let names: string[];
  try {
    names = await readdir(directory);
  } catch (error: unknown) {
    if (getErrorCode(error) === 'ENOENT') {
      return [];
    }
    throw error;
  }

  const entries: InputRefFileInventoryEntry[] = [];
  for (const name of names) {
    const parsed = parseInputRefFileName(args.config, name);
    if (parsed === null) {
      continue;
    }
    const path = join(directory, name);
    let file;
    try {
      file = await lstat(path);
    } catch (error: unknown) {
      if (getErrorCode(error) === 'ENOENT') {
        continue;
      }
      throw error;
    }
    if (!file.isFile()) {
      continue;
    }

    if (parsed.claimId === undefined) {
      entries.push({
        ref: buildInputRefFileRef(args.config, parsed.id),
        kind: args.config.kind,
        state: 'pending',
        byteLength: file.size,
        createdAt: file.mtime.toISOString(),
        path,
      });
      continue;
    }
    entries.push({
      ref: buildInputRefFileRef(args.config, parsed.id),
      kind: args.config.kind,
      state: activeInputRefClaimPaths.has(path) ? 'claimed' : 'interrupted',
      byteLength: file.size,
      createdAt: file.mtime.toISOString(),
      claimId: parsed.claimId,
      path,
    });
  }

  return entries.sort(compareInputRefFileInventoryEntries);
}

export async function recoverInputRefFile(args: {
  workspaceRoot: string;
  ref: string;
  action: InputRefFileRecoveryAction;
  claimId?: string;
  config: InputRefFileStoreConfig;
}): Promise<InputRefFileRecoveryResult> {
  const parsedRef = parseInputRefFileRef(args.config, args.ref);
  if (!parsedRef.ok) {
    return parsedRef;
  }
  if (
    args.claimId !== undefined &&
    !INPUT_REF_FILE_ID_PATTERN.test(args.claimId)
  ) {
    return {
      ok: false,
      code: 'bad_request',
      message: 'claimId must identify a persisted input ref claim.',
    };
  }

  const entries = (await listInputRefFiles(args)).filter(
    (entry) => entry.ref === args.ref,
  );
  const pending = entries.find((entry) => entry.state === 'pending');
  const claimed = entries.filter((entry) => entry.state === 'claimed');
  const interrupted = entries.filter((entry) => entry.state === 'interrupted');

  if (claimed.length > 0) {
    return {
      ok: false,
      code: 'conflict',
      message: args.config.claimedMessage,
    };
  }

  if (args.action === 'release' && args.claimId === undefined) {
    if (pending !== undefined && interrupted.length === 0) {
      await deleteInputRefFilePath(pending.path);
      return { ok: true, disposition: 'released' };
    }
    if (pending !== undefined || interrupted.length > 1) {
      return {
        ok: false,
        code: 'conflict',
        message: args.config.claimedMessage,
      };
    }
  }

  if (
    args.action === 'retry' &&
    pending !== undefined &&
    interrupted.length === 0
  ) {
    return { ok: true, disposition: 'pending' };
  }
  if (pending !== undefined) {
    return {
      ok: false,
      code: 'conflict',
      message: args.config.claimedMessage,
    };
  }

  const recoverable =
    args.claimId === undefined
      ? interrupted.length === 1
        ? interrupted[0]
        : undefined
      : interrupted.find((entry) => entry.claimId === args.claimId);
  if (recoverable === undefined) {
    return interrupted.length > 1 && args.claimId === undefined
      ? {
          ok: false,
          code: 'conflict',
          message: args.config.claimedMessage,
        }
      : {
          ok: false,
          code: 'not_found',
          message: args.config.notFoundMessage,
        };
  }

  if (args.action === 'release') {
    await deleteInputRefFilePath(recoverable.path);
    return { ok: true, disposition: 'released' };
  }

  const pendingPath = buildInputRefFilePath(
    args.workspaceRoot,
    args.config,
    parsedRef.id,
  );
  try {
    await link(recoverable.path, pendingPath);
  } catch (error: unknown) {
    if (getErrorCode(error) === 'EEXIST') {
      return {
        ok: false,
        code: 'conflict',
        message: args.config.claimedMessage,
      };
    }
    if (getErrorCode(error) === 'ENOENT') {
      return {
        ok: false,
        code: 'not_found',
        message: args.config.notFoundMessage,
      };
    }
    throw error;
  }
  try {
    await deleteInputRefFilePath(recoverable.path);
  } catch (error: unknown) {
    let rollbackError: unknown;
    try {
      await rm(pendingPath, { force: true });
    } catch (caughtRollbackError: unknown) {
      rollbackError = caughtRollbackError;
    }
    if (rollbackError !== undefined) {
      throw new AggregateError(
        [error, rollbackError],
        'input ref retry cleanup and rollback both failed',
      );
    }
    throw error;
  }
  return { ok: true, disposition: 'pending' };
}

export async function deleteInputRefFilePath(path: string): Promise<void> {
  try {
    await rm(path, { force: true });
  } finally {
    activeInputRefClaimPaths.delete(path);
  }
}

function parseInputRefFileRef(
  config: InputRefFileStoreConfig,
  ref: string,
):
  | { ok: true; id: string }
  | {
      ok: false;
      code: Extract<ErrorCode, 'bad_request'>;
      message: string;
    } {
  if (!ref.startsWith(config.refPrefix)) {
    return {
      ok: false,
      code: 'bad_request',
      message: config.invalidPrefixMessage,
    };
  }
  const id = ref.slice(config.refPrefix.length);
  if (!INPUT_REF_FILE_ID_PATTERN.test(id)) {
    return {
      ok: false,
      code: 'bad_request',
      message: config.invalidIdMessage,
    };
  }
  return { ok: true, id };
}

function buildInputRefFileRef(
  config: InputRefFileStoreConfig,
  id: string,
): string {
  return `${config.refPrefix}${id}`;
}

function buildInputRefFileDirectory(
  workspaceRoot: string,
  config: InputRefFileStoreConfig,
): string {
  const storageRoot =
    config.resolveStorageRoot?.(workspaceRoot) ??
    join(workspaceRoot, '.geulbat');
  return join(storageRoot, config.directoryName);
}

function buildInputRefFilePath(
  workspaceRoot: string,
  config: InputRefFileStoreConfig,
  id: string,
): string {
  return join(
    buildInputRefFileDirectory(workspaceRoot, config),
    `${id}${config.fileExtension}`,
  );
}

function buildClaimedInputRefFilePath(
  workspaceRoot: string,
  config: InputRefFileStoreConfig,
  id: string,
): string {
  return join(
    buildInputRefFileDirectory(workspaceRoot, config),
    `${id}.${randomUUID()}.claimed${config.fileExtension}`,
  );
}

function parseInputRefFileName(
  config: InputRefFileStoreConfig,
  name: string,
): { id: string; claimId?: string } | null {
  if (!name.endsWith(config.fileExtension)) {
    return null;
  }
  const stem = name.slice(0, -config.fileExtension.length);
  if (INPUT_REF_FILE_ID_PATTERN.test(stem)) {
    return { id: stem };
  }
  if (!stem.endsWith('.claimed')) {
    return null;
  }
  const claimedStem = stem.slice(0, -'.claimed'.length);
  const separator = claimedStem.indexOf('.');
  if (separator < 0) {
    return null;
  }
  const id = claimedStem.slice(0, separator);
  const claimId = claimedStem.slice(separator + 1);
  if (
    !INPUT_REF_FILE_ID_PATTERN.test(id) ||
    !INPUT_REF_FILE_ID_PATTERN.test(claimId)
  ) {
    return null;
  }
  return { id, claimId };
}

function compareInputRefFileInventoryEntries(
  left: InputRefFileInventoryEntry,
  right: InputRefFileInventoryEntry,
): number {
  return (
    left.createdAt.localeCompare(right.createdAt) ||
    left.ref.localeCompare(right.ref) ||
    (left.claimId ?? '').localeCompare(right.claimId ?? '')
  );
}

async function hasClaimedInputRefFile(
  workspaceRoot: string,
  config: InputRefFileStoreConfig,
  id: string,
): Promise<boolean> {
  const directory = buildInputRefFileDirectory(workspaceRoot, config);
  let names: string[];
  try {
    names = await readdir(directory);
  } catch (error: unknown) {
    if (getErrorCode(error) === 'ENOENT') {
      return false;
    }
    throw error;
  }
  const prefix = `${id}.`;
  const suffix = `.claimed${config.fileExtension}`;
  return names.some((name) => name.startsWith(prefix) && name.endsWith(suffix));
}
