import {
  parseArtifactEnvelope,
  settleArtifactParseResult,
} from '../../artifacts/artifact-envelope.js';
import { createArtifactViewModelFromParsed } from '../../artifacts/artifact-view-model.js';
import type { ArtifactSourceInputRef } from '../../artifacts/artifact-types.js';

export function createLegacyArtifactPreviewViewModel(args: {
  rawText: string;
  sourceRef?: ArtifactSourceInputRef;
  isRunning?: boolean;
}) {
  const parsed = settleArtifactParseResult(
    parseArtifactEnvelope(args.rawText),
    !!args.isRunning,
  );
  return createArtifactViewModelFromParsed(parsed, args.sourceRef);
}
