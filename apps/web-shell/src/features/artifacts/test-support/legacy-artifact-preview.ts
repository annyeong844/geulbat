import {
  parseArtifactEnvelope,
  settleArtifactParseResult,
} from '../artifact-envelope.js';
import { createArtifactViewModelFromParsed } from '../artifact-view-model.js';
import type { ArtifactSourceInputRef } from '../artifact-types.js';

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
