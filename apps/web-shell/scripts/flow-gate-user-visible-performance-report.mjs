import { summarizePerformanceNumbers } from '../../../scripts/performance-report-support.mjs';

const METRIC_PATHS = [
  'app.composerEditableMs',
  'directories.default.firstResultMs',
  'directories.default.completeMs',
  'directories.recent.firstResultMs',
  'directories.recent.completeMs',
  'cwd.existingSelectionMs',
  'cwd.existingRestoreMs',
  'cwd.newSessionResetMs',
  'surfaces.artifact.panelOpenMs',
  'surfaces.artifact.firstContentMs',
  'surfaces.image.panelOpenMs',
  'surfaces.image.firstFrameMs',
  'surfaces.video.panelOpenMs',
  'surfaces.video.firstFrameMs',
  'reconnect.connectedMs',
  'reconnect.transcriptVisibleMs',
  'reconnect.activeRunControlVisibleMs',
];

export function buildFlowGateUserVisiblePerformanceSample({
  environment,
  results,
  reconnectRecovery,
  runSettlement,
  artifact,
  app,
  fileBrowser,
}) {
  return {
    schemaVersion: 'flow_gate_user_visible_performance_sample_v1',
    environment,
    cacheState: 'isolated_cold',
    correctness: {
      allFlowsPassed: results.every((result) => result.ok),
      passedFlowCount: results.filter((result) => result.ok).length,
      flowCount: results.length,
      flowNames: results.map((result) => result.name),
    },
    metrics: {
      app: app.userVisible,
      directories: fileBrowser.userVisible.directories,
      cwd: runSettlement.userVisible.cwd,
      surfaces: {
        artifact: artifact.userVisible,
        image: fileBrowser.userVisible.media.image,
        video: fileBrowser.userVisible.media.video,
      },
      reconnect: reconnectRecovery.browser.userVisible,
    },
  };
}

export function buildFlowGateUserVisiblePerformanceBaseline(samples) {
  if (samples.length === 0) {
    throw new Error('user-visible performance baseline requires samples');
  }
  for (const sample of samples) {
    if (
      sample.schemaVersion !== 'flow_gate_user_visible_performance_sample_v1' ||
      sample.cacheState !== 'isolated_cold' ||
      sample.correctness?.allFlowsPassed !== true
    ) {
      throw new Error(
        'user-visible performance baseline rejected an invalid or failed sample',
      );
    }
  }
  const firstEnvironment = samples[0].environment;
  const firstFingerprint = environmentFingerprint(firstEnvironment);
  if (
    samples.some(
      (sample) =>
        environmentFingerprint(sample.environment) !== firstFingerprint,
    )
  ) {
    throw new Error(
      'user-visible performance baseline cannot mix environments',
    );
  }
  return {
    schemaVersion: 'flow_gate_user_visible_performance_baseline_v1',
    environment: firstEnvironment,
    cacheState: 'isolated_cold',
    sampleCount: samples.length,
    samples: samples.map((sample) => ({
      capturedAt: sample.environment.capturedAt,
      correctness: sample.correctness,
      metrics: sample.metrics,
    })),
    aggregates: Object.fromEntries(
      METRIC_PATHS.map((metricPath) => [
        metricPath,
        summarizePerformanceNumbers(
          samples.map((sample) => readMetric(sample.metrics, metricPath)),
        ),
      ]),
    ),
  };
}

