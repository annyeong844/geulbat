import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Readable } from 'node:stream';
import {
  claimInputRefFilePath,
  deleteInputRefFilePath,
  readInputRefFilePath,
  writeInputRefFileFromStream,
  type InputRefFilePathResult,
  type InputRefFileStoreConfig,
} from '../utils/input-ref-file-store.js';

export const FILE_BINARY_INPUT_REF_STORE: InputRefFileStoreConfig =
  Object.freeze({
    kind: 'file_binary',
    refPrefix: 'file-binary-input:',
    directoryName: 'file-binary-inputs',
    fileExtension: '.bin',
    resolveStorageRoot: resolveFileBinaryInputRefScopeRoot,
    invalidPrefixMessage: 'contentRef must be a file-binary-input reference.',
    invalidIdMessage: 'contentRef is not a valid file-binary-input reference.',
    notFileMessage: 'contentRef does not point to a binary input file.',
    notFoundMessage: 'contentRef was not found.',
    claimedMessage: 'contentRef is already claimed by another operation.',
  });

const FILE_BINARY_INPUT_REF_ROOT_ENV = 'GEULBAT_FILE_BINARY_INPUT_REF_ROOT';

function resolveFileBinaryInputRefStorageRoot(): string {
  const configuredRoot = process.env[FILE_BINARY_INPUT_REF_ROOT_ENV]?.trim();
  return configuredRoot
    ? resolve(configuredRoot)
    : join(homedir(), '.geulbat', 'input-refs', 'file-binary');
}

function resolveFileBinaryInputRefScopeRoot(workspaceRoot: string): string {
  const scopeHash = createHash('sha256')
    .update(resolve(workspaceRoot), 'utf8')
    .digest('hex');
  return join(resolveFileBinaryInputRefStorageRoot(), `scope-${scopeHash}`);
}

interface FileBinaryInputRefWriteResult {
  contentRef: string;
  byteLength: number;
}

type FileBinaryInputRefPathResult = InputRefFilePathResult;

export async function writeFileBinaryInputRefFromStream(args: {
  workspaceRoot: string;
  input: Readable;
}): Promise<FileBinaryInputRefWriteResult> {
  const uploaded = await writeInputRefFileFromStream({
    workspaceRoot: args.workspaceRoot,
    input: args.input,
    config: FILE_BINARY_INPUT_REF_STORE,
  });
  return {
    contentRef: uploaded.ref,
    byteLength: uploaded.byteLength,
  };
}

export async function readFileBinaryInputRefPath(args: {
  workspaceRoot: string;
  contentRef: string;
}): Promise<FileBinaryInputRefPathResult> {
  return readInputRefFilePath({
    workspaceRoot: args.workspaceRoot,
    ref: args.contentRef,
    config: FILE_BINARY_INPUT_REF_STORE,
  });
}

export async function claimFileBinaryInputRefPath(args: {
  workspaceRoot: string;
  contentRef: string;
}): Promise<FileBinaryInputRefPathResult> {
  return claimInputRefFilePath({
    workspaceRoot: args.workspaceRoot,
    ref: args.contentRef,
    config: FILE_BINARY_INPUT_REF_STORE,
  });
}

export async function deleteFileBinaryInputRefPath(
  path: string,
): Promise<void> {
  await deleteInputRefFilePath(path);
}
