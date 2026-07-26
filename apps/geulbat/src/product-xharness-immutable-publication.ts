import { randomUUID } from 'node:crypto';
import { link, mkdir, open, readFile, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { stableStringify } from '@geulbat/content-identity/stable-json';
import { isErrorCode } from './product-xharness-cli-support.js';

export async function publishProductXHarnessImmutableJson(input: {
  readonly targetPath: string;
  readonly pendingDirectory: string;
  readonly value: unknown;
  readonly conflictMessage: string;
}): Promise<{ readonly created: boolean }> {
  return publishProductXHarnessImmutableBytes({
    targetPath: input.targetPath,
    pendingDirectory: input.pendingDirectory,
    bytes: Buffer.from(`${stableStringify(input.value)}\n`, 'utf8'),
    conflictMessage: input.conflictMessage,
  });
}

export async function publishProductXHarnessImmutableBytes(input: {
  readonly targetPath: string;
  readonly pendingDirectory: string;
  readonly bytes: Buffer;
  readonly conflictMessage: string;
}): Promise<{ readonly created: boolean }> {
  await mkdir(dirname(input.targetPath), { recursive: true });
  await mkdir(input.pendingDirectory, { recursive: true });
  const temporaryPath = join(input.pendingDirectory, `${randomUUID()}.pending`);
  try {
    const handle = await open(temporaryPath, 'wx', 0o600);
    try {
      await handle.writeFile(input.bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await link(temporaryPath, input.targetPath);
      return Object.freeze({ created: true });
    } catch (error: unknown) {
      if (!isErrorCode(error, 'EEXIST')) {
        throw error;
      }
      const existingBytes = await readFile(input.targetPath);
      if (!existingBytes.equals(input.bytes)) {
        throw new Error(input.conflictMessage);
      }
      return Object.freeze({ created: false });
    }
  } finally {
    await unlink(temporaryPath).catch((error: unknown) => {
      if (!isErrorCode(error, 'ENOENT')) {
        throw error;
      }
    });
  }
}
