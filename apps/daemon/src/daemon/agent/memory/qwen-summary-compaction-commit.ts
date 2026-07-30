import { createLogger } from '@geulbat/structured-logger/logger';

import type { CallModelInput } from '../../llm/provider/client.js';
import { normalizeProviderErrorCode } from '../../llm/provider/provider-error.js';
import { hashProviderTraceIdentity } from '../../llm/provider/provider-cache-projection.js';
import {
  measureQwenChatHistoryBytes,
  type QwenContextCapacityPolicy,
  type summarizeQwenHistory,
} from '../../llm/provider/qwen/index.js';
import type { ProviderUsageTelemetry } from '../../llm/provider/wire/types.js';
import type { AgentEventPayloadMap } from '../events.js';
import type { loadExistingHistory } from '../loop-history.js';
import type { BudgetProfile } from '../contract.js';
import type { compactThreadContextSummary } from './compaction-run.js';

const logger = createLogger('agent/memory/compaction-loop');

interface QwenSummaryCompactionCommitterDependencies {
  compactSummaryThread: typeof compactThreadContextSummary;
  summarizeHistory: typeof summarizeQwenHistory;
  loadCompactedHistory: typeof loadExistingHistory;
  estimateInputTokens(
    requestBytes: number,
    calibration: { requestBytes: number; inputTokens: number },
  ): number | undefined;
}

interface QwenSummaryCompactionContextUsage {
  quality: 'exact' | 'estimated';
  modelId: string;
  inputTokens: number;
  contextWindow: number;
  thresholdTokens: number;
  requestBytes?: number;
}

type QwenSummaryCompactionCommitResult =
  | {
      kind: 'compacted';
      providerRoundAnchorEntryId: string;
      providerUsageTelemetry?: ProviderUsageTelemetry;
    }
  | {
      kind: 'failed';
      reason:
        | 'compaction_measurement_unavailable'
        | 'provider_compaction_failed'
        | 'provider_compaction_output_invalid'
        | 'no_summarizable_prefix'
        | 'retained_context_exceeds_budget'
        | 'stale_snapshot'
        | 'transcript_empty';
      message: string;
    };

type QwenSummaryCompactionInput = Pick<
  CallModelInput,
  | 'history'
  | 'systemPrompt'
  | 'tools'
  | 'deferredTools'
  | 'providerSessionId'
  | 'providerRequestOptions'
  | 'providerReplayScopeId'
  | 'signal'
> & {
  providerWebSocketSessions?: CallModelInput['providerWebSocketSessions'];
};

function buildQwenSummaryBudgetProfile(
  args: {
    input: QwenSummaryCompactionInput;
    policy: QwenContextCapacityPolicy;
    inputTokens: number;
    requestBytes: number;
    requestHistoryBytes: number;
  },
  estimateInputTokens: QwenSummaryCompactionCommitterDependencies['estimateInputTokens'],
): BudgetProfile | undefined {
  if (
    args.requestBytes <= 0 ||
    args.requestHistoryBytes < 0 ||
    args.requestHistoryBytes > args.requestBytes
  ) {
    return undefined;
  }
  const requestOverheadTokens = estimateInputTokens(
    args.requestBytes - args.requestHistoryBytes,
    {
      requestBytes: args.requestBytes,
      inputTokens: args.inputTokens,
    },
  );
  if (requestOverheadTokens === undefined) {
    return undefined;
  }
  return {
    model: args.policy.model,
    contextWindow: args.policy.contextWindow,
    reserveTokens: args.policy.contextWindow - args.policy.thresholdTokens,
    thresholdTokens: args.policy.thresholdTokens,
    keepRecentTokens: args.policy.contextWindow - args.policy.thresholdTokens,
    summaryBudgetTokens: args.policy.summaryMaxOutputTokens,
    requestOverheadTokens,
    requestProfileHash: hashProviderTraceIdentity(
      JSON.stringify({
        providerId: args.policy.providerId,
        model: args.policy.model,
        systemPrompt: args.input.systemPrompt,
        tools: args.input.tools,
        deferredTools: args.input.deferredTools,
        providerRequestOptions: args.input.providerRequestOptions,
      }),
    ),
    compactionVersion: args.policy.compactionVersion,
  };
}

