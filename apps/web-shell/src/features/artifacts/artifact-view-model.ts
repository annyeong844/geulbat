import type { ThreadArtifactVersion } from '@geulbat/protocol/artifacts';
import {
  buildArtifactApplyRunDraftFromAuthority,
  canBuildArtifactExportRunFromAuthority,
} from './artifact-run-drafts.js';
import { resolveArtifactDurabilitySourceAuthorityFromResolved } from './artifact-durability.js';
import {
  sanitizeArtifactSourceInputRef,
  type ArtifactOnlyParseResult,
  type ArtifactOnlyViewModel,
  type ArtifactParseResult,
  type ArtifactSourceInputRef,
  type ArtifactViewModel,
  type ResolvedArtifactSourceRef,
} from './artifact-types.js';

export function createCommittedArtifactViewModel(args: {
  artifact: ThreadArtifactVersion;
  sourceRef?: ArtifactSourceInputRef | ResolvedArtifactSourceRef;
}): ArtifactOnlyViewModel {
  const parsed: ArtifactOnlyParseResult = {
    kind: 'artifact',
    state: 'completed',
    renderer: args.artifact.renderer,
    digest: args.artifact.digest,
    payload: args.artifact.payload,
    raw: args.artifact.payload,
  };
  return createArtifactViewModelFromArtifactParsed(parsed, args.sourceRef);
}

function createArtifactViewModelFromArtifactParsed(
  parsed: ArtifactOnlyParseResult,
  sourceRefInput?: ArtifactSourceInputRef | ResolvedArtifactSourceRef,
): ArtifactOnlyViewModel {
  return createArtifactViewModelFromParsed(parsed, sourceRefInput);
}

export function createArtifactViewModelFromParsed<
  T extends ArtifactParseResult,
>(
  parsed: T,
  sourceRefInput?: ArtifactSourceInputRef | ResolvedArtifactSourceRef,
): ArtifactViewModel & { parsed: T } {
  const sourceRef = sanitizeArtifactSourceInputRef(sourceRefInput);
  const sourceAuthority = resolveArtifactDurabilitySourceAuthorityFromResolved({
    sourceRef,
  });
  const canBuildApply =
    buildArtifactApplyRunDraftFromAuthority({
      parsed,
      sourceAuthority,
    }) !== null;
  const canStartExport = canBuildArtifactExportRunFromAuthority({
    parsed,
    sourceAuthority,
  });

  return {
    parsed,
    sourceRef,
    sourceAuthority,
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
