import { createLogger } from '@geulbat/structured-logger/logger';

import type {
  compactProviderNativeHistory,
  ProviderNativeCompactionInput,
  ProviderNativeCompactionPolicy,
} from '../../llm/provider/provider-native-compaction.js';
import { normalizeProviderErrorCode } from '../../llm/provider/provider-error.js';
import type { ProviderUsageTelemetry } from '../../llm/provider/wire/types.js';
import type { AgentEventPayloadMap } from '../events.js';
import type { compactThreadContextNative } from './compaction-run.js';

const logger = createLogger('agent/memory/compaction-loop');

const PROJECTION_FIRST_COMPACTION_INSTRUCTIONS = `Compact only the supplied older conversation prefix. The current active tail is retained verbatim outside this request.

Tool results in the prefix are already the model-visible digest/reference projections selected before first visibility. Treat the evidence manifest as metadata, preserve material outputRef references, and do not invent facts hidden behind a reference. Expanded evidence pages are explicit, bounded exceptions. Do not request or assume any other durable output content.`;

type ProviderNativeCompactionRequest = Parameters<
  Parameters<typeof compactThreadContextNative>[0]['compactHistory']
>[0];

interface ProviderNativeCompactionCommitterDependencies {
  compactHistory: typeof compactProviderNativeHistory;
  compactThread: typeof compactThreadContextNative;
  resolveEvidencePages?: NonNullable<
    Parameters<typeof compactThreadContextNative>[0]['resolveEvidencePages']
  >;
}

interface ProviderNativeCompactionContextUsage {
  quality: 'exact' | 'estimated';
  modelId: string;
  inputTokens: number;
  contextWindow: number;
  thresholdTokens: number;
  requestBytes?: number;
}

type ProviderNativeCompactionCommitResult =
  | {
      kind: 'compacted';
      providerRoundAnchorEntryId: string;
      providerUsageTelemetry?: ProviderUsageTelemetry;
    }
  | { kind: 'not_needed'; reason: 'no_material_growth' }
  | {
      kind: 'failed';
      reason:
        | 'provider_compaction_failed'
        | 'provider_compaction_output_invalid'
        | 'provider_history_invalid'
        | 'evidence_recovery_failed'
        | 'no_summarizable_prefix'
        | 'compaction_ineffective'
        | 'stale_snapshot'
        | 'transcript_empty';
      message: string;
    };

function buildProjectionFirstCompactionSystemPrompt(
  systemPrompt: string,
  request: ProviderNativeCompactionRequest,
): string {
  return `${systemPrompt}\n\n${PROJECTION_FIRST_COMPACTION_INSTRUCTIONS}\n\n${JSON.stringify(
    {
      evidenceManifest: request.evidence,
      expandedEvidencePages: request.expandedEvidencePages,
    },
  )}`;
}

