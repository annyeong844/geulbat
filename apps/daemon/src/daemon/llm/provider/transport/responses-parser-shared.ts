import type { HistoryItem, FunctionCall, CallResult } from '../wire/types.js';

export type AssistantPhase = 'commentary' | 'final_answer';
export type AssistantPhaseIssue = 'missing' | 'invalid';

export interface AssistantDelta {
  itemId: string;
  phase: AssistantPhase;
  text: string;
}

export interface ResponsesParseResult extends CallResult {}

interface ItemBuffer {
  id: string;
  phase?: AssistantPhase;
  text: string;
  type?: string;
  deltaEmitted?: boolean;
  phaseIssue?: AssistantPhaseIssue;
  invalidPhase?: string;
}

export interface CompletedAssistantItem {
  itemId: string;
  phase?: AssistantPhase;
  phaseIssue?: AssistantPhaseIssue;
  invalidPhase?: string;
  text: string;
}

interface PendingAssistantHistoryItem {
  kind: 'assistant_pending';
  data: CompletedAssistantItem;
}

type CompletedResponseItem = HistoryItem | PendingAssistantHistoryItem;

export interface ResponsesParseState {
  itemsById: Map<string, ItemBuffer>;
  completedItems: CompletedResponseItem[];
  functionCalls: FunctionCall[];
}
