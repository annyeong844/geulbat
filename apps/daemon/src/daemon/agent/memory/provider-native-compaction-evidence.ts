import type {
  ProviderNativeCompactionEvidencePage,
  ProviderNativeCompactionEvidenceRef,
} from '../contract.js';
import type { HistoryItem } from '../../llm/provider/wire/types.js';
import { isRecord, tryParseJsonRecord } from '../../runtime-json.js';

export interface ProviderNativeCompactionExpandedEvidencePage extends ProviderNativeCompactionEvidencePage {
  limit: number;
  content: string;
}

export interface ProviderNativeCompactionEvidenceTarget {
  callId: string;
  toolName: string;
  arguments: string;
}

export type ProviderNativeCompactionEvidenceSelection =
  | { kind: 'selected'; evidence: ProviderNativeCompactionEvidenceRef }
  | {
      kind: 'failed';
      reason:
        | 'target_call_not_found'
        | 'target_call_ambiguous'
        | 'target_call_identity_mismatch'
        | 'target_evidence_not_found'
        | 'target_evidence_ambiguous'
        | 'target_evidence_identity_mismatch';
    };

export type ProviderNativeCompactionEvidenceResolution =
  | { kind: 'none' }
  | {
      kind: 'expanded';
      pages: readonly ProviderNativeCompactionExpandedEvidencePage[];
    }
  | {
      kind: 'failed';
      reason: 'snapshot_unavailable' | 'selection_unavailable';
      outputRef?: string;
    };

export function collectProviderNativeCompactionEvidence(
  historyPrefix: readonly HistoryItem[],
): ProviderNativeCompactionEvidenceRef[] {
  const toolNamesByCallId = new Map<string, string>();
  const seenOutputRefs = new Set<string>();
  const evidence: ProviderNativeCompactionEvidenceRef[] = [];

  for (const item of historyPrefix) {
    const call = readProviderNativeCompactionCallIdentity(item);
    if (
      call !== null &&
      typeof call.toolName === 'string' &&
      call.toolName.trim() !== ''
    ) {
      toolNamesByCallId.set(call.callId, call.toolName);
      continue;
    }
    if (item.kind !== 'function_call_output') {
      continue;
    }
    const parsed = tryParseJsonRecord(item.output);
    if (!parsed.ok) {
      continue;
    }
    const outputEvidence = readProviderNativeCompactionOutputEvidence(
      parsed.value,
    );
    const projectedToolName = parsed.value.tool;
    if (
      outputEvidence === null ||
      seenOutputRefs.has(outputEvidence.outputRef)
    ) {
      continue;
    }
    const toolName =
      typeof projectedToolName === 'string' && projectedToolName.trim() !== ''
        ? projectedToolName
        : toolNamesByCallId.get(item.callId);
    if (toolName === undefined) {
      continue;
    }
    const projectedOutcome = parsed.value.ok;
    const outcome =
      projectedOutcome === true
        ? ('success' as const)
        : projectedOutcome === false
          ? ('failure' as const)
          : ('unknown' as const);
    seenOutputRefs.add(outputEvidence.outputRef);
    evidence.push({
      callId: item.callId,
      toolName,
      outcome,
      fullOutputBytes: outputEvidence.fullOutputBytes,
      outputRef: outputEvidence.outputRef,
    });
  }

  return evidence;
}