export function createQwenSummaryCompactionCommitter(
  deps: QwenSummaryCompactionCommitterDependencies,
) {
  return async function commitQwenSummaryCompaction(args: {
    workspaceRoot: string;
    input: QwenSummaryCompactionInput;
    contextUsage: QwenSummaryCompactionContextUsage;
    policy: QwenContextCapacityPolicy;
    requestBytes: number | undefined;
    requestHistoryBytes: number | undefined;
    measureHistoryBytes(): number;
    publishContextUsage(
      snapshot: AgentEventPayloadMap['context_usage_updated'],
    ): void;
  }): Promise<QwenSummaryCompactionCommitResult> {
    if (
      args.requestBytes === undefined ||
      args.requestHistoryBytes === undefined
    ) {
      return {
        kind: 'failed',
        reason: 'compaction_measurement_unavailable',
        message: 'context compaction request measurement is unavailable',
      };
    }
    const requestBytes = args.requestBytes;
    const requestHistoryBytes = args.requestHistoryBytes;
    const budgetProfile = buildQwenSummaryBudgetProfile(
      {
        input: args.input,
        policy: args.policy,
        inputTokens: args.contextUsage.inputTokens,
        requestBytes,
        requestHistoryBytes,
      },
      (bytes, calibration) => deps.estimateInputTokens(bytes, calibration),
    );
    if (budgetProfile === undefined) {
      return {
        kind: 'failed',
        reason: 'compaction_measurement_unavailable',
        message: 'context compaction request measurement is invalid',
      };
    }

    const historyBytesBefore = args.measureHistoryBytes();
    let providerUsageTelemetry: ProviderUsageTelemetry | undefined;
    try {
      const result = await deps.compactSummaryThread({
        workspaceRoot: args.workspaceRoot,
        threadId: args.input.providerSessionId,
        history: args.input.history,
        currentRequestTokens: args.contextUsage.inputTokens,
        budgetProfile,
        tokenCounter: {
          countHistoryTokens(history) {
            const historyBytes = measureQwenChatHistoryBytes({
              history: [...history],
              ...(args.input.providerReplayScopeId === undefined
                ? {}
                : {
                    providerReplayScopeId: args.input.providerReplayScopeId,
                  }),
            });
            const estimatedTokens = deps.estimateInputTokens(historyBytes, {
              requestBytes,
              inputTokens: args.contextUsage.inputTokens,
            });
            if (estimatedTokens === undefined) {
              throw new Error(
                'Qwen retained context token estimate is invalid',
              );
            }
            return estimatedTokens;
          },
        },
        summarizer: {
          async summarizeContext(request) {
            const summary = await deps.summarizeHistory(
              {
                historyPrefix: request.historyPrefix,
                model: args.policy.model,
                providerSessionId: args.input.providerSessionId,
                ...(args.input.providerWebSocketSessions === undefined
                  ? {}
                  : {
                      providerRequestSessions:
                        args.input.providerWebSocketSessions,
                    }),
                ...(args.input.providerReplayScopeId === undefined
                  ? {}
                  : {
                      providerReplayScopeId: args.input.providerReplayScopeId,
                    }),
                ...(request.signal === undefined
                  ? {}
                  : { signal: request.signal }),
              },
              args.policy,
            );
            providerUsageTelemetry = summary.providerUsageTelemetry;
            return summary;
          },
        },
        ...(args.input.signal === undefined
          ? {}
          : { signal: args.input.signal }),
      });
      if (result.kind === 'compacted') {
        const compactedHistory = await deps.loadCompactedHistory(
          args.workspaceRoot,
          args.input.providerSessionId,
          {
            providerId: args.policy.providerId,
            model: args.policy.model,
            ...(args.input.providerReplayScopeId === undefined
              ? {}
              : { replayScopeId: args.input.providerReplayScopeId }),
          },
        );
        args.input.history.splice(
          0,
          args.input.history.length,
          ...compactedHistory,
        );
        const historyBytesAfter = args.measureHistoryBytes();
        logger.info('Qwen summary context compaction committed', {
          providerId: args.policy.providerId,
          model: args.policy.model,
          tokensBefore: args.contextUsage.inputTokens,
          measurementQuality: args.contextUsage.quality,
          thresholdTokens: args.policy.thresholdTokens,
          retainedTokens: result.retainedTokens,
          summaryTokens: result.summaryTokens,
          historyBytesBefore,
          historyBytesAfter,
        });
        if (
          args.contextUsage.quality === 'exact' &&
          historyBytesAfter < historyBytesBefore
        ) {
          args.publishContextUsage({
            state: 'compacted',
            quality: 'exact',
            modelId: args.contextUsage.modelId,
            inputTokens: args.contextUsage.inputTokens,
            contextWindow: args.contextUsage.contextWindow,
            thresholdTokens: args.contextUsage.thresholdTokens,
            ...(args.contextUsage.requestBytes === undefined
              ? {}
              : { requestBytes: args.contextUsage.requestBytes }),
            compactionEntryId: result.checkpoint.entryId,
            historyBytesBefore,
            historyBytesAfter,
          });
        }
        return {
          kind: 'compacted',
          providerRoundAnchorEntryId: result.providerRoundAnchorEntryId,
          ...(providerUsageTelemetry === undefined
            ? {}
            : { providerUsageTelemetry }),
        };
      }
      if (result.kind === 'no_summarizable_prefix') {
        return {
          kind: 'failed',
          reason: 'no_summarizable_prefix',
          message:
            'context compaction cannot replace the current active user turn',
        };
      }
      if (result.kind === 'tail_exceeds_budget') {
        return {
          kind: 'failed',
          reason: 'retained_context_exceeds_budget',
          message:
            'the current active user turn exceeds the retained context budget',
        };
      }
      if (result.kind === 'summary_invalid') {
        return {
          kind: 'failed',
          reason: 'provider_compaction_output_invalid',
          message: `Qwen summary compaction output is invalid: ${result.reason}`,
        };
      }
      if (result.kind === 'stale_snapshot') {
        return {
          kind: 'failed',
          reason: 'stale_snapshot',
          message: 'context changed while compaction was being committed',
        };
      }
      return {
        kind: 'failed',
        reason: 'transcript_empty',
        message: 'context compaction requires a persisted transcript',
      };
    } catch (error: unknown) {
      logger.warn('Qwen summary compaction failed', {
        providerId: args.policy.providerId,
        model: args.policy.model,
        code: normalizeProviderErrorCode(error),
      });
      return {
        kind: 'failed',
        reason: 'provider_compaction_failed',
        message: 'Qwen summary context compaction failed',
      };
    }
  };
}
