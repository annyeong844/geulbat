import test from 'node:test';
import assert from 'node:assert/strict';

import {
  getOAuthWireDiscoveryExperimentIds,
  isOAuthWireDiscoveryExperimentId,
  resolveOAuthWireDiscoveryExperiment,
} from './responses-wire-discovery-experiments.js';

void test('resolveOAuthWireDiscoveryExperiment returns the baseline_repeat control experiment', () => {
  const result = resolveOAuthWireDiscoveryExperiment('baseline_repeat');

  assert.ok(result.ok);
  assert.equal(result.experiment.id, 'baseline_repeat');
  assert.equal(result.experiment.kind, 'control');
  assert.deepEqual(result.experiment.mutation, { kind: 'none' });
  assert.equal(
    result.experiment.liveRunPolicy,
    'explicit_operator_approval_required',
  );
  assert.match(result.experiment.requestDiffSummary, /no request mutation/u);
});

void test('resolveOAuthWireDiscoveryExperiment returns the text subtree observation gate', () => {
  const result = resolveOAuthWireDiscoveryExperiment(
    'text_subtree_observation',
  );

  assert.ok(result.ok);
  assert.equal(result.experiment.id, 'text_subtree_observation');
  assert.equal(result.experiment.kind, 'observation_gate');
  assert.deepEqual(result.experiment.mutation, { kind: 'none' });
  assert.equal(result.experiment.liveRunPolicy, 'blocked_preflight_only');
  assert.equal(result.experiment.baselineObservedPath, 'text');
  assert.equal(
    result.experiment.evidenceRef,
    'baseline_repeat_2026_05_28_control_passed_final_text_only_structuredOutputCount_0',
  );
  assert.deepEqual(result.experiment.observedChildren, [
    {
      path: ['text', 'verbosity'],
      valueShape: 'provider-string',
    },
  ]);
  assert.match(
    result.experiment.blockedReason,
    /no OAuth-specific structured-output field has been observed under text/u,
  );
  assert.doesNotMatch(result.experiment.requestDiffSummary, /text\.format/u);
  assert.doesNotMatch(result.experiment.requestDiffSummary, /json_schema/u);
});

void test('resolveOAuthWireDiscoveryExperiment rejects unknown experiment ids', () => {
  assert.deepEqual(resolveOAuthWireDiscoveryExperiment('text_format_guess'), {
    ok: false,
    reasonCode: 'experiment_unknown',
    message: 'Unknown OAuth wire discovery experiment: text_format_guess',
  });
});

void test('isOAuthWireDiscoveryExperimentId accepts only simple lowercase underscore ids', () => {
  assert.equal(isOAuthWireDiscoveryExperimentId('baseline_repeat'), true);
  assert.equal(
    isOAuthWireDiscoveryExperimentId('text_subtree_observation'),
    true,
  );
  assert.equal(isOAuthWireDiscoveryExperimentId('baseline-repeat'), false);
  assert.equal(isOAuthWireDiscoveryExperimentId('../baseline_repeat'), false);
  assert.equal(isOAuthWireDiscoveryExperimentId('baseline_repeat.json'), false);
  assert.equal(isOAuthWireDiscoveryExperimentId('BASELINE_REPEAT'), false);
});

void test('getOAuthWireDiscoveryExperimentIds exposes the control and preflight-only descriptor', () => {
  assert.deepEqual(getOAuthWireDiscoveryExperimentIds(), [
    'baseline_repeat',
    'text_subtree_observation',
  ]);
});
