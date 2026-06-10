import { basename, isAbsolute, relative, resolve, sep } from 'node:path';

import {
  resolveOAuthWireDiscoveryExperiment,
  type OAuthWireDiscoveryExperimentId,
} from './responses-wire-discovery-experiments.js';

export type OAuthWireDiscoveryPreflightFailureReason =
  | 'experiment_required'
  | 'experiment_invalid'
  | 'experiment_unknown'
  | 'output_path_required'
  | 'output_path_outside_runtime_artifacts'
  | 'output_path_experiment_mismatch'
  | 'output_path_not_git_ignored';

export type OAuthWireDiscoveryPreflightOutput =
  | {
      kind: 'runtime_artifact';
      outputPath: string;
      repoRelativeOutputPath: string;
    }
  | {
      kind: 'none';
      reason: string;
    };

export type OAuthWireDiscoveryPreflightResult =
  | {
      ok: true;
      experimentId: OAuthWireDiscoveryExperimentId;
      liveRunPolicy:
        | 'explicit_operator_approval_required'
        | 'blocked_preflight_only';
      requestDiffSummary: string;
      output: OAuthWireDiscoveryPreflightOutput;
      warnings: string[];
    }
  | {
      ok: false;
      reasonCode: OAuthWireDiscoveryPreflightFailureReason;
      message: string;
    };

export async function checkOAuthWireDiscoveryPreflight(args: {
  repoRoot: string;
  experimentId?: string;
  outputPath?: string;
  isGitIgnored: (repoRelativePath: string) => Promise<boolean>;
}): Promise<OAuthWireDiscoveryPreflightResult> {
  const experimentResult = resolveOAuthWireDiscoveryExperiment(
    args.experimentId,
  );
  if (!experimentResult.ok) {
    return experimentResult;
  }
  const { experiment } = experimentResult;

  if (experiment.liveRunPolicy === 'blocked_preflight_only') {
    return {
      ok: true,
      experimentId: experiment.id,
      liveRunPolicy: experiment.liveRunPolicy,
      requestDiffSummary: experiment.requestDiffSummary,
      output: {
        kind: 'none',
        reason: experiment.blockedReason,
      },
      warnings: [
        'Sanitized local diagnostic evidence only; this does not prove provider-native structured-output support.',
        'Inspect the output for redaction before copying any summary into current-truth docs.',
        'Do not commit raw OAuth wire discovery artifacts.',
        `Preflight/status only; live capture is blocked for experiment ${experiment.id}.`,
        `Live capture blocked: ${experiment.blockedReason}.`,
      ],
    };
  }

  if (args.outputPath === undefined || args.outputPath.trim() === '') {
    return {
      ok: false,
      reasonCode: 'output_path_required',
      message: 'GEULBAT_OAUTH_WIRE_DISCOVERY_OUTPUT is required',
    };
  }

  const repoRoot = resolve(args.repoRoot);
  const outputPath = isAbsolute(args.outputPath)
    ? resolve(args.outputPath)
    : resolve(repoRoot, args.outputPath);
  const repoRelativeOutputPath = normalizeRepoRelativePath(
    relative(repoRoot, outputPath),
  );

  if (
    repoRelativeOutputPath.startsWith('../') ||
    repoRelativeOutputPath === '..' ||
    !repoRelativeOutputPath.startsWith(
      'runtime-artifacts/oauth-wire-discovery/',
    )
  ) {
    return {
      ok: false,
      reasonCode: 'output_path_outside_runtime_artifacts',
      message:
        'OAuth wire discovery output must be under runtime-artifacts/oauth-wire-discovery/.',
    };
  }

  const expectedSuffix = `-${experiment.id}.json`;
  if (!basename(repoRelativeOutputPath).endsWith(expectedSuffix)) {
    return {
      ok: false,
      reasonCode: 'output_path_experiment_mismatch',
      message: `OAuth wire discovery output filename must end with ${expectedSuffix}.`,
    };
  }

  if (!(await args.isGitIgnored(repoRelativeOutputPath))) {
    return {
      ok: false,
      reasonCode: 'output_path_not_git_ignored',
      message:
        'OAuth wire discovery output must be ignored by git before live capture.',
    };
  }

  return {
    ok: true,
    experimentId: experiment.id,
    liveRunPolicy: experiment.liveRunPolicy,
    requestDiffSummary: experiment.requestDiffSummary,
    output: {
      kind: 'runtime_artifact',
      outputPath,
      repoRelativeOutputPath,
    },
    warnings: [
      'Sanitized local diagnostic evidence only; this does not prove provider-native structured-output support.',
      'Inspect the output for redaction before copying any summary into current-truth docs.',
      'Do not commit raw OAuth wire discovery artifacts.',
      `Live capture requires explicit operator approval for experiment ${experiment.id}.`,
    ],
  };
}

export function isOAuthWireDiscoveryIgnoredByRootGitignore(args: {
  repoRelativePath: string;
  gitignoreText: string;
}): boolean {
  const rules = args.gitignoreText
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#'));
  return rules.some(
    (rule) =>
      rule === 'runtime-artifacts/oauth-wire-discovery/' &&
      args.repoRelativePath.startsWith(rule),
  );
}

function normalizeRepoRelativePath(value: string): string {
  return value.split(sep).join('/');
}
