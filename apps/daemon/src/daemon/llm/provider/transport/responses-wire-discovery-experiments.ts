export type OAuthWireDiscoveryExperimentId =
  | 'baseline_repeat'
  | 'text_subtree_observation';

type OAuthWireDiscoveryExperimentKind =
  | 'control'
  | 'observation_gate'
  | 'single_observed_subtree_mutation';

type OAuthWireDiscoveryLiveRunPolicy =
  | 'explicit_operator_approval_required'
  | 'blocked_preflight_only';

type OAuthWireDiscoveryExperimentMutation =
  | { kind: 'none' }
  | {
      kind: 'set_known_observed_subtree_field';
      parentPath: string[];
      fieldName: string;
      valueShape: 'boolean' | 'string' | 'object' | 'array';
      evidenceRef: string;
    };

interface OAuthWireDiscoveryExperimentBase {
  id: OAuthWireDiscoveryExperimentId;
  purpose: string;
  kind: OAuthWireDiscoveryExperimentKind;
  baselineObservedPath: 'text' | 'include' | 'input' | 'reasoning';
  requestDiffSummary: string;
  mutation: OAuthWireDiscoveryExperimentMutation;
  liveRunPolicy: OAuthWireDiscoveryLiveRunPolicy;
}

interface OAuthWireDiscoveryControlExperiment extends OAuthWireDiscoveryExperimentBase {
  id: 'baseline_repeat';
  kind: 'control';
  mutation: { kind: 'none' };
  liveRunPolicy: 'explicit_operator_approval_required';
}

interface OAuthWireDiscoveryObservationGateExperiment extends OAuthWireDiscoveryExperimentBase {
  id: 'text_subtree_observation';
  kind: 'observation_gate';
  mutation: { kind: 'none' };
  liveRunPolicy: 'blocked_preflight_only';
  evidenceRef: string;
  observedChildren: Array<{
    path: string[];
    valueShape: 'provider-string';
  }>;
  blockedReason: string;
}

type OAuthWireDiscoveryExperiment =
  | OAuthWireDiscoveryControlExperiment
  | OAuthWireDiscoveryObservationGateExperiment;

type OAuthWireDiscoveryExperimentResolveResult =
  | { ok: true; experiment: OAuthWireDiscoveryExperiment }
  | {
      ok: false;
      reasonCode:
        | 'experiment_required'
        | 'experiment_invalid'
        | 'experiment_unknown';
      message: string;
    };

const EXPERIMENT_ID_PATTERN = /^[a-z0-9_]+$/u;

const BASELINE_REPEAT_EXPERIMENT: OAuthWireDiscoveryControlExperiment = {
  id: 'baseline_repeat',
  purpose:
    'Repeat the observed OAuth websocket baseline without request-shape mutation.',
  kind: 'control',
  baselineObservedPath: 'text',
  requestDiffSummary:
    'no request mutation; repeat the observed OAuth websocket final-text baseline capture',
  mutation: { kind: 'none' },
  liveRunPolicy: 'explicit_operator_approval_required',
};

const TEXT_SUBTREE_OBSERVATION_EXPERIMENT: OAuthWireDiscoveryObservationGateExperiment =
  {
    id: 'text_subtree_observation',
    purpose:
      'Record the observed sanitized OAuth text subtree shape without making a live request mutation.',
    kind: 'observation_gate',
    baselineObservedPath: 'text',
    requestDiffSummary:
      'observed text subtree has child key text.verbosity with provider-string value shape; no request mutation; live capture blocked',
    mutation: { kind: 'none' },
    liveRunPolicy: 'blocked_preflight_only',
    evidenceRef:
      'baseline_repeat_2026_05_28_control_passed_final_text_only_structuredOutputCount_0',
    observedChildren: [
      {
        path: ['text', 'verbosity'],
        valueShape: 'provider-string',
      },
    ],
    blockedReason:
      'no OAuth-specific structured-output field has been observed under text',
  };

const EXPERIMENTS = new Map<
  OAuthWireDiscoveryExperimentId,
  OAuthWireDiscoveryExperiment
>([
  ['baseline_repeat', BASELINE_REPEAT_EXPERIMENT],
  ['text_subtree_observation', TEXT_SUBTREE_OBSERVATION_EXPERIMENT],
]);

export function getOAuthWireDiscoveryExperimentIds(): OAuthWireDiscoveryExperimentId[] {
  return [...EXPERIMENTS.keys()];
}

// Syntax guard only. Known-id validation happens in resolveOAuthWireDiscoveryExperiment().
export function isOAuthWireDiscoveryExperimentId(value: string): boolean {
  return EXPERIMENT_ID_PATTERN.test(value);
}

export function resolveOAuthWireDiscoveryExperiment(
  experimentId: string | undefined,
): OAuthWireDiscoveryExperimentResolveResult {
  if (experimentId === undefined || experimentId.trim() === '') {
    return {
      ok: false,
      reasonCode: 'experiment_required',
      message: 'OAuth wire discovery experiment id is required',
    };
  }

  if (!isOAuthWireDiscoveryExperimentId(experimentId)) {
    return {
      ok: false,
      reasonCode: 'experiment_invalid',
      message: `Invalid OAuth wire discovery experiment id: ${experimentId}`,
    };
  }

  const experiment = [...EXPERIMENTS.values()].find(
    (candidate) => candidate.id === experimentId,
  );
  if (experiment === undefined) {
    return {
      ok: false,
      reasonCode: 'experiment_unknown',
      message: `Unknown OAuth wire discovery experiment: ${experimentId}`,
    };
  }

  return { ok: true, experiment };
}
