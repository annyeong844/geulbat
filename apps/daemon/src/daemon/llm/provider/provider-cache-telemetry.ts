import { isRecord } from '../../runtime-json.js';
import type { ProviderUsageTelemetry } from './wire/types.js';

interface ProviderTelemetryContext {
  promptCacheKeyHash?: string;
  stablePrefixFingerprint?: string;
  prefixFingerprintVersion?: string;
  cacheProjectionVersion?: string;
}

type TelemetryRecord = Record<string, unknown>;

export function normalizeProviderUsageTelemetry(
  usage: unknown,
): ProviderUsageTelemetry | undefined {
  const usageRecord = asRecord(usage);
  if (!usageRecord) {
    return undefined;
  }

  const inputTokens = readNonNegativeInteger(usageRecord, [
    'input_tokens',
    'inputTokens',
  ]);
  const outputTokens = readNonNegativeInteger(usageRecord, [
    'output_tokens',
    'outputTokens',
  ]);
  const cachedInputTokens =
    readNonNegativeInteger(usageRecord, [
      'cached_input_tokens',
      'cachedInputTokens',
    ]) ?? readNestedCachedInputTokens(usageRecord);

  if (
    inputTokens === undefined &&
    outputTokens === undefined &&
    cachedInputTokens === undefined
  ) {
    return undefined;
  }

  if (inputTokens !== undefined) {
    return {
      inputTokens,
      ...(outputTokens !== undefined ? { outputTokens } : {}),
      ...(cachedInputTokens !== undefined ? { cachedInputTokens } : {}),
    };
  }

  if (outputTokens !== undefined) {
    return {
      outputTokens,
      ...(cachedInputTokens !== undefined ? { cachedInputTokens } : {}),
    };
  }

  if (cachedInputTokens !== undefined) {
    return { cachedInputTokens };
  }

  return undefined;
}

export function buildProviderCacheTelemetryLogFields(
  telemetry: ProviderUsageTelemetry | undefined,
  context: ProviderTelemetryContext,
): Record<string, string | number> {
  const traceFields = {
    ...(context.promptCacheKeyHash !== undefined
      ? { promptCacheKeyHash: context.promptCacheKeyHash }
      : {}),
    ...(context.stablePrefixFingerprint !== undefined
      ? { stablePrefixFingerprint: context.stablePrefixFingerprint }
      : {}),
    ...(context.prefixFingerprintVersion !== undefined
      ? { prefixFingerprintVersion: context.prefixFingerprintVersion }
      : {}),
    ...(context.cacheProjectionVersion !== undefined
      ? { cacheProjectionVersion: context.cacheProjectionVersion }
      : {}),
  };

  if (!telemetry) {
    return { providerUsage: 'absent', ...traceFields };
  }

  return {
    providerUsage: 'present',
    ...traceFields,
    ...(telemetry.inputTokens !== undefined
      ? { inputTokens: telemetry.inputTokens }
      : {}),
    ...(telemetry.outputTokens !== undefined
      ? { outputTokens: telemetry.outputTokens }
      : {}),
    ...(telemetry.cachedInputTokens !== undefined
      ? { cachedInputTokens: telemetry.cachedInputTokens }
      : {}),
    ...readCacheHitRatio(telemetry),
  };
}

function readNestedCachedInputTokens(
  usageRecord: TelemetryRecord,
): number | undefined {
  const snakeDetails = asRecord(usageRecord.input_tokens_details);
  const camelDetails = asRecord(usageRecord.inputTokensDetails);

  return (
    readNonNegativeInteger(snakeDetails, ['cached_tokens', 'cachedTokens']) ??
    readNonNegativeInteger(camelDetails, ['cached_tokens', 'cachedTokens'])
  );
}

function readCacheHitRatio(
  telemetry: ProviderUsageTelemetry,
): { cacheHitRatio: number } | Record<string, never> {
  if (
    telemetry.inputTokens === undefined ||
    telemetry.inputTokens <= 0 ||
    telemetry.cachedInputTokens === undefined
  ) {
    return {};
  }

  return {
    cacheHitRatio: Number(
      (telemetry.cachedInputTokens / telemetry.inputTokens).toFixed(4),
    ),
  };
}

function readNonNegativeInteger(
  record: TelemetryRecord | null,
  keys: string[],
): number | undefined {
  if (!record) {
    return undefined;
  }

  for (const key of keys) {
    const value = record[key];
    if (
      typeof value === 'number' &&
      Number.isSafeInteger(value) &&
      value >= 0
    ) {
      return value;
    }
  }
  return undefined;
}

function asRecord(value: unknown): TelemetryRecord | null {
  return isRecord(value) ? value : null;
}