export function createProviderNativeCompactionCommitter(
  deps: ProviderNativeCompactionCommitterDependencies,
) {
  const ineffectiveAttemptByContext = new Map<string, string>();

  return async function commitProviderNativeCompaction(args: {
    workspaceRoot: string;
    threadId: string;
    nativeInput: ProviderNativeCompactionInput;
    contextUsage: ProviderNativeCompactionContextUsage;
    policy: ProviderNativeCompactionPolicy;
    publishContextUsage(
      snapshot: AgentEventPayloadMap['context_usage_updated'],
    ): void;
    tokensBefore: number;
  }): Promise<ProviderNativeCompactionCommitResult> {
    const attemptContextKey = `${args.threadId}\0${args.policy.providerId}\0${args.policy.model}`;
    const blockedAttemptKey =
      ineffectiveAttemptByContext.get(attemptContextKey);
    try {
      const result = await deps.compactThread({
        workspaceRoot: args.workspaceRoot,
        threadId: args.threadId,
        history: args.nativeInput.history,
        providerId: args.policy.providerId,
        model: args.policy.model,
        ...(args.nativeInput.providerReplayScopeId === undefined
          ? {}
          : {
              providerReplayScopeId: args.nativeInput.providerReplayScopeId,
            }),
        tokensBefore: args.tokensBefore,
        contextWindow: args.policy.contextWindow,
        thresholdTokens: args.policy.thresholdTokens,
        ...(blockedAttemptKey === undefined ? {} : { blockedAttemptKey }),
        ...(deps.resolveEvidencePages === undefined
          ? {}
          : { resolveEvidencePages: deps.resolveEvidencePages }),
        ...(args.nativeInput.signal === undefined
          ? {}
          : { signal: args.nativeInput.signal }),
        compactHistory: async (request) =>
          await deps.compactHistory(
            {
              ...args.nativeInput,
              history: [...request.historyPrefix],
              systemPrompt: buildProjectionFirstCompactionSystemPrompt(
                args.nativeInput.systemPrompt,
                request,
              ),
            },
            args.policy,
          ),
      });
      if (result.kind === 'compacted') {
        ineffectiveAttemptByContext.delete(attemptContextKey);
        logger.info('provider-native context compaction committed', {
          providerId: args.policy.providerId,
          model: args.policy.model,
          tokensBefore: args.tokensBefore,
          measurementQuality: args.contextUsage.quality,
          thresholdTokens: args.policy.thresholdTokens,
          historyBytesBefore: result.historyBytesBefore,
          historyBytesAfter: result.historyBytesAfter,
        });
        if (args.contextUsage.quality === 'exact') {
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
            historyBytesBefore: result.historyBytesBefore,
            historyBytesAfter: result.historyBytesAfter,
          });
        }
        return {
          kind: 'compacted',
          providerRoundAnchorEntryId: result.providerRoundAnchorEntryId,
          ...(result.providerUsageTelemetry === undefined
            ? {}
            : { providerUsageTelemetry: result.providerUsageTelemetry }),
        };
      }
      if (result.kind === 'no_material_growth') {
        return { kind: 'not_needed', reason: 'no_material_growth' };
      }
      if (
        result.kind === 'ineffective' ||
        result.kind === 'repeated_ineffective'
      ) {
        ineffectiveAttemptByContext.set(attemptContextKey, result.attemptKey);
        logger.warn('provider-native compaction produced no useful savings', {
          providerId: args.policy.providerId,
          model: args.policy.model,
          repeated: result.kind === 'repeated_ineffective',
          ...(result.kind === 'ineffective'
            ? {
                historyBytesBefore: result.historyBytesBefore,
                historyBytesAfter: result.historyBytesAfter,
              }
            : {}),
        });
        return {
          kind: 'failed',
          reason: 'compaction_ineffective',
          message:
            'context compaction did not produce a smaller validated history',
        };
      }
      if (result.kind === 'stale_snapshot') {
        return {
          kind: 'failed',
          reason: 'stale_snapshot',
          message: 'context changed while compaction was being committed',
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
      if (result.kind === 'evidence_recovery_failed') {
        return {
          kind: 'failed',
          reason: 'evidence_recovery_failed',
          message: 'context compaction evidence recovery failed',
        };
      }
      if (result.kind === 'history_invalid') {
        return {
          kind: 'failed',
          reason: 'provider_history_invalid',
          message: 'context compaction history validation failed',
        };
      }
      if (result.kind === 'provider_output_invalid') {
        return {
          kind: 'failed',
          reason: 'provider_compaction_output_invalid',
          message: 'provider-native context compaction output is invalid',
        };
      }
      return {
        kind: 'failed',
        reason: 'transcript_empty',
        message: 'context compaction requires a persisted transcript',
      };
    } catch (error: unknown) {
      logger.warn('provider-native compaction failed', {
        providerId: args.policy.providerId,
        model: args.policy.model,
        code: normalizeProviderErrorCode(error),
      });
      return {
        kind: 'failed',
        reason: 'provider_compaction_failed',
        message: 'provider-native context compaction failed',
      };
    }
  };
}
