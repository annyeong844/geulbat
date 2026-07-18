import { readFile } from 'node:fs/promises';
import type { Readable } from 'node:stream';
import type { ErrorCode } from '../error-codes.js';
import {
  claimInputRefFilePath,
  deleteInputRefFilePath,
  readInputRefFilePath,
  writeInputRefFileFromStream,
  type InputRefFilePathResult,
  type InputRefFileStoreConfig,
} from '../utils/input-ref-file-store.js';

export const RUN_PROMPT_INPUT_REF_STORE: InputRefFileStoreConfig =
  Object.freeze({
    kind: 'run_prompt',
    refPrefix: 'run-prompt-input:',
    directoryName: 'run-prompt-inputs',
    fileExtension: '.txt',
    invalidPrefixMessage: 'promptRef must be a run-prompt-input reference.',
    invalidIdMessage: 'promptRef is not a valid run-prompt-input reference.',
    notFileMessage: 'promptRef does not point to a run prompt input.',
    notFoundMessage: 'promptRef was not found.',
    claimedMessage: 'promptRef is already claimed by another operation.',
  });

interface RunPromptInputRefWriteResult {
  promptRef: string;
  byteLength: number;
}

type RunPromptInputRefReadResult =
  | { ok: true; path: string; prompt: string }
  | {
      ok: false;
      code: Extract<ErrorCode, 'bad_request' | 'conflict' | 'not_found'>;
      message: string;
    };

type RunPromptInputRefPathResult = InputRefFilePathResult;

export async function writeRunPromptInputRefFromStream(args: {
  workspaceRoot: string;
  input: Readable;
}): Promise<RunPromptInputRefWriteResult> {
  const uploaded = await writeInputRefFileFromStream({
    workspaceRoot: args.workspaceRoot,
    input: args.input,
    config: RUN_PROMPT_INPUT_REF_STORE,
  });
  return {
    promptRef: uploaded.ref,
    byteLength: uploaded.byteLength,
  };
}

export async function readRunPromptInputRef(args: {
  workspaceRoot: string;
  promptRef: string;
}): Promise<RunPromptInputRefReadResult> {
  const resolvedRef = await claimInputRefFilePath({
    workspaceRoot: args.workspaceRoot,
    ref: args.promptRef,
    config: RUN_PROMPT_INPUT_REF_STORE,
  });
  if (!resolvedRef.ok) {
    return resolvedRef;
  }

  try {
    return {
      ok: true,
      path: resolvedRef.path,
      prompt: await readFile(resolvedRef.path, 'utf8'),
    };
  } catch (error: unknown) {
    await deleteInputRefFilePath(resolvedRef.path);
    throw error;
  }
}

export async function readRunPromptInputRefPath(args: {
  workspaceRoot: string;
  promptRef: string;
}): Promise<RunPromptInputRefPathResult> {
  return readInputRefFilePath({
    workspaceRoot: args.workspaceRoot,
    ref: args.promptRef,
    config: RUN_PROMPT_INPUT_REF_STORE,
  });
}

export async function deleteRunPromptInputRefPath(path: string): Promise<void> {
  await deleteInputRefFilePath(path);
}
