import type {
  HistoryItem,
  FunctionCall,
  CallResult,
  ProviderUsageTelemetry,
} from '../wire/types.js';

export type AssistantPhase = 'commentary' | 'final_answer';
export type AssistantPhaseIssue = 'missing' | 'invalid';

export interface AssistantDelta {
  itemId: string;
  phase: AssistantPhase;
  text: string;
}

// 스트리밍 function-call 인자 델타 — arguments JSON 텍스트 조각
export interface FunctionCallArgsDelta {
  itemId: string;
  callId: string;
  name: string;
  argsDelta: string;
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
  // function_call 아이템의 스트리밍 델타 상관용
  callId?: string;
  name?: string;
}

export interface CompletedAssistantItem {
  itemId: string;
  phase?: AssistantPhase;
  phaseIssue?: AssistantPhaseIssue;
  invalidPhase?: string;
  text: string;
}

interface CompletedProviderOutputItem {
  completionOrder: number;
  item: Record<string, unknown>;
  outputIndex?: number;
}

interface PendingAssistantHistoryItem {
  kind: 'assistant_pending';
  data: CompletedAssistantItem;
}

type CompletedResponseItem = HistoryItem | PendingAssistantHistoryItem;

export interface ResponsesParseState {
  itemsById: Map<string, ItemBuffer>;
  completedItems: CompletedResponseItem[];
  providerOutputItems: CompletedProviderOutputItem[];
  functionCalls: FunctionCall[];
  providerUsageTelemetry?: ProviderUsageTelemetry;
}
