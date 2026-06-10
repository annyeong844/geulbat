import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';

import {
  checkOAuthWireDiscoveryPreflight,
  isOAuthWireDiscoveryIgnoredByRootGitignore,
} from './responses-wire-discovery-preflight.js';

const repoRoot = resolve('/workspace/geulbat');

void test('checkOAuthWireDiscoveryPreflight accepts ignored output paths for named experiments', async () => {
  const result = await checkOAuthWireDiscoveryPreflight({
    repoRoot,
    experimentId: 'baseline_repeat',
    outputPath:
      'runtime-artifacts/oauth-wire-discovery/20260528T000000Z-baseline_repeat.json',
    isGitIgnored: async (repoRelativePath: string) => {
      assert.equal(
        repoRelativePath,
        'runtime-artifacts/oauth-wire-discovery/20260528T000000Z-baseline_repeat.json',
      );
      return true;
    },
  });

  assert.deepEqual(result, {
    ok: true,
    experimentId: 'baseline_repeat',
    liveRunPolicy: 'explicit_operator_approval_required',
    requestDiffSummary:
      'no request mutation; repeat the observed OAuth websocket final-text baseline capture',
    output: {
      kind: 'runtime_artifact',
      outputPath: resolve(
        repoRoot,
        'runtime-artifacts/oauth-wire-discovery/20260528T000000Z-baseline_repeat.json',
      ),
      repoRelativeOutputPath:
        'runtime-artifacts/oauth-wire-discovery/20260528T000000Z-baseline_repeat.json',
    },
    warnings: [
      'Sanitized local diagnostic evidence only; this does not prove provider-native structured-output support.',
      'Inspect the output for redaction before copying any summary into current-truth docs.',
      'Do not commit raw OAuth wire discovery artifacts.',
      'Live capture requires explicit operator approval for experiment baseline_repeat.',
    ],
  });
});

void test('checkOAuthWireDiscoveryPreflight accepts text subtree observation without output path', async () => {
  let gitIgnoreChecks = 0;

  const result = await checkOAuthWireDiscoveryPreflight({
    repoRoot,
    experimentId: 'text_subtree_observation',
    isGitIgnored: async () => {
      gitIgnoreChecks += 1;
      return false;
    },
  });

  assert.deepEqual(result, {
    ok: true,
    experimentId: 'text_subtree_observation',
    liveRunPolicy: 'blocked_preflight_only',
    requestDiffSummary:
      'observed text subtree has child key text.verbosity with provider-string value shape; no request mutation; live capture blocked',
    output: {
      kind: 'none',
      reason:
        'no OAuth-specific structured-output field has been observed under text',
    },
    warnings: [
      'Sanitized local diagnostic evidence only; this does not prove provider-native structured-output support.',
      'Inspect the output for redaction before copying any summary into current-truth docs.',
      'Do not commit raw OAuth wire discovery artifacts.',
      'Preflight/status only; live capture is blocked for experiment text_subtree_observation.',
      'Live capture blocked: no OAuth-specific structured-output field has been observed under text.',
    ],
  });
  assert.equal(gitIgnoreChecks, 0);
});

void test('checkOAuthWireDiscoveryPreflight rejects missing experiment ids', async () => {
  const result = await checkOAuthWireDiscoveryPreflight({
    repoRoot,
    outputPath:
      'runtime-artifacts/oauth-wire-discovery/20260528T000000Z-baseline_repeat.json',
    isGitIgnored: async () => true,
  });

  assert.deepEqual(result, {
    ok: false,
    reasonCode: 'experiment_required',
    message: 'OAuth wire discovery experiment id is required',
  });
});

void test('checkOAuthWireDiscoveryPreflight rejects unknown experiment ids', async () => {
  const result = await checkOAuthWireDiscoveryPreflight({
    repoRoot,
    experimentId: 'text_format_guess',
    outputPath:
      'runtime-artifacts/oauth-wire-discovery/20260528T000000Z-text_format_guess.json',
    isGitIgnored: async () => true,
  });

  assert.deepEqual(result, {
    ok: false,
    reasonCode: 'experiment_unknown',
    message: 'Unknown OAuth wire discovery experiment: text_format_guess',
  });
});

void test('checkOAuthWireDiscoveryPreflight rejects output paths that do not include the experiment id', async () => {
  const result = await checkOAuthWireDiscoveryPreflight({
    repoRoot,
    experimentId: 'baseline_repeat',
    outputPath: 'runtime-artifacts/oauth-wire-discovery/baseline.json',
    isGitIgnored: async () => true,
  });

  assert.deepEqual(result, {
    ok: false,
    reasonCode: 'output_path_experiment_mismatch',
    message:
      'OAuth wire discovery output filename must end with -baseline_repeat.json.',
  });
});

void test('checkOAuthWireDiscoveryPreflight rejects output paths outside oauth wire runtime artifacts', async () => {
  const result = await checkOAuthWireDiscoveryPreflight({
    repoRoot,
    experimentId: 'baseline_repeat',
    outputPath: 'tmp/baseline.json',
    isGitIgnored: async () => true,
  });

  assert.deepEqual(result, {
    ok: false,
    reasonCode: 'output_path_outside_runtime_artifacts',
    message:
      'OAuth wire discovery output must be under runtime-artifacts/oauth-wire-discovery/.',
  });
});

void test('checkOAuthWireDiscoveryPreflight rejects output paths that git would track', async () => {
  const result = await checkOAuthWireDiscoveryPreflight({
    repoRoot,
    experimentId: 'baseline_repeat',
    outputPath:
      'runtime-artifacts/oauth-wire-discovery/20260528T000000Z-baseline_repeat.json',
    isGitIgnored: async () => false,
  });

  assert.deepEqual(result, {
    ok: false,
    reasonCode: 'output_path_not_git_ignored',
    message:
      'OAuth wire discovery output must be ignored by git before live capture.',
  });
});

void test('isOAuthWireDiscoveryIgnoredByRootGitignore recognizes the narrow runtime artifact ignore rule', () => {
  assert.equal(
    isOAuthWireDiscoveryIgnoredByRootGitignore({
      repoRelativePath: 'runtime-artifacts/oauth-wire-discovery/baseline.json',
      gitignoreText: [
        'node_modules/',
        'runtime-artifacts/oauth-wire-discovery/',
      ].join('\n'),
    }),
    true,
  );
  assert.equal(
    isOAuthWireDiscoveryIgnoredByRootGitignore({
      repoRelativePath: 'runtime-artifacts/other/baseline.json',
      gitignoreText: 'runtime-artifacts/oauth-wire-discovery/\n',
    }),
    false,
  );
});
