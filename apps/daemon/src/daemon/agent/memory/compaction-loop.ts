import {
  classifyContextRequestAdmission,
  evaluateContextCompactionTrigger,
} from '@geulbat/agent-loop/context-compaction';
import type { ProviderReplayScopeId } from '../../runtime-contracts.js';
import { createLogger } from '@geulbat/structured-logger/logger';

import type { CallModelInput } from '../../llm/provider/client.js';
import {
  prepareProviderTransitionCompaction,
  recoverProviderTransitionAfterOverflow,
  type RecoverProviderTransitionAfterOverflowArgs,
} from './provider-transition-compaction.js';
import {
  compactProviderNativeHistory,
  resolveProviderContextCapacityPolicy,
  type ProviderContextCapacityPolicy,
  type ProviderNativeCompactionInput,
  type ProviderNativeCompactionPolicy,
} from '../../llm/provider/provider-native-compaction.js';
import { normalizeProviderErrorCode } from '../../llm/provider/provider-error.js';
import { measureResponseWireInputBytes } from '../../llm/provider/transport/responses-wire-input.js';
import type {
  HistoryItem,
  ProviderUsageTelemetry,
} from '../../llm/provider/wire/types.js';
import type { ProviderRequestOptions } from '../../llm/provider/provider-options.js';
import type { ToolDefinition } from '../../tools/types.js';
import type { AgentEventPayloadMap } from '../events.js';
import { loadInitialHistory } from '../loop-history.js';
import { compactThreadContextNative } from './compaction-run.js';

interface AgentLoopMemoryRequestContext {
  workspaceRoot: string;
  threadId: string;
  history: HistoryItem[];
  systemPrompt: string;
  tools: ToolDefinition[];
  providerAuthRuntime: ProviderNativeCompactionInput['providerAuthRuntime'];
  providerRequestOptions: ProviderRequestOptions;
  providerReplayScopeId?: ProviderReplayScopeId;
  signal?: AbortSignal;
}

interface CompactAfterModelRoundArgs extends AgentLoopMemoryRequestContext {
  contextBudgetRound: AgentLoopContextBudgetRound;
  inputTokens?: number;
}

interface BeginContextBudgetRoundArgs extends AgentLoopMemoryRequestContext {
  onContextUsage?: (
    snapshot: AgentEventPayloadMap['context_usage_updated'],
  ) => void;
}

type PreDispatchAdmission =
  | { kind: 'unknown' }
  | { kind: 'fitting' }
  | {
      kind: 'near_policy' | 'over_window';
      estimatedInputTokens: number;
      policy: ProviderNativeCompactionPolicy;
    };

type PrepareBeforeModelRoundResult =
  | { kind: 'prepared' }
  | { kind: 'failed'; message: string };

interface AgentLoopContextBudgetRound {
  onProviderRequestPrepared: NonNullable<
    CallModelInput['onProviderRequestPrepared']
  >;
  prepareBeforeModelRound(): Promise<PrepareBeforeModelRoundResult>;
  getRequestBytes(): number | undefined;
  getToolResultContextBudget(): ToolResultContextBudget;
  publish(snapshot: AgentEventPayloadMap['context_usage_updated']): void;
}

interface ContextUsageCalibration {
  requestBytes: number;
  inputTokens: number;
}

export type ToolResultContextBudget =
  | {
      kind: 'available';
      quality: 'exact' | 'estimated';
      modelKey: string;
      availableRequestBytes: number;
    }
  | {
      kind: 'unknown';
      modelKey: string;
      reason:
        | 'request_measurement_unavailable'
        | 'policy_unavailable'
        | 'usage_unavailable'
        | 'history_measurement_failed'
        | 'invalid_measurement';
    };

