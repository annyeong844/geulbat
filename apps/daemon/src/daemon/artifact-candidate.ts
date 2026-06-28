import {
  parseCanonicalArtifactEnvelopeText,
  type ParsedCanonicalArtifactEnvelope,
} from '@geulbat/protocol/artifacts';

export type DaemonArtifactCandidate = ParsedCanonicalArtifactEnvelope;

export function parseDaemonArtifactCandidateText(
  text: string,
): DaemonArtifactCandidate | undefined {
  return parseCanonicalArtifactEnvelopeText(text) ?? undefined;
}
