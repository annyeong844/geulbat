// Canonical path helpers are the low-level owner for workspace path IO.
import { open, type FileHandle } from 'node:fs/promises';
import type {
  DerivedArtifactTarget,
  ExplicitExportTarget,
  SourceMutationTarget,
  SourceReadTarget,
  RuntimeStateTarget,
} from './file-platform-target-types.js';
import { writeTextFileAtomically } from '../utils/atomic-file.js';

export async function openReadHandle(
  target: Pick<
    SourceReadTarget | DerivedArtifactTarget,
    'canonicalAbsolutePath'
  >,
): Promise<FileHandle> {
  return open(target.canonicalAbsolutePath, 'r');
}

export async function writeAtomically(
  target: Pick<
    | SourceMutationTarget
    | DerivedArtifactTarget
    | RuntimeStateTarget
    | ExplicitExportTarget,
    'canonicalAbsolutePath'
  >,
  content: string,
  options?: Parameters<typeof writeTextFileAtomically>[2],
): Promise<void> {
  await writeTextFileAtomically(target.canonicalAbsolutePath, content, options);
}