type CompactAfterModelRoundResult =
  | {
      kind: 'not_needed';
      reason:
        | 'provider_not_supported'
        | 'usage_unavailable'
        | 'under_threshold'
        | 'no_material_growth';
    }
  | {
      kind: 'compacted';
      providerRoundAnchorEntryId: string;
      providerUsageTelemetry?: ProviderUsageTelemetry;
    }
  | {
      kind: 'failed';
      reason:
        | 'policy_resolution_failed'
        | 'trigger_invalid'
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

export interface AgentLoopMemoryPort {
  beginContextBudgetRound(
    args: BeginContextBudgetRoundArgs,
  ): AgentLoopContextBudgetRound;
  compactAfterModelRound(
    args: CompactAfterModelRoundArgs,
  ): Promise<CompactAfterModelRoundResult>;
  recoverProviderTransitionAfterOverflow?(
    this: void,
    args: RecoverProviderTransitionAfterOverflowArgs,
  ): Promise<boolean>;
}

interface AgentLoopMemoryPortDependencies {
  resolvePolicy: typeof resolveProviderContextCapacityPolicy;
  compactHistory: typeof compactProviderNativeHistory;
  compactThread: typeof compactThreadContextNative;
  prepareTransition?: typeof prepareProviderTransitionCompaction;
  loadHistory?: typeof loadInitialHistory;
  measureHistoryBytes?: (context: AgentLoopMemoryRequestContext) => number;
  resolveEvidencePages?: NonNullable<
    Parameters<typeof compactThreadContextNative>[0]['resolveEvidencePages']
  >;
}

const defaultAgentLoopMemoryPortDependencies: AgentLoopMemoryPortDependencies =
  {
    resolvePolicy: resolveProviderContextCapacityPolicy,
    compactHistory: compactProviderNativeHistory,
    compactThread: compactThreadContextNative,
    prepareTransition: prepareProviderTransitionCompaction,
    loadHistory: loadInitialHistory,
  };

const logger = createLogger('agent/memory/compaction-loop');

const PROJECTION_FIRST_COMPACTION_INSTRUCTIONS = `Compact only the supplied older conversation prefix. The current active tail is retained verbatim outside this request.

Tool results in the prefix are already the model-visible digest/reference projections selected before first visibility. Treat the evidence manifest as metadata, preserve material outputRef references, and do not invent facts hidden behind a reference. Expanded evidence pages are explicit, bounded exceptions. Do not request or assume any other durable output content.`;

function createContextModelKey(options: ProviderRequestOptions): string {
  return `${options.providerId}\0${options.model}`;
}

function supportsProviderNativeCompaction(
  policy: ProviderContextCapacityPolicy,
): policy is ProviderNativeCompactionPolicy {
  return (
    policy.providerId === 'openai_codex_direct' ||
    policy.providerId === 'grok_oauth'
  );
}

function estimateInputTokens(
  requestBytes: number,
  calibration: ContextUsageCalibration,
): number | undefined {
  const estimate = Math.round(
    requestBytes * (calibration.inputTokens / calibration.requestBytes),
  );
  return Number.isSafeInteger(estimate) && estimate >= 0 ? estimate : undefined;
}

function toProviderNativeCompactionInput(
  context: AgentLoopMemoryRequestContext,
): ProviderNativeCompactionInput {
  return {
    history: context.history,
    systemPrompt: context.systemPrompt,
    tools: context.tools,
    providerSessionId: context.threadId,
    providerAuthRuntime: context.providerAuthRuntime,
    providerRequestOptions: context.providerRequestOptions,
    ...(context.providerReplayScopeId === undefined
      ? {}
      : { providerReplayScopeId: context.providerReplayScopeId }),
    ...(context.signal === undefined ? {} : { signal: context.signal }),
  };
}

type ProviderNativeCompactionRequest = Parameters<
  Parameters<typeof compactThreadContextNative>[0]['compactHistory']
>[0];

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

export function createAgentLoopMemoryPort(
  deps: AgentLoopMemoryPortDependencies = defaultAgentLoopMemoryPortDependencies,
): AgentLoopMemoryPort {
  const policyByModel = new Map<
    string,
    Promise<ProviderContextCapacityPolicy>
  >();
  const resolvedPolicyByModel = new Map<
    string,
    ProviderContextCapacityPolicy
  >();
  const calibrationByModel = new Map<string, ContextUsageCalibration>();
  const exactInputTokensByRound = new WeakMap<
    AgentLoopContextBudgetRound,
    number
  >();
  const ineffectiveAttemptByContext = new Map<string, string>();
  const measureHistoryBytes =
    deps.measureHistoryBytes ??
    ((context: AgentLoopMemoryRequestContext) =>
      measureResponseWireInputBytes(context.history, {
        providerId: context.providerRequestOptions.providerId,
        model: context.providerRequestOptions.model,
        ...(context.providerReplayScopeId === undefined
          ? {}
          : { providerReplayScopeId: context.providerReplayScopeId }),
      }));
  let reportedUnsupportedProvider = false;
  let reportedMissingUsage = false;

  const resolvePolicy = async (
    context: AgentLoopMemoryRequestContext,
  ): Promise<ProviderContextCapacityPolicy> => {
    const modelKey = createContextModelKey(context.providerRequestOptions);
    let policyPromise = policyByModel.get(modelKey);
    if (policyPromise === undefined) {
      policyPromise = deps.resolvePolicy(
        toProviderNativeCompactionInput(context),
      );
      policyByModel.set(modelKey, policyPromise);
    }
    try {
      const policy = await policyPromise;
      resolvedPolicyByModel.set(modelKey, policy);
      return policy;
    } catch (error: unknown) {
      if (policyByModel.get(modelKey) === policyPromise) {
        policyByModel.delete(modelKey);
      }
      throw error;
    }
  };

  const commitProviderNativeCompaction = async (args: {
    context: AgentLoopMemoryRequestContext;
    contextBudgetRound: AgentLoopContextBudgetRound;
    contextUsage: {
      quality: 'exact' | 'estimated';
      modelId: string;
      inputTokens: number;
      contextWindow: number;
      thresholdTokens: number;
      requestBytes?: number;
    };
    policy: ProviderNativeCompactionPolicy;
    tokensBefore: number;
  }): Promise<
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
      }
  > => {
    const nativeInput = toProviderNativeCompactionInput(args.context);
    const attemptContextKey = `${args.context.threadId}\0${args.policy.providerId}\0${args.policy.model}`;
    const blockedAttemptKey =
      ineffectiveAttemptByContext.get(attemptContextKey);
    try {
      const result = await deps.compactThread({
        workspaceRoot: args.context.workspaceRoot,
        threadId: args.context.threadId,
        history: args.context.history,
        providerId: args.policy.providerId,
        model: args.policy.model,
        ...(args.context.providerReplayScopeId === undefined
          ? {}
          : {
              providerReplayScopeId: args.context.providerReplayScopeId,
            }),
        tokensBefore: args.tokensBefore,
        contextWindow: args.policy.contextWindow,
        thresholdTokens: args.policy.thresholdTokens,
        ...(blockedAttemptKey === undefined ? {} : { blockedAttemptKey }),
        ...(deps.resolveEvidencePages === undefined
          ? {}
          : { resolveEvidencePages: deps.resolveEvidencePages }),
        ...(args.context.signal === undefined
          ? {}
          : { signal: args.context.signal }),
        compactHistory: async (request) =>
          await deps.compactHistory(
            {
              ...nativeInput,
              history: [...request.historyPrefix],
              systemPrompt: buildProjectionFirstCompactionSystemPrompt(
                nativeInput.systemPrompt,
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
          args.contextBudgetRound.publish({
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

  return {
    beginContextBudgetRound(args) {
      const modelKey = createContextModelKey(args.providerRequestOptions);
      let requestBytes: number | undefined;
      let requestHistoryBytes: number | undefined;
      let admission: PreDispatchAdmission = { kind: 'unknown' };

      const contextBudgetRound: AgentLoopContextBudgetRound = {
        async onProviderRequestPrepared(measurement) {
          requestBytes = measurement.serializedBytes;
          requestHistoryBytes = measurement.serializedBytesBySource.history;
          let policy = resolvedPolicyByModel.get(modelKey);
          if (policy === undefined) {
            try {
              policy = await resolvePolicy(args);
            } catch (error: unknown) {
              admission = { kind: 'unknown' };
              args.onContextUsage?.({
                state: 'measured',
                quality: 'unknown',
                modelId: args.providerRequestOptions.model,
                requestBytes,
              });
              logger.warn(
                'provider request context admission is unknown because policy resolution failed',
                {
                  providerId: args.providerRequestOptions.providerId,
                  model: args.providerRequestOptions.model,
                  code: normalizeProviderErrorCode(error),
                  dominantPressureSource: measurement.dominantPressureSource,
                  serializedBytesBySource: measurement.serializedBytesBySource,
                },
              );
              return { kind: 'send' };
            }
          }
          const calibration = calibrationByModel.get(modelKey);
          const estimatedInputTokens =
            calibration === undefined
              ? undefined
              : estimateInputTokens(requestBytes, calibration);

          if (estimatedInputTokens === undefined) {
            admission = { kind: 'unknown' };
            args.onContextUsage?.({
              state: 'measured',
              quality: 'unknown',
              modelId: policy.model,
              requestBytes,
              contextWindow: policy.contextWindow,
              thresholdTokens: policy.thresholdTokens,
            });
            logger.info(
              'provider request context admission is unknown until an authoritative usage sample is available',
              {
                providerId: policy.providerId,
                model: policy.model,
                requestBytes,
                contextWindow: policy.contextWindow,
                thresholdTokens: policy.thresholdTokens,
                dominantPressureSource: measurement.dominantPressureSource,
                serializedBytesBySource: measurement.serializedBytesBySource,
              },
            );
            return { kind: 'send' };
          }

          const contextUsage = {
            state: 'measured' as const,
            quality: 'estimated' as const,
            modelId: policy.model,
            inputTokens: estimatedInputTokens,
            contextWindow: policy.contextWindow,
            thresholdTokens: policy.thresholdTokens,
            requestBytes,
          };
          args.onContextUsage?.(contextUsage);
          const classification = classifyContextRequestAdmission(
            estimatedInputTokens,
            {
              contextWindow: policy.contextWindow,
              reserveTokens: policy.contextWindow - policy.thresholdTokens,
              thresholdTokens: policy.thresholdTokens,
            },
          );
          if (classification.kind === 'invalid') {
            admission = { kind: 'unknown' };
            logger.warn('provider request context admission is invalid', {
              providerId: policy.providerId,
              model: policy.model,
              reason: classification.reason,
              ...(classification.field === undefined
                ? {}
                : { field: classification.field }),
              dominantPressureSource: measurement.dominantPressureSource,
              serializedBytesBySource: measurement.serializedBytesBySource,
            });
            return { kind: 'send' };
          }

          admission =
            classification.kind === 'fitting'
              ? classification
              : supportsProviderNativeCompaction(policy)
                ? {
                    ...classification,
                    estimatedInputTokens,
                    policy,
                  }
                : { kind: 'unknown' };
          logger.info('provider request context admission evaluated', {
            providerId: policy.providerId,
            model: policy.model,
            admission: classification.kind,
            measurementQuality: contextUsage.quality,
            inputTokens: estimatedInputTokens,
            requestBytes,
            contextWindow: policy.contextWindow,
            thresholdTokens: policy.thresholdTokens,
            dominantPressureSource: measurement.dominantPressureSource,
            serializedBytesBySource: measurement.serializedBytesBySource,
          });
          if (
            classification.kind !== 'fitting' &&
            !supportsProviderNativeCompaction(policy)
          ) {
            logger.warn(
              'provider request reached the context pressure threshold without a native compaction path',
              {
                providerId: policy.providerId,
                model: policy.model,
                admission: classification.kind,
                measurementQuality: contextUsage.quality,
                inputTokens: estimatedInputTokens,
                contextWindow: policy.contextWindow,
                thresholdTokens: policy.thresholdTokens,
              },
            );
          }
          return classification.kind === 'fitting' ||
            !supportsProviderNativeCompaction(policy)
            ? { kind: 'send' }
            : { kind: 'prepare', reason: classification.kind };
        },
        async prepareBeforeModelRound() {
          const preparationAdmission = admission;
          if (
            preparationAdmission.kind !== 'near_policy' &&
            preparationAdmission.kind !== 'over_window'
          ) {
            return {
              kind: 'failed',
              message:
                'context preparation was requested without an actionable admission',
            };
          }
          admission = { kind: 'unknown' };
          const contextUsage = {
            state: 'measured' as const,
            quality: 'estimated' as const,
            modelId: preparationAdmission.policy.model,
            inputTokens: preparationAdmission.estimatedInputTokens,
            contextWindow: preparationAdmission.policy.contextWindow,
            thresholdTokens: preparationAdmission.policy.thresholdTokens,
            ...(requestBytes === undefined ? {} : { requestBytes }),
          };
          const result = await commitProviderNativeCompaction({
            context: args,
            contextBudgetRound,
            contextUsage,
            policy: preparationAdmission.policy,
            tokensBefore: preparationAdmission.estimatedInputTokens,
          });
          if (result.kind === 'compacted') {
            return { kind: 'prepared' };
          }
          if (result.kind === 'not_needed') {
            return {
              kind: 'failed',
              message:
                'context preparation requires material history growth after the current compaction checkpoint',
            };
          }
          return { kind: 'failed', message: result.message };
        },
        getRequestBytes() {
          return requestBytes;
        },
        getToolResultContextBudget() {
          if (requestBytes === undefined || requestHistoryBytes === undefined) {
            return {
              kind: 'unknown',
              modelKey,
              reason: 'request_measurement_unavailable',
            };
          }
          const policy = resolvedPolicyByModel.get(modelKey);
          if (policy === undefined) {
            return {
              kind: 'unknown',
              modelKey,
              reason: 'policy_unavailable',
            };
          }
          const exactInputTokens =
            exactInputTokensByRound.get(contextBudgetRound);
          const calibratedInputTokens =
            exactInputTokens ??
            (() => {
              const calibration = calibrationByModel.get(modelKey);
              return calibration === undefined
                ? undefined
                : estimateInputTokens(requestBytes, calibration);
            })();
          if (
            calibratedInputTokens === undefined ||
            calibratedInputTokens <= 0
          ) {
            return {
              kind: 'unknown',
              modelKey,
              reason: 'usage_unavailable',
            };
          }

          let currentHistoryBytes: number;
          try {
            currentHistoryBytes = measureHistoryBytes(args);
          } catch (error: unknown) {
            logger.warn(
              'tool result context budget history measurement failed',
              {
                providerId: args.providerRequestOptions.providerId,
                model: args.providerRequestOptions.model,
                code: normalizeProviderErrorCode(error),
              },
            );
            return {
              kind: 'unknown',
              modelKey,
              reason: 'history_measurement_failed',
            };
          }

          const thresholdRequestBytes = Math.floor(
            (requestBytes / calibratedInputTokens) * policy.thresholdTokens,
          );
          const currentRequestBytes =
            requestBytes - requestHistoryBytes + currentHistoryBytes;
          if (
            !Number.isSafeInteger(thresholdRequestBytes) ||
            thresholdRequestBytes < 0 ||
            !Number.isSafeInteger(currentRequestBytes) ||
            currentRequestBytes < 0
          ) {
            return {
              kind: 'unknown',
              modelKey,
              reason: 'invalid_measurement',
            };
          }
          return {
            kind: 'available',
            quality: exactInputTokens === undefined ? 'estimated' : 'exact',
            modelKey,
            availableRequestBytes: Math.max(
              0,
              thresholdRequestBytes - currentRequestBytes,
            ),
          };
        },
        publish(snapshot) {
          args.onContextUsage?.(snapshot);
        },
      };
      return contextBudgetRound;
    },
    async recoverProviderTransitionAfterOverflow(args) {
      return await recoverProviderTransitionAfterOverflow(args, {
        ...(deps.prepareTransition === undefined
          ? {}
          : { prepareTransition: deps.prepareTransition }),
        ...(deps.loadHistory === undefined
          ? {}
          : { loadHistory: deps.loadHistory }),
      });
    },
    async compactAfterModelRound(args) {
      if (args.inputTokens === undefined) {
        if (!reportedMissingUsage) {
          logger.info(
            'provider-native compaction trigger skipped because exact input usage is unavailable',
            {
              providerId: args.providerRequestOptions.providerId,
              model: args.providerRequestOptions.model,
            },
          );
          reportedMissingUsage = true;
        }
        return { kind: 'not_needed', reason: 'usage_unavailable' };
      }

      const modelKey = createContextModelKey(args.providerRequestOptions);
      let policy: ProviderContextCapacityPolicy;
      try {
        policy = await resolvePolicy(args);
      } catch (error: unknown) {
        logger.warn('provider-native compaction policy resolution failed', {
          providerId: args.providerRequestOptions.providerId,
          model: args.providerRequestOptions.model,
          code: normalizeProviderErrorCode(error),
        });
        return {
          kind: 'failed',
          reason: 'policy_resolution_failed',
          message: 'context compaction policy resolution failed',
        };
      }

      const trigger = evaluateContextCompactionTrigger(args.inputTokens, {
        contextWindow: policy.contextWindow,
        reserveTokens: policy.contextWindow - policy.thresholdTokens,
        thresholdTokens: policy.thresholdTokens,
      });
      if (trigger.kind === 'invalid') {
        logger.warn('provider-native compaction trigger is invalid', {
          providerId: policy.providerId,
          model: policy.model,
          reason: trigger.reason,
          ...(trigger.field !== undefined ? { field: trigger.field } : {}),
        });
        return {
          kind: 'failed',
          reason: 'trigger_invalid',
          message: 'context compaction trigger is invalid',
        };
      }
      const requestBytes = args.contextBudgetRound.getRequestBytes();
      exactInputTokensByRound.set(args.contextBudgetRound, args.inputTokens);
      const contextUsage = {
        state: 'measured' as const,
        quality: 'exact' as const,
        modelId: policy.model,
        inputTokens: args.inputTokens,
        contextWindow: policy.contextWindow,
        thresholdTokens: policy.thresholdTokens,
        ...(requestBytes === undefined ? {} : { requestBytes }),
      };
      if (requestBytes !== undefined) {
        calibrationByModel.set(modelKey, {
          requestBytes,
          inputTokens: args.inputTokens,
        });
      }
      args.contextBudgetRound.publish(contextUsage);
      if (!supportsProviderNativeCompaction(policy)) {
        if (!reportedUnsupportedProvider) {
          logger.info(
            'provider-native compaction is unavailable for the selected provider',
            {
              providerId: policy.providerId,
              model: policy.model,
            },
          );
          reportedUnsupportedProvider = true;
        }
        return { kind: 'not_needed', reason: 'provider_not_supported' };
      }
      if (trigger.kind === 'under_threshold') {
        return { kind: 'not_needed', reason: 'under_threshold' };
      }

      return await commitProviderNativeCompaction({
        context: args,
        contextBudgetRound: args.contextBudgetRound,
        contextUsage,
        policy,
        tokensBefore: args.inputTokens,
      });
    },
  };
}
