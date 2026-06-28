import { readFile } from 'node:fs/promises';
import type { Readable } from 'node:stream';
import {
  claimInputRefFilePath,
  deleteInputRefFilePath,
  readInputRefFilePath,
  writeInputRefFileFromStream,
  type InputRefFilePathResult,
  type InputRefFileStoreConfig,
} from '../utils/input-ref-file-store.js';

export const REACT_BUNDLE_INLINE_COMPILE_INPUT_REF_STORE: InputRefFileStoreConfig =
  Object.freeze({
    kind: 'react_bundle_inline_compile',
    refPrefix: 'react-bundle-inline-compile-input:',
    directoryName: 'react-bundle-inline-compile-inputs',
    fileExtension: '.json',
    invalidPrefixMessage:
      'inputRef must be a react-bundle-inline-compile-input reference.',
    invalidIdMessage:
      'inputRef is not a valid react-bundle-inline-compile-input reference.',
    notFileMessage:
      'inputRef does not point to a react bundle inline compile input.',
    notFoundMessage: 'inputRef was not found.',
    claimedMessage: 'inputRef is already claimed by another operation.',
  });

export interface ReactBundleInlineCompileInputRefWriteResult {
  inputRef: string;
  byteLength: number;
}

type ReactBundleInlineCompileInputRefErrorCode =
  | 'bad_request'
  | 'conflict'
  | 'not_found';

export type ReactBundleInlineCompileInputRefReadResult =
  | { ok: true; path: string; rawInput: string }
  | {
      ok: false;
      code: ReactBundleInlineCompileInputRefErrorCode;
      message: string;
    };

export type ReactBundleInlineCompileInputRefPathResult = InputRefFilePathResult;

export async function writeReactBundleInlineCompileInputRefFromStream(args: {
  workspaceRoot: string;
  input: Readable;
}): Promise<ReactBundleInlineCompileInputRefWriteResult> {
  const uploaded = await writeInputRefFileFromStream({
    workspaceRoot: args.workspaceRoot,
    input: args.input,
    config: REACT_BUNDLE_INLINE_COMPILE_INPUT_REF_STORE,
  });
  return {
    inputRef: uploaded.ref,
    byteLength: uploaded.byteLength,
  };
}

export async function readReactBundleInlineCompileInputRef(args: {
  workspaceRoot: string;
  inputRef: string;
}): Promise<ReactBundleInlineCompileInputRefReadResult> {
  const resolvedRef = await claimInputRefFilePath({
    workspaceRoot: args.workspaceRoot,
    ref: args.inputRef,
    config: REACT_BUNDLE_INLINE_COMPILE_INPUT_REF_STORE,
  });
  if (!resolvedRef.ok) {
    return resolvedRef;
  }

  try {
    return {
      ok: true,
      path: resolvedRef.path,
      rawInput: await readFile(resolvedRef.path, 'utf8'),
    };
  } catch (error: unknown) {
    await deleteInputRefFilePath(resolvedRef.path);
    throw error;
  }
}

export async function readReactBundleInlineCompileInputRefPath(args: {
  workspaceRoot: string;
  inputRef: string;
}): Promise<ReactBundleInlineCompileInputRefPathResult> {
  return readInputRefFilePath({
    workspaceRoot: args.workspaceRoot,
    ref: args.inputRef,
    config: REACT_BUNDLE_INLINE_COMPILE_INPUT_REF_STORE,
  });
}

export async function deleteReactBundleInlineCompileInputRefPath(
  path: string,
): Promise<void> {
  await deleteInputRefFilePath(path);
}