export function buildFlowGateUserVisiblePerformanceComparison({
  baseline,
  candidate,
  targetMetric,
}) {
  validatePerformanceBaseline(baseline, 'baseline');
  validatePerformanceBaseline(candidate, 'candidate');
  if (baseline.sampleCount !== candidate.sampleCount) {
    throw new Error(
      'user-visible performance comparison requires equal sample counts',
    );
  }
  if (
    comparisonEnvironmentFingerprint(baseline.environment) !==
    comparisonEnvironmentFingerprint(candidate.environment)
  ) {
    throw new Error(
      'user-visible performance comparison requires matching git head, runtime, and host',
    );
  }
  const baselineFlowNames = baseline.samples[0].correctness.flowNames;
  if (
    candidate.samples.some(
      (sample) =>
        JSON.stringify(sample.correctness.flowNames) !==
        JSON.stringify(baselineFlowNames),
    )
  ) {
    throw new Error(
      'user-visible performance comparison requires matching flow names',
    );
  }
  const metrics = Object.fromEntries(
    METRIC_PATHS.map((metricPath) => {
      const baselineSummary = baseline.aggregates[metricPath];
      const candidateSummary = candidate.aggregates[metricPath];
      const medianDeltaMs = roundPerformanceValue(
        candidateSummary.median - baselineSummary.median,
      );
      const p95DeltaMs = roundPerformanceValue(
        candidateSummary.p95 - baselineSummary.p95,
      );
      return [
        metricPath,
        {
          baseline: baselineSummary,
          candidate: candidateSummary,
          medianDeltaMs,
          medianDeltaPercent:
            baselineSummary.median === 0
              ? null
              : roundPerformanceValue(
                  (medianDeltaMs / baselineSummary.median) * 100,
                ),
          p95DeltaMs,
          p95DeltaPercent:
            baselineSummary.p95 === 0
              ? null
              : roundPerformanceValue((p95DeltaMs / baselineSummary.p95) * 100),
        },
      ];
    }),
  );
  const target = metrics[targetMetric];
  if (target === undefined) {
    throw new Error(
      `user-visible performance comparison target metric is unknown: ${targetMetric}`,
    );
  }
  return {
    schemaVersion: 'flow_gate_user_visible_performance_comparison_v1',
    cacheState: 'isolated_cold',
    sampleCount: baseline.sampleCount,
    environments: {
      baseline: baseline.environment,
      candidate: candidate.environment,
    },
    correctness: {
      allFlowsPassed: true,
      flowNames: baselineFlowNames,
    },
    target: {
      metricPath: targetMetric,
      direction: 'lower_is_better',
      decisionRule: 'median_improves_and_p95_does_not_regress',
      accepted: target.medianDeltaMs < 0 && target.p95DeltaMs <= 0,
      ...target,
    },
    metrics,
  };
}

function environmentFingerprint(environment) {
  return JSON.stringify({
    git: environment.git,
    runtime: environment.runtime,
    host: environment.host,
  });
}

function comparisonEnvironmentFingerprint(environment) {
  return JSON.stringify({
    gitHead: environment.git?.head,
    runtime: environment.runtime,
    host: environment.host,
  });
}

function validatePerformanceBaseline(report, label) {
  if (
    report?.schemaVersion !==
      'flow_gate_user_visible_performance_baseline_v1' ||
    report.cacheState !== 'isolated_cold' ||
    !Number.isSafeInteger(report.sampleCount) ||
    report.sampleCount <= 0 ||
    !Array.isArray(report.samples) ||
    report.samples.length !== report.sampleCount ||
    report.environment?.git?.head === undefined ||
    report.environment?.runtime === undefined ||
    report.environment?.host === undefined
  ) {
    throw new Error(
      `user-visible performance comparison rejected invalid ${label} report`,
    );
  }
  const firstFlowNames = report.samples[0]?.correctness?.flowNames;
  if (
    !Array.isArray(firstFlowNames) ||
    report.samples.some(
      (sample) =>
        sample.correctness?.allFlowsPassed !== true ||
        sample.correctness.passedFlowCount !== sample.correctness.flowCount ||
        JSON.stringify(sample.correctness.flowNames) !==
          JSON.stringify(firstFlowNames),
    )
  ) {
    throw new Error(
      `user-visible performance comparison rejected failed or mixed ${label} flows`,
    );
  }
  if (
    Object.keys(report.aggregates ?? {}).length !== METRIC_PATHS.length ||
    METRIC_PATHS.some(
      (metricPath) => !isPerformanceSummary(report.aggregates?.[metricPath]),
    )
  ) {
    throw new Error(
      `user-visible performance comparison rejected incomplete ${label} metrics`,
    );
  }
}

function isPerformanceSummary(value) {
  return (
    typeof value === 'object' &&
    value !== null &&
    ['min', 'median', 'p95', 'max', 'mean', 'standardDeviation'].every(
      (field) =>
        typeof value[field] === 'number' && Number.isFinite(value[field]),
    )
  );
}

function roundPerformanceValue(value) {
  return Number(value.toFixed(3));
}

function readMetric(metrics, metricPath) {
  let current = metrics;
  for (const segment of metricPath.split('.')) {
    current = current?.[segment];
  }
  if (typeof current !== 'number' || !Number.isFinite(current)) {
    throw new Error(
      `user-visible performance metric is missing: ${metricPath}`,
    );
  }
  return current;
}
