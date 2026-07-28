import { summarizePerformanceNumbers as summarizeNumbers } from '../../../scripts/performance-report-support.mjs';

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
