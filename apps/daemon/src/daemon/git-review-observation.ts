import type { HostCommandRuntime } from '../command-host/contract.js';
import {
  captureGitObjectIndexSnapshot,
  sameGitObjectIndexSnapshot,
  type GitObjectIndexSnapshot,
  type GitObjectIndexSnapshotResult,
} from './git-inspection-command.js';
import {
  buildGitLogicalEntries,
  buildGitStagedLayerEntries,
  buildGitUnstagedLayerEntries,
  type GitLogicalEntry,
  type GitStagedLayerEntry,
  type GitUnstagedLayerEntry,
} from './git-logical-diff.js';
import {
  captureGitWorktreeComparisonEntries,
  type GitWorktreeComparisonEntry,
  type GitWorktreeContentSnapshot,
} from './git-worktree-capture.js';

type GitInspectionReadFailure = Extract<
  GitObjectIndexSnapshotResult,
  { ok: false }
>;

export interface GitReviewObservationSnapshot {
  objectIndexSnapshot: GitObjectIndexSnapshot;
  worktreeEntries: readonly GitWorktreeComparisonEntry[];
  worktreeContents: readonly GitWorktreeContentSnapshot[];
  stagedLayers: readonly GitStagedLayerEntry[];
  unstagedLayers: readonly GitUnstagedLayerEntry[];
  logicalEntries: readonly GitLogicalEntry[];
}

export type GitReviewObservationCaptureResult =
  | {
      ok: true;
      observation: GitReviewObservationSnapshot;
    }
  | GitInspectionReadFailure;

export async function captureGitReviewObservation(args: {
  hostCommands: HostCommandRuntime;
  stateRoot: string;
  workingDirectory: string;
  pageLimitBytes: number;
  maxOutputBytesPerStream: number;
  maxFileBytes: number;
  signal?: AbortSignal;
}): Promise<GitReviewObservationCaptureResult> {
  const captureArgs = {
    hostCommands: args.hostCommands,
    stateRoot: args.stateRoot,
    workingDirectory: args.workingDirectory,
    pageLimitBytes: args.pageLimitBytes,
    maxOutputBytesPerStream: args.maxOutputBytesPerStream,
    ...(args.signal === undefined ? {} : { signal: args.signal }),
  };
  const objectIndexBefore = await captureGitObjectIndexSnapshot(captureArgs);
  if (!objectIndexBefore.ok) {
    return objectIndexBefore;
  }
  const worktree = await captureGitWorktreeComparisonEntries({
    hostCommands: args.hostCommands,
    stateRoot: args.stateRoot,
    snapshot: objectIndexBefore.snapshot,
    pageLimitBytes: args.pageLimitBytes,
    maxOutputBytesPerStream: args.maxOutputBytesPerStream,
    maxFileBytes: args.maxFileBytes,
    ...(args.signal === undefined ? {} : { signal: args.signal }),
  });
  if (!worktree.ok) {
    return worktree;
  }
  const objectIndexAfter = await captureGitObjectIndexSnapshot(captureArgs);
  if (!objectIndexAfter.ok) {
    return objectIndexAfter;
  }
  if (
    !sameGitObjectIndexSnapshot(
      objectIndexBefore.snapshot,
      objectIndexAfter.snapshot,
    )
  ) {
    return {
      ok: false,
      reason: 'observation_changed',
      message:
        'Git repository identity, HEAD, or index changed while the review observation was captured.',
    };
  }

  const stagedLayers = buildGitStagedLayerEntries(objectIndexBefore.snapshot);
  const unstagedLayers = buildGitUnstagedLayerEntries(
    objectIndexBefore.snapshot,
    worktree.entries,
  );
  return {
    ok: true,
    observation: {
      objectIndexSnapshot: objectIndexBefore.snapshot,
      worktreeEntries: worktree.entries,
      worktreeContents: worktree.contents,
      stagedLayers,
      unstagedLayers,
      logicalEntries: buildGitLogicalEntries(stagedLayers, unstagedLayers),
    },
  };
}