function readProviderNativeCompactionOutputEvidence(
  output: Record<string, unknown>,
): { outputRef: string; fullOutputBytes: number } | null {
  if (
    typeof output.outputRef === 'string' &&
    output.outputRef.startsWith('tool-output:') &&
    isNonNegativeSafeInteger(output.fullOutputBytes)
  ) {
    return {
      outputRef: output.outputRef,
      fullOutputBytes: output.fullOutputBytes,
    };
  }
  const commandOutput =
    typeof output.outputRef === 'string' &&
    output.outputRef.startsWith('command-output:')
      ? output
      : isRecord(output.snapshot) &&
          typeof output.snapshot.outputRef === 'string' &&
          output.snapshot.outputRef.startsWith('command-output:')
        ? output.snapshot
        : null;
  const commandOutputRef = commandOutput?.outputRef;
  if (
    commandOutput === null ||
    typeof commandOutputRef !== 'string' ||
    !isNonNegativeSafeInteger(commandOutput.stdoutBytes) ||
    !isNonNegativeSafeInteger(commandOutput.stderrBytes)
  ) {
    return null;
  }
  const fullOutputBytes = commandOutput.stdoutBytes + commandOutput.stderrBytes;
  return Number.isSafeInteger(fullOutputBytes)
    ? {
        outputRef: commandOutputRef,
        fullOutputBytes,
      }
    : null;
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function readProviderNativeCompactionCallIdentity(item: HistoryItem): {
  callId: string;
  toolName: unknown;
  arguments: unknown;
} | null {
  if (item.kind === 'function_call') {
    return {
      callId: item.callId,
      toolName: item.name,
      arguments: item.arguments,
    };
  }
  if (
    item.kind !== 'backend_item' ||
    !isRecord(item.data) ||
    item.data['type'] !== 'function_call' ||
    typeof item.data['call_id'] !== 'string'
  ) {
    return null;
  }
  return {
    callId: item.data['call_id'],
    toolName: item.data['name'],
    arguments: item.data['arguments'],
  };
}

export function selectProviderNativeCompactionEvidenceRef(args: {
  evidence: readonly ProviderNativeCompactionEvidenceRef[];
  historyPrefix: readonly HistoryItem[];
  target: ProviderNativeCompactionEvidenceTarget;
}): ProviderNativeCompactionEvidenceSelection {
  const matchingCalls = args.historyPrefix
    .map(readProviderNativeCompactionCallIdentity)
    .filter((call) => call?.callId === args.target.callId);
  if (matchingCalls.length === 0) {
    return { kind: 'failed', reason: 'target_call_not_found' };
  }
  if (matchingCalls.length !== 1) {
    return { kind: 'failed', reason: 'target_call_ambiguous' };
  }
  const matchingCall = matchingCalls[0];
  if (
    matchingCall?.toolName !== args.target.toolName ||
    matchingCall.arguments !== args.target.arguments
  ) {
    return { kind: 'failed', reason: 'target_call_identity_mismatch' };
  }

  const matchingEvidence = args.evidence.filter(
    (item) => item.callId === args.target.callId,
  );
  if (matchingEvidence.length === 0) {
    return { kind: 'failed', reason: 'target_evidence_not_found' };
  }
  if (matchingEvidence.length !== 1) {
    return { kind: 'failed', reason: 'target_evidence_ambiguous' };
  }
  const selected = matchingEvidence[0];
  if (selected?.toolName !== args.target.toolName) {
    return { kind: 'failed', reason: 'target_evidence_identity_mismatch' };
  }
  return { kind: 'selected', evidence: selected };
}

export function areProviderNativeCompactionEvidencePagesValid(
  pages: readonly ProviderNativeCompactionExpandedEvidencePage[],
  evidence: readonly ProviderNativeCompactionEvidenceRef[],
): boolean {
  const knownOutputRefs = new Set(evidence.map((item) => item.outputRef));
  const seenPages = new Set<string>();
  for (const page of pages) {
    const pageKey = `${page.outputRef}\0${String(page.offset)}\0${String(page.endOffset)}`;
    if (
      !knownOutputRefs.has(page.outputRef) ||
      seenPages.has(pageKey) ||
      !Number.isSafeInteger(page.offset) ||
      page.offset < 0 ||
      !Number.isSafeInteger(page.limit) ||
      page.limit <= 0 ||
      !Number.isSafeInteger(page.endOffset) ||
      page.endOffset < page.offset ||
      page.endOffset > page.offset + page.limit ||
      !Number.isSafeInteger(page.totalChars) ||
      page.totalChars < page.endOffset ||
      page.content.length !== page.endOffset - page.offset
    ) {
      return false;
    }
    seenPages.add(pageKey);
  }
  return true;
}
