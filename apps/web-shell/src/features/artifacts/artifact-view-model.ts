import type { ThreadArtifactVersion } from '@geulbat/protocol/artifacts';
import {
  isSameApprovedPlanRef,
  type PlanningWorkflowSnapshot,
  type PlanRenderingStamp,
} from '@geulbat/protocol/planning-workflow';
import {
  buildArtifactApplyRunDraftFromAuthority,
  canBuildArtifactExportRunFromAuthority,
} from './artifact-run-drafts.js';
import { resolveArtifactDurabilitySourceAuthorityFromResolved } from './artifact-durability.js';
import {
  sanitizeArtifactSourceInputRef,
  type ArtifactSourceInputRef,
  type ArtifactViewModel,
  type PlanRenderingProjection,
  type ResolvedArtifactSourceRef,
} from './artifact-types.js';

export function createCommittedArtifactViewModel(args: {
  artifact: ThreadArtifactVersion;
  sourceRef?: ArtifactSourceInputRef | ResolvedArtifactSourceRef;
  planningWorkflowSnapshot?: PlanningWorkflowSnapshot | null;
}): ArtifactViewModel {
  return createArtifactViewModel(
    args.artifact,
    args.sourceRef,
    args.planningWorkflowSnapshot,
  );
}

function createArtifactViewModel(
  artifact: ThreadArtifactVersion,
  sourceRefInput?: ArtifactSourceInputRef | ResolvedArtifactSourceRef,
  planningWorkflowSnapshot?: PlanningWorkflowSnapshot | null,
): ArtifactViewModel {
  const sourceRef = sanitizeArtifactSourceInputRef(sourceRefInput);
  const sourceAuthority = resolveArtifactDurabilitySourceAuthorityFromResolved({
    sourceRef,
  });
  const canBuildApply =
    buildArtifactApplyRunDraftFromAuthority({
      artifact,
      sourceAuthority,
    }) !== null;
  const canStartExport = canBuildArtifactExportRunFromAuthority({
    artifact,
    sourceAuthority,
  });

  return {
    artifact,
    sourceRef,
    sourceAuthority,
    planRendering: resolvePlanRenderingStampProjection(
      artifact.planStamp,
      planningWorkflowSnapshot,
    ),
    actions: {
      apply: canBuildApply
        ? {
            visible: true,
            enabled: true,
            reason: null,
          }
        : {
            visible: false,
            enabled: false,
            reason: 'source reference missing or unsupported artifact',
          },
      export: canStartExport
        ? {
            visible: true,
            enabled: true,
            reason: null,
          }
        : {
            visible: false,
            enabled: false,
            reason: 'artifact session missing or unsupported artifact',
          },
    },
  };
}

export function resolvePlanRenderingStampProjection(
  stamp: PlanRenderingStamp | undefined,
  planningWorkflowSnapshot: PlanningWorkflowSnapshot | null | undefined,
): PlanRenderingProjection | null {
  if (stamp === undefined) {
    return null;
  }
  const status =
    planningWorkflowSnapshot === null || planningWorkflowSnapshot === undefined
      ? 'historical'
      : planningWorkflowSnapshot.state !== 'collecting' &&
          isSameApprovedPlanRef(stamp, planningWorkflowSnapshot)
        ? 'current'
        : 'superseded';
  const statusLabel =
    status === 'current'
      ? '현재 계획'
      : status === 'superseded'
        ? '이전 계획'
        : '계획 원본';
  return {
    status,
    label: `${statusLabel} · r${stamp.revision}`,
    title: `${statusLabel} · ${stamp.planId} · r${stamp.revision} · ${stamp.digest}`,
  };
}
