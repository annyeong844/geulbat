export function buildAssistantTranscriptPerformanceReport({
  environment,
  fixture,
  samples,
}) {
  const coldSamples = samples.filter((sample) => sample.cacheState === 'cold');
  const warmSamples = samples.filter((sample) => sample.cacheState === 'warm');
  return {
    schemaVersion: 'assistant_transcript_performance_v1',
    environment,
    fixture,
    samples,
    aggregates: {
      cold: summarizeSamples(coldSamples),
      warm: summarizeSamples(warmSamples),
    },
  };
}

function summarizeSamples(samples) {
  const phaseNames = ['liveUpdates', 'activityBurst', 'textBurst', 'settle'];
  return {
    sampleCount: samples.length,
    wallDurationMs: summarizeNumbers(
      samples.map((sample) => sample.wallDurationMs),
    ),
    phases: Object.fromEntries(
      phaseNames.map((phaseName) => [
        phaseName,
        {
          commitCount: summarizeNumbers(
            samples.map((sample) => sample.result[phaseName].commitCount),
          ),
          totalActualDurationMs: summarizeNumbers(
            samples.map(
              (sample) => sample.result[phaseName].totalActualDurationMs,
            ),
          ),
          maxActualDurationMs: summarizeNumbers(
            samples.map(
              (sample) => sample.result[phaseName].maxActualDurationMs,
            ),
          ),
        },
      ]),
    ),
    responsiveness: {
      longTaskCount: summarizeNumbers(
        samples.map((sample) => sample.result.responsiveness.longTaskCount),
      ),
      droppedFrameEstimate: summarizeNumbers(
        samples.map(
          (sample) => sample.result.responsiveness.droppedFrameEstimate,
        ),
      ),
      maxFrameGapMs: summarizeNumbers(
        samples.map((sample) => sample.result.responsiveness.maxFrameGapMs),
      ),
    },
  };
}

function summarizeNumbers(values) {
  if (values.length === 0) {
    return null;
  }
  const sorted = [...values].sort((left, right) => left - right);
  const mean =
    values.reduce((total, value) => total + value, 0) / values.length;
  const variance =
    values.reduce((total, value) => total + (value - mean) ** 2, 0) /
    values.length;
  return {
    min: round(sorted[0]),
    median: round(percentile(sorted, 0.5)),
    p95: round(percentile(sorted, 0.95)),
    max: round(sorted.at(-1)),
    mean: round(mean),
    standardDeviation: round(Math.sqrt(variance)),
  };
}

function percentile(sorted, ratio) {
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil(sorted.length * ratio) - 1),
  );
  return sorted[index];
}

function round(value) {
  return Number(value.toFixed(3));
}
