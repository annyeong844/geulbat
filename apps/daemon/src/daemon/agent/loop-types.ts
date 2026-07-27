import type { AgentLoopImplementation } from '@geulbat/agent-loop/kernel';
import type { ToolLibraryProjectionIdentity } from '@geulbat/tool-library/projection-codec';
import type { ToolCapabilityPolicy } from '@geulbat/tool-library/tool-capability-policy';
import type {
  PermissionMode,
  RunProviderTransitionRecovery,
  RunServiceTier,
  RunSubagentModelRouting,
  ThreadId,
} from './contract.js';
import type { AgentEvent } from './events.js';
import type { AgentLoopObserver } from './observer/agent-loop-observer.js';
import type { AgentLoopHistoryPort } from './loop-history.js';
import type { AgentLoopLifecyclePort } from './loop-lifecycle-port.js';
import type { ModelRoundPort } from './loop-model-round.js';
import type { AgentLoopMemoryPort } from './memory/compaction-loop.js';
import type {
  AgentLoopPromptPort,
  AgentLoopPromptProfile,
} from './loop-prompt.js';
import type { AgentLoopStructuredOutputPort } from './loop-structured-output-port.js';
import type { AgentLoopToolDefinitionPort } from './loop-tool-definitions.js';
import type { AgentLoopToolLibraryProjectionPort } from './loop-tool-library-projection.js';
import type { AgentLoopToolRuntimePort } from './loop-tool-runtime-port.js';
import type { RunState } from './runtime/run-state.js';
import type {
  CallModelInput,
  LLMChunk,
  ProviderReasoningEffort,
  ProviderRequestOptions,
} from '../llm/index.js';
import type { RunContext } from '../run-context.js';
import type { AgentRuntimeServices } from '../daemon-runtime-contract.js';
import type { RunExecutionAgentBindings } from '../sessions/run-execution-lifecycle.js';
import type { ResolvedRunAttachment } from './run-attachments.js';

export interface LineSelection {
  startLine: number;
  endLine: number;
  text: string;
}

export interface ApprovalContext {
  computerSessionId: string;
  permissionMode: PermissionMode;
  ownerRunId?: string;
  ownerThreadId?: ThreadId;
}

export type CallModelFn = (input: CallModelInput) => AsyncGenerator<LLMChunk>;

export interface AgentToolSurface {
  directRegistryNames: readonly string[];
  allowedRegistryNames: readonly string[];
}

export interface AgentInput extends RunExecutionAgentBindings {
  runId: string;
  runContext: RunContext;
  prompt: string;
  // 사용자 업로드 첨부 — 트랜스크립트 persist 때 스토어에 저장되고,
  // 히스토리 재구성 시 모델 입력 블록으로 실린다.
  attachments?: ResolvedRunAttachment[];
  currentFile?: string;
  selection?: LineSelection;
  embeddedBackgroundResultCount?: number;
  providerModel?: Pick<ProviderRequestOptions, 'providerId' | 'model'>;
  providerTransitionRecovery?: RunProviderTransitionRecovery;
  ultraReasoning?: boolean;
  // per-run 사고 수준 — 셸이 protocol RunRequest로 전달 (미지정 시 daemon 기본)
  reasoningEffort?: ProviderReasoningEffort;
  // per-run 처리 등급. 지원 OpenAI 모델에서는 fast가 priority wire tier로
  // 매핑되고, 선택값은 압축과 지원되는 자식 실행에도 이어진다.
  serviceTier?: RunServiceTier;
  subagentModelRouting?: RunSubagentModelRouting;
  signal?: AbortSignal;
  runState?: RunState;
  toolSurface?: AgentToolSurface;
  toolCapabilityPolicy?: ToolCapabilityPolicy;
  toolLibraryProjectionIdentity?: ToolLibraryProjectionIdentity;
  promptProfile?: AgentLoopPromptProfile;
  loopImplementation?: AgentLoopImplementation;
  // Runtime services flow through one narrow path so agent/tool layers do not
  // depend on the full daemon context shape.
  runtimeServices: AgentRuntimeServices;
  approvalContext: ApprovalContext;
  callModelImpl?: CallModelFn;
  promptPort?: AgentLoopPromptPort;
  historyPort?: AgentLoopHistoryPort;
  lifecyclePort?: AgentLoopLifecyclePort;
  memoryPort?: AgentLoopMemoryPort;
  modelRoundPort?: ModelRoundPort;
  structuredOutputPort?: AgentLoopStructuredOutputPort;
  toolDefinitionPort?: AgentLoopToolDefinitionPort;
  toolRuntimePort?: AgentLoopToolRuntimePort;
  toolLibraryProjectionPort?: AgentLoopToolLibraryProjectionPort;
  observer?: AgentLoopObserver;
  onEvent: (event: AgentEvent) => void;
}
