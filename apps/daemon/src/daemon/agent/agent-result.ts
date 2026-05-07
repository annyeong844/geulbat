import type { ProviderArtifactCandidate } from '../llm/provider/wire/types.js';

export type AgentArtifactCandidate = ProviderArtifactCandidate;

export interface AgentResult {
  ok: boolean;
  finalProse: string;
  artifactCandidate?: AgentArtifactCandidate;
}

interface AgentResultSurface {
  ok?: boolean;
  finalProse?: string;
  artifactCandidate?: AgentArtifactCandidate;
}

function trimToEmpty(value: string | undefined): string {
  return value?.trim() ?? '';
}

export function hasVisibleAgentOutput(result: AgentResultSurface): boolean {
  if (result.ok) {
    return true;
  }
  return (
    trimToEmpty(result.finalProse) !== '' ||
    result.artifactCandidate !== undefined
  );
}

export function describeAgentResultForTextSurface(
  result: Pick<AgentResult, 'finalProse' | 'artifactCandidate'>,
): string {
  if (trimToEmpty(result.finalProse) !== '') {
    return result.finalProse;
  }
  if (result.artifactCandidate !== undefined) {
    const digest = result.artifactCandidate.digest?.trim();
    return digest
      ? `[artifact:${result.artifactCandidate.renderer}] ${digest}`
      : `[artifact:${result.artifactCandidate.renderer}]`;
  }
  return '';
}

export function composeAgentResult(args: {
  ok: boolean;
  finalProse?: string;
  artifactCandidate?: AgentArtifactCandidate;
}): AgentResult {
  if (args.artifactCandidate !== undefined) {
    return {
      ok: args.ok,
      finalProse: '',
      artifactCandidate: args.artifactCandidate,
    };
  }
  return {
    ok: args.ok,
    finalProse: args.finalProse ?? '',
  };
}
